import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { relativeTime } from './relativeTime';
import SeriesScoreTable from './SeriesScoreTable';
import {
  seriesGameIsOpen,
  seriesStatusTone,
  seriesView,
  type SeriesGameView,
} from './seriesSummary';
import { useWideScreen } from '@/hooks/useBoardLayout';
import { useBotSeries } from '@/hooks/useBotSeries';
import { useOpenGame } from '@/hooks/useOpenGame';
import { gameReviewURL, links, seriesURL } from '@/navigation/links';
import { useSettledSearchParams } from '@/navigation/useSettledSearchParams';
import { useGameStore } from '@/store/gameStore';
import type { BotSeries } from '@/store/api/bots';
import { colors, contentWidth, radius, space, type } from '@/theme';
import CopyLinkButton from '@/ui/CopyLinkButton';
import ListRow from '@/ui/ListRow';
import PageHeading from '@/ui/PageHeading';
import ScreenShell from '@/ui/ScreenShell';
import { Badge, EmptyState, GhostButton, GhostLink, Panel, SectionHeading } from '@/ui/primitives';

// One run, at an address of its own.
//
// The score table has been drawable for a while — in the history feed, and over
// a board being reviewed or watched — but a run had nowhere to *be*. That is the
// gap this fills, and the reason it is a page rather than a bigger card: a link
// to a card is a link to whatever page the card is currently sitting on, which
// is the Bots page, which lists the last two dozen runs and will not list this
// one for long. A run people talk about needs to survive the feed scrolling
// past it.
//
// What the page adds to the card is what a card has no room for: every game
// listed with its own address, which side each engine held that game, and the
// four numbers somebody needs to run the thing again — mode, clock, opening
// plies and seed. Everything else it draws is the same `SeriesScoreTable` the
// feed draws, deliberately, because a run should not look like two different
// runs depending on where you met it.

/** How long the page can go without being wrong about a run still being played. */
const REFRESH_MS = 20_000;

