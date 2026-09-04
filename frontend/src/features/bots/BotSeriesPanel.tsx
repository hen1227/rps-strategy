import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import BotHistoryFeed from './BotHistoryFeed';
import { failureMessage } from '@/errors';
import { useAdminToken } from '@/hooks/useAdminToken';
import { useRequestIdentity } from '@/hooks/useRequestIdentity';
import { links } from '@/navigation/links';
import {
  abortAdminBotSeries,
  abortBotSeries,
  startAdminBotSeries,
  startBotSeries,
  type BotSeries,
} from '@/store/api/bots';
import { timeControlLabel } from '@/store/setupSelectors';
import { colors, space, type } from '@/theme';
import LinkRow from '@/ui/LinkRow';
import {
  Banner,
  GhostButton,
  LabeledInput,
  OptionChips,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';
import type { ModeDefinition, ModeID, TimeControl } from '@/types/game';
import type { BotPresence } from '@/types/protocol';

// Pit two engine bots against each other.
//
// This was a host control, and the reasoning for that only ever covered the
// cost: a run holds two engines for as long as it lasts, so it should not be
// free to start a hundred of them. It never covered the permission, because the
// bots already carry one — every engine has a public-play switch that decides
// whether strangers may play it, and a series is strangers playing it.
//
// So the form is open to anybody, and what used to be an admin gate is now three
// server-side limits: at most three pairs, at most ten minutes each, and one
// running series per person. The HOST CONTROLS button below lifts all three for
// somebody who holds the host token, which is what a fifty-pair run at a real
// time control needs.
//
// The four numbers that shape a run sit behind a toggle. Every one of them has a
// sensible default, none of them is the decision anybody came here to make, and
// four labelled fields at the top of a panel read as a form to be filled in
// rather than a button to be pressed.

/** What the public form may ask for. The server enforces the same numbers. */
const PUBLIC_MAX_PAIRS = 3;
const PUBLIC_MAX_MINUTES = 10;
/**
 * An opening is a handful of moves off the book, not a position somebody else
 * played into. The server allows up to botSeriesMaxOpeningPlies, which is what
 * the host form still offers.
 */
const PUBLIC_MAX_PLIES = 6;
/** What the host may ask for, matching the server's own ceilings. */
const HOST_MAX_PAIRS = 100;
const HOST_MAX_PLIES = 20;

/**
 * The shortest clock the form will send: 0.1+1, six seconds each with a second
 * back every move.
 *
 * A bullet clock is not the degenerate setting between two engines that it is
 * between two people. Neither of them is going to fumble a mouse, the increment
 * is what carries a game this short, and six of them are over in less time than
 * one game at the default clock takes — which is the difference between
 * watching a run settle a question and starting one and coming back later.
 */
const MIN_MINUTES = 0.1;

const numeric = (value: string, fallback: number) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Minutes alone may be fractional — see MIN_MINUTES — so they are not rounded. */
const decimal = (value: string, fallback: number) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high);

export interface BotSeriesPanelProps {
  /** The connected engines to pick two opponents from. */
  bots: BotPresence[];
  modes: ModeDefinition[];
}

