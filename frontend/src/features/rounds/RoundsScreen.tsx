import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import YourEnginesPanel from './YourEnginesPanel';
import {
  awayNote,
  fieldStatus,
  fieldSummary,
  ladderFieldGroups,
  lastRoundSummary,
  scheduleRows,
  shortFieldNote,
  waitingNote,
} from './roundsView';
import { failureMessage } from '@/errors';
import BotIcon from '@/features/bots/BotIcon';
import BotSeriesCard from '@/features/bots/BotSeriesCard';
import { relativeTime } from '@/features/bots/relativeTime';
import { ladderConditionsLine, ladderRoundView } from '@/features/live/ladderRound';
import { BOT_RELATIVE_SCALE_EXPLAINER, ratingLabel } from '@/features/ratings/scale';
import { useNow } from '@/hooks/useNow';
import { useOpenGame } from '@/hooks/useOpenGame';
import { links } from '@/navigation/links';
import { botIconUrl } from '@/store/api/bots';
import {
  fetchLadderRounds,
  type LadderFieldEngine,
  type LadderRounds,
} from '@/store/api/ladderPool';
import { useGameStore } from '@/store/gameStore';
import type { ModeDefinition, ModeID } from '@/types/game';
import { timeControlLabel } from '@/store/setupSelectors';
import { colors, contentWidth, radius, space, themedSheet, type } from '@/theme';
import ListRow from '@/ui/ListRow';
import PageHeading from '@/ui/PageHeading';
import PlayerLink from '@/ui/PlayerLink';
import ScreenShell from '@/ui/ScreenShell';
import { Badge, Banner, EmptyState, GhostLink, Panel, SectionHeading } from '@/ui/primitives';

// The hourly rounds.
//
// The pool has always been the only thing that moves an engine's rating, and it
// has always run entirely out of sight. What existed was a countdown in the
// live rail with a lineup under it, and the lineup could not answer the one
// question its readers had: an engine that was entered but not running was
// simply missing from it, which looks identical to one that was never entered —
// and the count above it said "7 engines entered" meaning something different
// from the switch in the owner's own settings. Somebody with a bot could tick
// that switch, leave the client running, and have no way at all to find out
// whether the round would use it.
//
// So this page is the four answers, in the order they are asked:
//
//   1. **When is the next one, and what is it.** The countdown that used to be
//      the whole feature, with the conditions beside it.
//   2. **Who is in it, and why is anybody not.** Every entered engine, running
//      or not, with the server's own reason against each — from the same
//      function the pairer decides with, so the list cannot flatter itself.
//   3. **Can I be in it.** Your engines, with one press each.
//   4. **What happened last time.** The runs the last round seated, as the
//      score tables they are. A rating that moves on the hour with nothing to
//      point at is a rating nobody trusts.
//
// Read through one endpoint rather than assembled: the countdown, the field and
// the scoreboard are three views of one hour, and a page that fetched them
// separately would show them disagreeing across the top of it.

/**
 * How often the page re-reads the server.
 *
 * Fifteen seconds, which is the rate the *field* moves at — an engine connects,
 * finishes a game, starts draining — rather than the rate the schedule moves
 * at, which is never. The countdown itself is local and ticks every second, so
 * this is not what makes the clock run.
 */
const REFRESH_MS = 15_000;

/** A second, because a countdown is the first thing on the page. */
const TICK_MS = 1_000;

