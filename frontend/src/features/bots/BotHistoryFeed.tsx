import { useRouter } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import BotSeriesCard from './BotSeriesCard';
import OccasionTag from './OccasionTag';
import { relativeTime } from './relativeTime';
import { singleGameOccasion, tournamentOccasion } from './seriesSummary';
import { failureMessage } from '@/errors';
import ResultLine from '@/features/game/ResultLine';
import { useOpenGame } from '@/hooks/useOpenGame';
import { links } from '@/navigation/links';
import { botMatches, listBotSeries, type BotMatch, type BotSeries } from '@/store/api/bots';
import { listTournaments } from '@/store/api/tournaments';
import { useGameStore } from '@/store/gameStore';
import {
  isWeekendArena,
  joinNames,
  leadersOf,
  tableHasResults,
} from '@/store/tournamentSelectors';
import { colors, radius, space, themedSheet, type } from '@/theme';
import {
  Badge,
  Banner,
  EmptyState,
  GhostButton,
  GhostLink,
  Panel,
  SectionHeading,
} from '@/ui/primitives';
import type { ModeID } from '@/types/game';
import type { Tournament } from '@/types/protocol';

// What the bots have been doing, newest first.
//
// This replaced two lists that could not see each other. The Bots page listed
// runs with a score on them and no games; the Leaderboard listed games with no
// idea which run they came from, so a six-game series arrived as six unrelated
// rows saying much the same thing. Neither page could answer the question people
// actually have, which is "what happened between these two engines".
//
// So the unit here is the *occasion* rather than the game. A run is one card
// with its games in it. A tournament is one card for the whole event, linking to
// its own page, because a round robin between eight engines is twenty-eight
// games and listing them here would bury everything else. A bot game that
// belongs to neither — a bare challenge — is still one row, in its place in the
// order, because dropping it would make the feed a lie about what has been
// played.
//
// One component for both pages, for the reason the list it replaced gave: the
// difference between the two is a filter, and a second copy would be a second
// place for "what counts as bot history" to be decided.
//
// Every occasion in it links to its own page — a run's, an event's, a lone
// game's review — which is where its address is copied from. One quiet link a
// card: a feed is a column of these, and a green button on every one is a
// column of primary actions. None of those addresses are built here — they
// come from `links.ts`, which is the only thing that knows what a page is called.

/** How long the feed can go without being wrong about a running series. */
const REFRESH_MS = 20_000;

type FeedEntry =
  | { kind: 'series'; at: number; key: string; series: BotSeries }
  | {
      kind: 'tournament';
      at: number;
      key: string;
      tournament: Tournament;
      /** Any of its games counted. See `tournamentOccasion`. */
      ranked: boolean;
    }
  | { kind: 'game'; at: number; key: string; match: BotMatch };

/**
 * When an occasion happened, for ordering.
 *
 * A run's own clock rather than its last game's: a run that is still going
 * belongs at the top of the feed while it is going, and one that was aborted
 * before it played anything still happened at the moment somebody started it.
 */
const seriesAt = (series: BotSeries) => series.completedAtUnixMs ?? series.createdAtUnixMs;

export interface BotHistoryFeedProps {
  /**
   * Bot *account* ids to keep to, matching a ladder's own rows. Either side
   * counts, so a leading engine's game against one outside the board is still
   * one of its games. Omitted shows everything.
   */
  botUserIds?: string[];
  /** One mode's history, so a per-mode ladder is not followed by other modes. */
  modeId?: ModeID | null;
  /** How many occasions to draw before the SHOW MORE button. */
  collapsedRows?: number;
  eyebrow?: string;
  title?: string;
  emptyDetail?: string;
  /** Drawn between the heading and the feed — the Bots page puts its form here. */
  children?: ReactNode;
  /** A per-run control, which is how the Bots page offers STOP on its own runs. */
  seriesAction?: (series: BotSeries) => ReactNode;
  /** Bumped by a caller that has just changed something, to refetch now. */
  refreshKey?: number;
}