export default function SeriesScreen() {
  const wide = useWideScreen();
  // `?series=` is the whole of this page's input. Read through the settled gate
  // because a pre-rendered page is built with no query string at all: reading it
  // on the first client render would disagree with the HTML that shipped, and
  // React answers a disagreement by throwing the page away.
  const { params, settled } = useSettledSearchParams<{ series?: string }>();
  const seriesId = params.series ?? null;

  // A run still being played finishes a game every few minutes, so the page goes
  // stale on its own while somebody is reading it. The tick is what the fetch
  // hook watches; it only runs while there is something to wait for.
  const [tick, setTick] = useState(0);
  const { series, status } = useBotSeries(seriesId, tick);
  const running = String(series?.status ?? '').toLowerCase() === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setTick((count) => count + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [running]);

  const liveGames = useGameStore((state) => state.liveGames);
  const liveGameIds = useMemo(() => liveGames.map((live) => live.gameId), [liveGames]);
  // Watched or read back, by the rule every list of games shares.
  const openGame = useOpenGame();

  if (!settled || (seriesId && status === 'loading' && !series)) {
    return (
      <SeriesShell>
        <Panel>
          <Text style={styles.help}>Loading the series…</Text>
        </Panel>
      </SeriesShell>
    );
  }

  if (!series) {
    return (
      <SeriesShell>
        {/*
          The trail as well as the message. This is a page somebody *lands* on
          from a link that no longer works, and a bare panel in the middle of the
          shell gives them nothing to say where they are.
        */}
        <PageHeading
          back={{ label: 'Bots', href: links.bots() }}
          eyebrow="BOT SERIES"
          title="That run is not here"
        />
        <Panel>
          <EmptyState
            detail={
              seriesId
                ? 'This run is not on the server. The link may be mistyped, or the run may have been removed.'
                : 'A series link carries the run it leads to. This one arrived without one.'
            }
            title="No such series"
          />
          <View style={styles.emptyAction}>
            <GhostLink href={links.bots()} label="EVERY RECENT RUN ›" />
          </View>
        </Panel>
      </SeriesShell>
    );
  }

  const view = seriesView(series);
  const at = series.completedAtUnixMs ?? series.createdAtUnixMs;
  const liveGame = view.games.find(
    (entry) => entry.gameId && liveGameIds.includes(entry.gameId),
  );

  return (
    <SeriesShell>
      <PageHeading
        back={{ label: 'Bots', href: links.bots() }}
        detail={`${series.modeId} · ${view.played} game${view.played === 1 ? '' : 's'} played · ${relativeTime(at)}`}
        eyebrow="BOT SERIES"
        title={`${view.firstName} v ${view.secondName}`}
        trailing={
          <Badge
            label={String(series.status).toUpperCase()}
            tone={seriesStatusTone(series)}
          />
        }
      />

      <Panel>
        <SectionHeading
          eyebrow={running ? 'IN PROGRESS' : 'FINAL SCORE'}
          title={
            view.planned
              ? `Game ${Math.min(view.played + 1, view.planned)} of ${view.planned}`
              : `${view.firstTotal} – ${view.secondTotal}`
          }
          trailing={
            <CopyLinkButton
              accessibilityLabel="Copy a link to this series"
              label="COPY SERIES LINK"
              url={seriesURL(series.seriesId)}
            />
          }
        />
        <View style={styles.table}>
          <SeriesScoreTable
            liveGameIds={liveGameIds}
            onSelect={openGame}
            series={series}
          />
        </View>
        {liveGame ? (
          <Text style={styles.live}>
            Game {liveGame.number} is being played right now — press its column to watch it.
          </Text>
        ) : null}
        <Provenance series={series} />
      </Panel>

      <Panel>
        <SectionHeading
          eyebrow="GAMES"
          title={view.games.length === 1 ? 'The game' : `All ${view.games.length} games`}
        />
        <Text style={styles.help}>
          Every game of a run is an ordinary archived game. Open one to have RPSFish grade it,
          or copy its link to hand that review to somebody else.
        </Text>
        {view.games.length === 0 ? (
          <EmptyState
            detail="The first game starts as soon as both engines are seated."
            title="Nothing played yet"
          />
        ) : (
          <View style={styles.games}>
            {view.games.map((entry, index) => (
              <GameRow
                divided={index > 0}
                entry={entry}
                key={entry.number}
                live={Boolean(entry.gameId) && liveGameIds.includes(entry.gameId as string)}
                onOpen={openGame}
                wide={wide}
              />
            ))}
          </View>
        )}
      </Panel>
    </SeriesShell>
  );
}

/** The page frame, so the three states above cannot drift apart in width. */
function SeriesShell({ children }: { children: ReactNode }) {
  return <ScreenShell width={contentWidth.standard}>{children}</ScreenShell>;
}

/**
 * The four numbers that shaped the run, plus who asked for it.
 *
 * On the page rather than only in the card because this is what makes a result
 * checkable: the seed and the opening plies are exactly what somebody needs to
 * type into the form on the Bots page to play the same run again, and a score
 * nobody can reproduce is an anecdote.
 */