export default function RoundsScreen() {
  const modes = useGameStore((state) => state.modes);
  const openGame = useOpenGame();
  const liveGames = useGameStore((state) => state.liveGames);
  const now = useNow(TICK_MS);

  const [view, setView] = useState<LadderRounds | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setView(await fetchLadderRounds());
      setError(null);
    } catch (caught) {
      // The view is left as it was rather than cleared. A refresh that failed is
      // a request that did not arrive, not news that the round was cancelled,
      // and blanking a running countdown over one dropped fetch is the visible
      // bug — see `useLadderPool`, which makes the same choice.
      setError(
        failureMessage(caught, 'The hourly rounds could not be loaded.'),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Null until the browser has a clock, which is `useNow`'s contract: this page
  // is pre-rendered in Node, and a countdown computed during that render would
  // bake a stale minute into the static HTML. So the head of the page arrives a
  // render later rather than wrong.
  const round = now === null ? null : ladderRoundView(view, modes, now);
  const groups = ladderFieldGroups(view?.field ?? []);
  const shortField = view
    ? shortFieldNote({ inRound: groups.inRound, minimumField: view.minimumField })
    : null;
  const rotation =
    now === null ? [] : scheduleRows(view?.schedule ?? [], modes, now);
  const lastSeries = view?.last?.series ?? [];
  const liveGameIds = liveGames.map((live) => live.gameId);

  return (
    <ScreenShell width={contentWidth.standard}>
      <PageHeading
        // Deliberately does not name the mode, even though there is only one of
        // it now. The rotation is a list in the server and the schedule below
        // is what publishes it, so a sentence up here saying "Intransitive"
        // would be a second copy of that list — the kind that goes on being
        // read for months after the list changed. The panel under this one
        // names the round, and every row of Coming up names its own.
        detail="Two ranked games per pair, on the hour, with colours swapped. The server picks opponents and settings."
        eyebrow="RANKED LADDER"
        title="Hourly rounds"
        trailing={
          view && view.roundsRun > 0 ? (
            <Badge label={`${view.roundsRun} ROUNDS RUN`} tone="neutral" />
          ) : undefined
        }
      />

      {error ? (
        <Banner message={error} onDismiss={() => setError(null)} tone="error" />
      ) : null}
      {/*
        The heading above is outside this gate on purpose. It is the only part of
        the page the build can know — everything else is a fetch — so putting it
        above means the pre-rendered HTML carries the title and what the rounds
        are, rather than a spinner. See the note in `app.json` about static
        output: these pages are rendered in Node at build time, and a page whose
        entire body waits on a request ships as an empty shell.
      */}
      {loading && !view ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : null}

      {round ? (
        <Panel tone={round.phase === 'waiting' ? 'default' : 'accent'}>
          <SectionHeading
            eyebrow="NEXT ROUND"
            title={ladderConditionsLine(round)}
            trailing={
              round.phase === 'live' ? (
                <Badge label="ON NOW" tone="live" />
              ) : undefined
            }
          />
          <View style={styles.stats}>
            <Stat label="Starts in" value={round.countdown} />
            {/*
              "In this round" rather than "ready now", and the difference is the
              whole of what the old wording got wrong: an engine in a game at
              the hour is not skipped, its pairing waits. Counting only the idle
              ones reported a field of five as three.
            */}
            <Stat
              label="In this round"
              value={`${groups.inRound} engine${groups.inRound === 1 ? '' : 's'}`}
            />
            <Stat label="Games each" value={String(view?.gamesPerRound ?? 2)} />
          </View>
          {shortField ? <Text style={styles.warning}>{shortField}</Text> : null}
          {/*{round.relativeScale ? (*/}
          {/*  // <Text style={styles.plan}>{BOT_RELATIVE_SCALE_EXPLAINER}</Text>*/}
          {/*) : null}*/}
        </Panel>
      ) : null}

      {view ? (
        <Panel>
          <SectionHeading
            eyebrow="NEXT ROUND"
            title="The field"
            trailing={
              <Badge
                label={fieldSummary(groups).toUpperCase()}
                tone={groups.inRound > 0 ? 'accent' : 'neutral'}
              />
            }
          />
          <Text style={styles.help}>
            Busy engines join when a slot opens. Each badge shows whether an engine can play.
          </Text>
          {waitingNote(groups) ? (
            <Text style={styles.waiting}>{waitingNote(groups)}</Text>
          ) : null}

          {groups.entered.length === 0 ? (
            <EmptyState
              detail={
                groups.away > 0
                  ? "All entered engines are offline. Connect yours before the next round."
                  : "Enter your engine below to join the next round."
              }
              title={groups.away > 0 ? 'No engines running' : 'No engines entered'}
            />
          ) : (
            <View style={styles.list}>
              {groups.entered.map((engine, index) => (
                <FieldRow
                  divided={index > 0}
                  engine={engine}
                  key={engine.botId}
                />
              ))}
            </View>
          )}

          {groups.references.length > 0 ? (
            <View style={styles.subsection}>
              <Text style={styles.subheading}>REFERENCE ENGINES</Text>
              {/*
                Listed rather than counted, which the rail could not afford to
                do. "Why is that thing in every round" is one of the questions
                this page exists to answer, and it cannot be answered about
                engines that are not on it.
              */}
              <Text style={styles.help}>
                Server-run engines anchor the rating scale and play new entrants first.
              </Text>
              <View style={styles.list}>
                {groups.references.map((engine, index) => (
                  <FieldRow
                    divided={index > 0}
                    engine={engine}
                    key={engine.botId}
                  />
                ))}
              </View>
            </View>
          ) : null}

          {/*
            The engines nobody is running, accounted for without being drawn.
            See `LadderFieldGroups.away`: a standing list of absent names would
            sit between the reader and the engines about to play, and dropping
            them without a word would make the page look wrong to anybody who
            knows how many bots are entered.
          */}
          {awayNote(groups) ? (
            <Text style={styles.plan}>{awayNote(groups)}</Text>
          ) : null}
        </Panel>
      ) : null}

      <YourEnginesPanel
        field={view?.field ?? []}
        onChanged={() => void refresh()}
      />

      {view ? (
        <Panel>
          <SectionHeading
            eyebrow={
              view.last
                ? `LAST ROUND · ${relativeTime(view.last.atUnixMs).toUpperCase()}`
                : 'LAST ROUND'
            }
            title={
              view.last
                ? `${modeName(modes, view.last.modeId)} · ${timeControlLabel(view.last)}`
                : 'Nothing yet'
            }
          />
          <Text style={styles.help}>{lastRoundSummary(view)}</Text>
          {lastSeries.length > 0 ? (
            <View style={styles.feed}>
              {lastSeries.map((series) => (
                <BotSeriesCard
                  key={series.seriesId}
                  liveGameIds={liveGameIds}
                  onSelectGame={openGame}
                  series={series}
                />
              ))}
            </View>
          ) : null}
          <View style={styles.actions}>
            <GhostLink href={links.leaderboard()} label="THE LADDER ›" />
            <GhostLink href={links.bots()} label="ENGINES ONLINE ›" />
          </View>
        </Panel>
      ) : null}

      {rotation.length > 0 ? (
        <Panel>
          <SectionHeading eyebrow="THE ROTATION" title="Coming up" />
          <Text style={styles.help}>
            Local times. The schedule repeats every{' '}
            {view?.rotationHours ?? 0} hours.
          </Text>
          <View style={styles.list}>
            {rotation.map((row, index) => (
              <ListRow
                divided={index > 0}
                key={row.key}
                meta={row.clock}
                title={`${row.at} · ${row.mode}`}
                trailing={
                  row.next ? <Badge label="NEXT" tone="accent" /> : undefined
                }
              />
            ))}
          </View>
        </Panel>
      ) : null}
    </ScreenShell>
  );
}

/**
 * One engine in the field: who it is, whose it is, and what the round will do
 * with it.
 *
 * The rating is the mode's own — the one the pairer will read when it chooses
 * this engine's opponent — rather than the account's best, for the reason the
 * rail's own rows give: a rating is only worth reading against the game it is
 * being earned in, and a round is one game.
 */
function FieldRow({
  divided,
  engine,
}: {
  divided: boolean;
  engine: LadderFieldEngine;
}) {
  const status = fieldStatus(engine);
  return (
    <ListRow
      divided={divided}
      leading={
        <BotIcon
          name={engine.name}
          size={30}
          uri={botIconUrl(engine.botId, engine.iconSha256)}
        />
      }
      meta={
        engine.reference
          ? 'Reference engine · in every round'
          : engine.author
            ? `by ${engine.author}`
            : 'entered'
      }
      title={
        <PlayerLink
          handle={engine.name}
          name={engine.name}
          numberOfLines={1}
          style={styles.rowName}
        />
      }
      trailing={
        <View style={styles.rowTrailing}>
          <Text style={styles.rating}>
            {ratingLabel(engine.rating, engine.ratingState)}
          </Text>
          <Badge label={status.label} tone={status.tone} />
        </View>
      }
    />
  );
}

/**
 * A mode's name, falling back to its id.
 *
 * A client older than a new mode still has to be able to say what a round was,
 * and `V7` is a better answer than a gap. `scheduleRows` makes the same choice
 * for the rotation.
 */
const modeName = (modes: ModeDefinition[], modeId: ModeID): string =>
  modes.find((mode) => mode.id === modeId)?.name ?? modeId;

/** One figure, in the row under the countdown. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label.toUpperCase()}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = themedSheet(() => ({
  loading: { paddingVertical: space.xlarge, alignItems: 'center' },
  help: { ...type.body, color: colors.textMuted, marginTop: space.small },
  plan: { ...type.meta, color: colors.textFaint, marginTop: space.small },
  warning: { ...type.label, color: colors.accentSoft, marginTop: space.small },
  // Not `warning`: this is good news about engines somebody is looking for, and
  // in the accent used for a shortfall it would read as one.
  waiting: { ...type.meta, color: colors.textMuted, marginTop: space.small },
  list: { marginTop: space.small },
  feed: { gap: space.small, marginTop: space.medium },
  subsection: { marginTop: space.large },
  subheading: { ...type.eyebrow, color: colors.textFaint },
  rowName: { ...type.rowTitle, color: colors.text, flexShrink: 1 },
  rowTrailing: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  // Tabular figures so a column of ratings lines up, and faint: the badge
  // beside it is what the row is being read for.
  rating: {
    ...type.meta,
    color: colors.textMuted,
    fontVariant: ['tabular-nums'],
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.snug,
    marginTop: space.medium,
  },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.large,
    marginTop: space.medium,
  },
  stat: { minWidth: 96 },
  statLabel: { ...type.eyebrow, color: colors.textFaint },
  statValue: {
    ...type.sectionTitle,
    color: colors.textStrong,
    marginTop: space.hair,
    fontVariant: ['tabular-nums'],
  },
}));
