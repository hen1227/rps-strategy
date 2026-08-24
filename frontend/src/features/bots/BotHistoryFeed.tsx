import { useRouter } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import BotSeriesCard from './BotSeriesCard';
import { relativeTime } from './relativeTime';
import { failureMessage } from '@/errors';
import { namedResultLabel } from '@/features/game/resultLabels';
import { links } from '@/navigation/links';
import { botMatches, listBotSeries, type BotMatch, type BotSeries } from '@/store/api/bots';
import { listTournaments } from '@/store/api/tournaments';
import { colors, space, type } from '@/theme';
import ListRow from '@/ui/ListRow';
import { Badge, Banner, EmptyState, GhostButton, Panel, SectionHeading } from '@/ui/primitives';
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

/** How long the feed can go without being wrong about a running series. */
const REFRESH_MS = 20_000;

type FeedEntry =
  | { kind: 'series'; at: number; key: string; series: BotSeries }
  | { kind: 'tournament'; at: number; key: string; tournament: Tournament; games: number }
  | { kind: 'game'; at: number; key: string; match: BotMatch };

/** The name of whoever won, or null on a draw. */
const winnerName = (match: BotMatch) => {
  if (match.winnerUserId === match.redPlayer.userId) return match.redPlayer.username;
  if (match.winnerUserId === match.bluePlayer.userId) return match.bluePlayer.username;
  return null;
};

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
  emptyDetail = 'Pit two engines against each other and their games show up here.',
  eyebrow = 'MATCH HISTORY',
  modeId = null,
  refreshKey = 0,
  seriesAction,
  title = 'What the bots have been playing',
}: BotHistoryFeedProps) {
  const router = useRouter();
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
        games: played.length,
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
                  onSelectGame={(gameId) => router.push(links.review(gameId))}
                  series={entry.series}
                  when={relativeTime(entry.at)}
                />
              );
            }
            if (entry.kind === 'tournament') {
              return (
                <TournamentEntry
                  games={entry.games}
                  key={entry.key}
                  onOpen={() =>
                    router.push(links.tournaments(entry.tournament.tournamentId))
                  }
                  tournament={entry.tournament}
                  when={relativeTime(entry.at)}
                />
              );
            }
            return (
              <View key={entry.key} style={styles.looseRow}>
                <ListRow
                  divided={false}
                  meta={`${entry.match.modeName} · ${entry.match.moveNumber} moves · ${relativeTime(
                    entry.at,
                  )}`}
                  title={namedResultLabel({
                    blueName: entry.match.bluePlayer.username,
                    endReason: entry.match.endReason,
                    redName: entry.match.redPlayer.username,
                    winnerName: winnerName(entry.match),
                  })}
                  trailing={
                    <GhostButton
                      accessibilityLabel={`Review ${entry.match.redPlayer.username} versus ${entry.match.bluePlayer.username}`}
                      compact
                      label="REVIEW"
                      onPress={() => router.push(links.review(entry.match.gameId))}
                    />
                  }
                />
              </View>
            );
          })}
        </View>
      )}
    </Panel>
  );
}

interface TournamentEntryProps {
  tournament: Tournament;
  games: number;
  when: string;
  onOpen: () => void;
}

// An event, summarised rather than listed.
//
// A round robin between eight engines is twenty-eight games, and drawing those
// here would push every other occasion off the page. What belongs here is what
// the event *was* — who is leading it, how far along it is — with the games
// themselves a click away on the page that already draws them properly.
function TournamentEntry({ games, onOpen, tournament, when }: TournamentEntryProps) {
  const status = String(tournament.status).toLowerCase();
  const leader = tournament.standings?.[0];
  const played = tournament.matches?.filter((match) => match.result !== 'pending').length ?? 0;
  const total = tournament.matches?.length ?? 0;

  return (
    <View style={styles.tournamentCard}>
      <View style={styles.tournamentHeader}>
        <Text numberOfLines={1} style={styles.tournamentName}>
          {tournament.name}
        </Text>
        <Badge
          label={status === 'completed' ? 'COMPLETED' : status.toUpperCase()}
          tone={status === 'in_progress' ? 'live' : status === 'completed' ? 'accent' : 'neutral'}
        />
      </View>
      <Text style={styles.tournamentMeta}>
        {tournament.modeName} · {tournament.players?.length ?? 0} entrants ·{' '}
        {total > 0 ? `${played} of ${total} matches` : `${games} bot games`} · {when}
      </Text>
      {leader ? (
        <Text style={styles.tournamentLeader}>
          {status === 'completed' ? 'Won by' : 'Leading'} {leader.ign} · {leader.points} pts
          {' · '}
          {leader.wins}W {leader.losses}L {leader.draws}D
        </Text>
      ) : null}
      <View style={styles.tournamentActions}>
        <GhostButton
          accessibilityLabel={`Open ${tournament.name}`}
          compact
          label="EVENT DETAILS ›"
          onPress={onOpen}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  help: { ...type.body, color: colors.textFaint, marginTop: space.small },
  feed: { gap: space.small, marginTop: space.medium },

  looseRow: {
    paddingHorizontal: space.medium,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: 10,
    backgroundColor: colors.surfaceWell,
  },

  tournamentCard: {
    gap: space.snug,
    padding: space.medium,
    borderWidth: 1,
    borderColor: colors.goldBorder,
    borderRadius: 10,
    backgroundColor: colors.goldSurfaceDeep,
  },
  tournamentHeader: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  tournamentName: { ...type.cardTitle, color: colors.goldSoft, flexShrink: 1, minWidth: 0 },
  tournamentMeta: { ...type.meta, color: colors.goldMuted },
  tournamentLeader: { ...type.body, color: colors.textSoft },
  tournamentActions: { flexDirection: 'row', marginTop: space.hair },
});