export default function BotSeriesPanel({ bots, modes }: BotSeriesPanelProps) {
  const identity = useRequestIdentity();
  const admin = useAdminToken();
  const [hostFormOpen, setHostFormOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const [firstBotId, setFirstBotId] = useState<string | null>(null);
  const [secondBotId, setSecondBotId] = useState<string | null>(null);
  const [modeId, setModeId] = useState<ModeID>(modes[0]?.id ?? 'V6');
  const [pairs, setPairs] = useState('2');
  const [plies, setPlies] = useState('3');
  const [seed, setSeed] = useState('');
  const [minutes, setMinutes] = useState('1');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after starting or stopping a run, which is how the feed below is told
  // to refetch now rather than on its own timer. The runs themselves are the
  // feed's to hold: this panel is a form, and it kept a second copy of the list
  // only because it used to draw one.
  const [changed, setChanged] = useState(0);

  const asHost = admin.unlocked;
  const maxPairs = asHost ? HOST_MAX_PAIRS : PUBLIC_MAX_PAIRS;
  const maxPlies = asHost ? HOST_MAX_PLIES : PUBLIC_MAX_PLIES;
  const maxMinutes = asHost ? 60 : PUBLIC_MAX_MINUTES;

  const refresh = useCallback(() => setChanged((count) => count + 1), []);

  // The clock as the request will carry it, so the button underneath reports
  // the number that will be sent rather than whatever is half-typed in the
  // field. The increment is fixed at a second: it is what makes the shortest
  // clock on offer playable at all, and nobody came here to choose it.
  const clock = useMemo<TimeControl>(
    () => ({
      initialTimeMs: Math.round(
        clamp(decimal(minutes, 1), MIN_MINUTES, maxMinutes) * 60_000,
      ),
      incrementMs: 1000,
    }),
    [minutes, maxMinutes],
  );

  const start = async () => {
    if (!firstBotId || !secondBotId) return;
    setBusy(true);
    setError(null);
    try {
      const options = {
        firstBotId,
        secondBotId,
        modeId,
        pairs: clamp(numeric(pairs, 2), 1, maxPairs),
        openingPlies: clamp(numeric(plies, 3), 0, maxPlies),
        // Passed through as text rather than parsed: the value a person pastes
        // here is one they copied off a finished run, and `Number.parseInt`
        // would round it before it ever left the browser.
        seed: seed.trim().replace(/\D/g, ''),
        timeControl: clock,
      };
      if (asHost) await startAdminBotSeries(admin.token, options);
      else await startBotSeries(identity, options);
      refresh();
    } catch (caught) {
      setError(failureMessage(caught, 'The series could not be started.'));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (run: BotSeries) => {
    setError(null);
    try {
      if (asHost) await abortAdminBotSeries(admin.token, run.seriesId);
      else await abortBotSeries(identity, run.seriesId);
      refresh();
    } catch (caught) {
      setError(failureMessage(caught, 'The series could not be stopped.'));
    }
  };

  // A bot that is mid-game cannot be entered into a new run, and neither can one
  // that is shutting down — that one is dropped rather than marked, because
  // unlike a private bot there is nobody, owner included, who can enter it. A
  // bot whose owner has not opened it to public play is still listed, marked,
  // because its owner is allowed to enter it and the server is the one that
  // knows who that is.
  const idle = useMemo(
    // `benched` as well as `draining`: the server refuses to start a series
    // during a scheduled bench, so offering the engines here would be a form
    // that can only fail.
    () => bots.filter((bot) => !bot.busy && !bot.draining && !bot.benched),
    [bots],
  );
  const botOptions = useMemo(
    () =>
      idle.map((bot) => ({
        label: bot.allowPublicPlay ? bot.name : `${bot.name} · PRIVATE`,
        value: bot.botId as string | null,
      })),
    [idle],
  );
  const enoughBots = idle.length >= 2;
  // Whether the two chosen engines belong to one person, which is what decides
  // whether the run is casual. The server settles it — see sameBotOwner in
  // bot_series.go — and this is the form saying so in advance rather than a
  // second opinion about it.
  //
  // The empty check is the whole of the care needed: `ownerUserId` is absent for
  // an engine whose owner the roster does not carry, and two absent owners
  // compared as strings would read as one person owning both.
  const sameOwner = useMemo(() => {
    const ownerOf = (botId: string | null) =>
      bots.find((bot) => bot.botId === botId)?.ownerUserId ?? '';
    const first = ownerOf(firstBotId);
    return first !== '' && first === ownerOf(secondBotId);
  }, [bots, firstBotId, secondBotId]);
  const canStart =
    !busy && Boolean(firstBotId) && Boolean(secondBotId) && firstBotId !== secondBotId;
  const mine = (run: BotSeries) =>
    Boolean(run.requestedByUserId) && run.requestedByUserId === identity.userId;

  return (
    <>
    <Panel style={asHost ? styles.adminPanel : undefined}>
      <SectionHeading
        eyebrow={asHost ? 'HOST' : 'ANYBODY'}
        title="Pit two bots against each other"
        trailing={
          admin.bySession ? undefined : (
            <GhostButton
              compact
              label={hostFormOpen || asHost ? 'CLOSE' : 'HOST CONTROLS'}
              onPress={() => {
                if (asHost) admin.lock();
                setHostFormOpen(!hostFormOpen && !asHost);
              }}
            />
          )
        }
      />

      {hostFormOpen && !asHost ? (
        <>
          {admin.error ? <Banner message={admin.error} tone="error" /> : null}
          <LabeledInput
            label="ADMIN TOKEN"
            onChangeText={setDraft}
            secureTextEntry
            value={draft}
          />
          <PrimaryButton
            disabled={admin.verifying}
            label="UNLOCK HOST LIMITS"
            onPress={() => admin.unlock(draft).then((ok) => ok && setDraft(''))}
          />
        </>
      ) : null}

      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}

      {enoughBots && (
        <View style={styles.form}>
          <OptionChips<string | null>
            label="FIRST BOT"
            onChange={setFirstBotId}
            options={botOptions}
            value={firstBotId}
          />
          <OptionChips<string | null>
            label="SECOND BOT"
            onChange={setSecondBotId}
            options={botOptions}
            value={secondBotId}
          />
          <OptionChips<ModeID>
            label="MODE"
            onChange={setModeId}
            options={modes.map((mode) => ({ label: mode.name, value: mode.id }))}
            value={modeId}
          />

          {sameOwner ? (
            <Text style={styles.help}>
              Both engines have the same owner, so this run is casual — the ladder does
              not rate a pair of bots one person registered. Pick engines from different
              owners for a rated run.
            </Text>
          ) : null}

          {optionsOpen ? (
            <View style={styles.fields}>
              <LabeledInput
                hint={`Played twice each, colours swapped · max ${maxPairs}`}
                keyboardType="number-pad"
                label="PAIRS"
                onChangeText={setPairs}
                value={pairs}
              />
              <LabeledInput
                hint={`Random moves both bots start from · max ${maxPlies}`}
                keyboardType="number-pad"
                label="OPENING PLIES"
                onChangeText={setPlies}
                value={plies}
              />
              <LabeledInput
                hint="Blank picks one"
                keyboardType="number-pad"
                label="SEED"
                onChangeText={setSeed}
                value={seed}
              />
              <LabeledInput
                hint={`${MIN_MINUTES} is a six-second bullet clock · max ${maxMinutes}`}
                keyboardType="decimal-pad"
                label="MINUTES EACH"
                onChangeText={setMinutes}
                value={minutes}
              />
            </View>
          ) : null}

          <View style={styles.actions}>
            <PrimaryButton
              disabled={!canStart}
              label={sameOwner ? 'START CASUAL SERIES ▶' : 'START SERIES ▶'}
              onPress={start}
            />
            <GhostButton
              compact
              label={
                optionsOpen
                  ? 'HIDE OPTIONS'
                  : `${pairs} PAIRS · ${plies} PLIES · ${timeControlLabel(clock)}`
              }
              onPress={() => setOptionsOpen(!optionsOpen)}
            />
          </View>
        </View>
      )}

      {/*
        Where these runs end up. The standings used to be copied onto this page
        as well, which made a page about starting a run twice as long as the
        run's own scoreboard.
      */}
      <LinkRow
        detail="Ranked engine standings, and every game behind them."
        href={links.leaderboard()}
        title="The bot ladder"
      />
    </Panel>

    {/*
      The same feed the Leaderboard carries, because it is the same question.
      What this page adds is the one thing only it can: a STOP button on a run
      you started, which needs the identity and the admin token this panel is
      already holding.
    */}
    <BotHistoryFeed
      emptyDetail="Pick two engines above and press START SERIES."
      eyebrow="RESULTS"
      refreshKey={changed}
      seriesAction={(run) =>
        String(run.status).toLowerCase() === 'running' && (asHost || mine(run)) ? (
          <GhostButton compact label="STOP" onPress={() => stop(run)} />
        ) : null
      }
      title="Recent runs"
    />
    </>
  );
}

const styles = StyleSheet.create({
  adminPanel: { borderColor: colors.goldBorder, backgroundColor: colors.goldSurfaceDeep },
  help: { ...type.body, color: colors.textMuted, marginTop: space.small },
  form: { gap: space.medium, marginTop: space.medium },
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: space.medium },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.small,
  },
});