function Provenance({ series }: { series: BotSeries }) {
  // Written out rather than rounded to minutes: a run can be played at 0.1+1,
  // and "2 min" for a 90-second clock — or "0 min" for a six-second one — would
  // misreport the one number that decides what a run's result is worth.
  const seconds = Math.round(series.initialTimeMs / 1000);
  const clock =
    seconds < 60
      ? `${seconds} sec`
      : `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
  const facts: { label: string; value: string }[] = [
    { label: 'MODE', value: series.modeId },
    { label: 'CLOCK', value: `${clock} + ${Math.round(series.incrementMs / 1000)}s` },
    { label: 'PAIRS', value: String(series.pairs) },
    { label: 'OPENING PLIES', value: String(series.openingPlies) },
    { label: 'SEED', value: series.seed },
  ];
  if (series.requestedByName) {
    facts.push({ label: 'STARTED BY', value: series.requestedByName });
  }
  return (
    <View style={styles.facts}>
      {facts.map((fact) => (
        <View key={fact.label} style={styles.fact}>
          <Text style={styles.factLabel}>{fact.label}</Text>
          <Text numberOfLines={1} style={styles.factValue}>
            {fact.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

interface GameRowProps {
  entry: SeriesGameView;
  divided: boolean;
  live: boolean;
  onOpen: (gameId: string) => void;
  wide: boolean;
}

/**
 * One game of the run: how it went, which way round it was played, and its two
 * ways in.
 *
 * The seats are spelled out rather than left to the reader, because the swap is
 * the reason the run means anything — each opening is played twice with the
 * colours exchanged — and "Alpha won game 3" is a different claim depending on
 * which side Alpha had.
 */
function GameRow({ divided, entry, live, onOpen, wide }: GameRowProps) {
  const open = seriesGameIsOpen(entry, live);
  const gameId = entry.gameId;

  const actions =
    open && gameId ? (
      <View style={[styles.actions, !wide && styles.actionsStacked]}>
        {live ? (
          <GhostButton
            accessibilityLabel={`Watch game ${entry.number}`}
            compact
            label="WATCH ▸"
            onPress={() => onOpen(gameId)}
          />
        ) : (
          <>
            <CopyLinkButton
              accessibilityLabel={`Copy a link to game ${entry.number}`}
              url={gameReviewURL(gameId)}
            />
            <GhostLink
              accessibilityLabel={`Review game ${entry.number}`}
              compact
              href={links.review(gameId)}
              label="REVIEW"
            />
          </>
        )}
      </View>
    ) : null;

  const opening = entry.game.openingLine ? (
    <Text style={styles.opening}>Opened {entry.game.openingLine}</Text>
  ) : null;

  return (
    <ListRow
      detail={
        opening || (!wide && actions) ? (
          <View style={styles.rowDetail}>
            {opening}
            {wide ? null : actions}
          </View>
        ) : undefined
      }
      divided={divided}
      leading={
        <View style={[styles.number, live && styles.numberLive]}>
          <Text style={[styles.numberText, live && styles.numberTextLive]}>{entry.number}</Text>
        </View>
      }
      meta={`Pair ${entry.game.pairNumber} · Red ${entry.redName} · Blue ${entry.blueName}`}
      style={wide ? undefined : styles.rowStacked}
      title={entry.label}
      trailing={wide ? actions : undefined}
    />
  );
}

const styles = StyleSheet.create({
  help: { ...type.body, color: colors.textMuted, marginTop: space.small },
  // Sized to its label rather than stretched across the panel: a column lays its
  // children out at full width, and a ghost button that wide reads as the page's
  // primary action, which a way back from a dead link is not.
  emptyAction: { alignSelf: 'flex-start', marginTop: space.medium },
  table: { marginTop: space.medium },
  live: { ...type.meta, color: colors.liveSoft, marginTop: space.small },

  facts: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.small,
    marginTop: space.medium,
    paddingTop: space.medium,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  fact: {
    gap: space.hair,
    minWidth: 84,
    paddingHorizontal: space.small,
    paddingVertical: space.snug,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.small,
    backgroundColor: colors.surfaceWell,
  },
  factLabel: { ...type.eyebrow, color: colors.textFaint },
  factValue: { ...type.rowTitle, color: colors.text },

  games: { marginTop: space.small },
  rowStacked: { alignItems: 'flex-start', paddingTop: space.snug },
  rowDetail: { gap: space.tight },
  opening: { ...type.meta, color: colors.textFaint, marginTop: space.hair },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  actionsStacked: { marginTop: space.snug, marginBottom: space.tight, flexWrap: 'wrap' },

  number: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.small,
    borderWidth: 1,
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.borderSoft,
  },
  numberLive: { backgroundColor: colors.liveSurface, borderColor: colors.liveBorder },
  numberText: { ...type.label, color: colors.textFaint },
  numberTextLive: { color: colors.live },
});