export default function BotHistoryFeed({
  botUserIds,
  children,
  collapsedRows = 6,
  emptyDetail = "Games from your bot series appear here.",
  eyebrow = 'MATCH HISTORY',
  modeId = null,
  refreshKey = 0,
  seriesAction,
  title = 'What the bots have been playing',
}: BotHistoryFeedProps) {
  const router = useRouter();
  // A run in this feed can be one somebody is playing right now, so its live
  // column has to open the board rather than a record the archive does not have
  // yet. The lobby's list is what tells them apart.
  const openGame = useOpenGame();
  const liveGames = useGameStore((state) => state.liveGames);
  const liveGameIds = useMemo(() => liveGames.map((live) => live.gameId), [liveGames]);
  const [series, setSeries] = useState<BotSeries[]>([]);
  const [matches, setMatches] = useState<BotMatch[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Joined rather than depended on as an array, so a parent that rebuilds an
  // equal list every render does not refetch every render with it.
  const scope = (botUserIds ?? []).join(',');

  const load = useCallback(async () => {
    try {
      // Together, and one banner if either fails: these are two views of one
      // question on one server, so a failure is the history being down rather
      // than half of it being unavailable.
      const [runs, games] = await Promise.all([
        listBotSeries(24),
        botMatches({ botUserIds: scope ? scope.split(',') : [], limit: 60, modeId }),
      ]);
      setSeries(runs ?? []);
      setMatches(games ?? []);

      // Tournaments only when a game says it belongs to one, which today is
      // never: every ranked bot game is part of a run. A third request every
      // twenty seconds to draw nothing is a request not worth making, and this
      // is the one question whose answer says whether to ask it.
      //
      // Read from REST rather than the socket store because this panel is drawn
      // on pages that do not otherwise care about tournaments at all.
      const entered = (games ?? []).some((match) => match.tournamentId);
      setTournaments(entered ? ((await listTournaments().catch(() => [])) ?? []) : []);
      setError(null);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setLoaded(true);
    }
  }, [modeId, scope]);

  useEffect(() => {
    load();
    // A running series finishes a game every few minutes, so this goes stale on
    // its own even when nobody touches the page.
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, refreshKey]);

  const entries = useMemo(() => {
    const wanted = new Set(scope ? scope.split(',') : []);
    const inScope = (...userIds: (string | undefined)[]) =>
      wanted.size === 0 || userIds.some((userId) => userId && wanted.has(userId));

    const feed: FeedEntry[] = [];
    for (const run of series) {
      if (modeId && run.modeId !== modeId) continue;
      if (!inScope(run.firstBotUserId, run.secondBotUserId)) continue;
      feed.push({ kind: 'series', at: seriesAt(run), key: `s:${run.seriesId}`, series: run });
    }

    // Tournaments are entered through their *games*, not through the tournament
    // list, so an event with no bot games in it never appears here — which is
    // the point. A human event is not bot history.
    const byTournament = new Map<string, BotMatch[]>();
    const loose: BotMatch[] = [];
    for (const match of matches) {
      if (match.seriesId) continue;
      if (!match.tournamentId) {
        loose.push(match);
        continue;
      }
      const played = byTournament.get(match.tournamentId) ?? [];
      played.push(match);
      byTournament.set(match.tournamentId, played);
    }
    for (const [tournamentId, played] of byTournament) {
      const tournament = tournaments.find((entry) => entry.tournamentId === tournamentId);
      if (!tournament) continue;
      feed.push({
        kind: 'tournament',
        // The event sits at its most recent game rather than at its own
        // completion time, so a round robin still being played rises as it is
        // played instead of sitting wherever it was created.
        at: Math.max(...played.map((match) => match.finishedAtUnixMs)),
        key: `t:${tournamentId}`,
        tournament,
        // Per game rather than per event: an event's games are rated unless
        // an entrant is barred from ranked play, and then only theirs are not.
        ranked: played.some((match) => match.ranked),
      });
    }
    for (const match of loose) {
      feed.push({ kind: 'game', at: match.finishedAtUnixMs, key: `g:${match.gameId}`, match });
    }
    return feed.sort((left, right) => right.at - left.at);
  }, [matches, modeId, scope, series, tournaments]);

  const shown = expanded ? entries : entries.slice(0, collapsedRows);

  return (
    <Panel>
      <SectionHeading
        eyebrow={eyebrow}
        title={title}
        trailing={
          entries.length > collapsedRows ? (
            <GhostButton
              compact
              label={expanded ? `TOP ${collapsedRows}` : `SHOW ALL ${entries.length}`}
              onPress={() => setExpanded(!expanded)}
            />
          ) : undefined
        }
      />
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
      {children}

      {entries.length === 0 ? (
        loaded ? (
          <EmptyState detail={emptyDetail} title="Nothing played yet" />
        ) : (
          <Text style={styles.help}>Loading…</Text>
        )
      ) : (
        <View style={styles.feed}>
          {shown.map((entry) => {
            if (entry.kind === 'series') {
              return (
                <BotSeriesCard
                  action={seriesAction?.(entry.series)}
                  key={entry.key}
                  liveGameIds={liveGameIds}
                  onSelectGame={openGame}
                  series={entry.series}
                  when={relativeTime(entry.at)}
                />
              );
            }
            if (entry.kind === 'tournament') {
              return (
                <TournamentEntry
                  key={entry.key}
                  onOpen={() =>
                    router.push(links.tournaments(entry.tournament.tournamentId))
                  }
                  ranked={entry.ranked}
                  tournament={entry.tournament}
                  when={relativeTime(entry.at)}
                />
              );
            }
            return <GameEntry key={entry.key} match={entry.match} when={relativeTime(entry.at)} />;
          })}
        </View>
      )}
    </Panel>
  );
}

interface GameEntryProps {
  match: BotMatch;
  when: string;
}

// A bot game that belonged to no run and no event: one card, in its place in
// the order, with the review it can be read back in.
function GameEntry({ match, when }: GameEntryProps) {
  const between = `${match.redPlayer.username} versus ${match.bluePlayer.username}`;
  return (
    <View style={styles.entryCard}>
      <View style={styles.entryHeader}>
        <OccasionTag occasion={singleGameOccasion(match.ranked)} />
        <Text style={styles.entryWhen}>{when}</Text>
      </View>
      <ResultLine record={match} />
      <Text style={styles.entryMeta}>{match.modeName}</Text>
      <View style={styles.entryLinks}>
        <GhostLink
          accessibilityLabel={`Review ${between}`}
          compact
          href={links.review(match.gameId)}
          label="REVIEW ›"
        />
      </View>
    </View>
  );
}

interface TournamentEntryProps {
  tournament: Tournament;
  ranked: boolean;
  when: string;
  onOpen: () => void;
}

/** An event's state in the feed's own words, so it reads beside a run's. */
const eventStatus = (status: string): { label: string; tone: 'live' | 'neutral' | 'danger' } => {
  switch (status) {
    case 'in_progress':
      return { label: 'LIVE', tone: 'live' };
    case 'completed':
      return { label: 'FINISHED', tone: 'neutral' };
    case 'cancelled':
      return { label: 'CANCELLED', tone: 'danger' };
    default:
      return { label: 'OPEN', tone: 'neutral' };
  }
};

// An event, summarised rather than listed.
//
// A round robin between eight engines is twenty-eight games, and drawing those
// here would push every other occasion off the page. What belongs here is what
// the event *was* — which kind, who is leading it, how far along it is — with
// the games themselves a click away on the page that already draws them.
function TournamentEntry({ onOpen, ranked, tournament, when }: TournamentEntryProps) {
  const status = eventStatus(String(tournament.status).toLowerCase());
  // Everybody level at the top, and nobody before a result: at the start the
  // whole field is level on nothing, which is not a lead.
  const leaders = tableHasResults(tournament) ? leadersOf(tournament) : [];
  const leader = leaders[0];
  const finished = status.label === 'FINISHED';

  return (
    <View style={[styles.entryCard, styles.tournamentCard]}>
      <View style={styles.entryHeader}>
        <OccasionTag occasion={tournamentOccasion(isWeekendArena(tournament), ranked)} />
        <View style={styles.entryStatus}>
          <Badge label={status.label} tone={status.tone} />
          <Text style={styles.entryWhen}>{when}</Text>
        </View>
      </View>
      <Text numberOfLines={1} style={styles.tournamentName}>
        {tournament.name}
      </Text>
      <Text style={styles.entryMeta}>
        {tournament.modeName} · {tournament.players?.length ?? 0} entrants
      </Text>
      {leader ? (
        <Text style={styles.tournamentLeader}>
          {finished ? 'Won by' : 'Leading'} {joinNames(leaders.map((row) => row.ign))}
          {/* A knockout's survivors share first on rounds rather than points,
              so a shared lead only quotes a score when it is the same one. */}
          {leaders.length === 1 || leaders.every((row) => row.points === leader.points)
            ? ` · ${leader.points} pts`
            : ''}
        </Text>
      ) : null}
      <View style={styles.entryLinks}>
        <GhostButton
          accessibilityLabel={`Open ${tournament.name}`}
          compact
          label="VIEW EVENT ›"
          onPress={onOpen}
        />
      </View>
    </View>
  );
}

const styles = themedSheet(() => ({
  help: { ...type.body, color: colors.textFaint, marginTop: space.small },
  feed: { gap: space.small, marginTop: space.medium },

  // The run card's shape, so an event and a lone game sit in the feed as the
  // same kind of thing as the runs around them.
  entryCard: {
    gap: space.small,
    padding: space.medium,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceWell,
  },
  entryHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: space.medium,
    rowGap: space.snug,
  },
  entryStatus: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  entryWhen: { ...type.meta, color: colors.textFaint },
  entryMeta: { ...type.meta, color: colors.textFaint },
  entryLinks: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: space.snug,
  },

  // An event is a prize, and gold is the colour this app keeps for one.
  tournamentCard: { borderColor: colors.goldBorder, backgroundColor: colors.goldSurfaceDeep },
  tournamentName: { ...type.cardTitle, color: colors.goldSoft, minWidth: 0 },
  tournamentLeader: { ...type.body, color: colors.textSoft },
}));
