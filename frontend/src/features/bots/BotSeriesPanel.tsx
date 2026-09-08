import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import BotHistoryFeed from './BotHistoryFeed';
import BotIcon from './BotIcon';
import { failureMessage } from '@/errors';
import { engineElo } from '@/features/live/liveSelectors';
import { useAdminToken } from '@/hooks/useAdminToken';
import { useRequestIdentity } from '@/hooks/useRequestIdentity';
import { links } from '@/navigation/links';
import {
  abortAdminBotSeries,
  abortBotSeries,
  botIconUrl,
  startAdminBotSeries,
  startBotSeries,
  type BotSeries,
} from '@/store/api/bots';
import { timeControlLabel } from '@/store/setupSelectors';
import { colors, radius, space, type } from '@/theme';
import LinkRow from '@/ui/LinkRow';
import {
  Banner,
  EmptyState,
  GhostButton,
  LabeledInput,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';
import type { ModeDefinition, TimeControl } from '@/types/game';
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
//
// The two *bots* used to be picked the same way, from two chip rows carrying
// every online engine's name — directly beneath the list of those same engines,
// so the page said each name three times and the panel's whole depiction of the
// run it was about to start was two highlighted words. They are picked on the
// cards now, and what this panel draws instead is the fight: two portraits with
// their ratings, facing each other. Which side is which still matters (the first
// engine opens the first game of every pair), so the slots are labelled and
// there is a button to exchange them.

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

/**
 * One side of the fight.
 *
 * Empty is a real state with a real shape rather than a gap: this panel appears
 * the moment two engines are online, and a slot nobody has filled has to look
 * like somewhere an engine goes. Pressing a filled one empties it, which is the
 * only way to clear a side without scrolling back to its card.
 */
function PitSlot({
  bot,
  mirrored,
  mode,
  onClear,
  role,
  stacked,
}: {
  bot: BotPresence | null;
  /**
   * The two sides are one above the other. `flexBasis` is a *height* on a
   * column axis, so the side-by-side basis has to be given back or each slot
   * becomes 220 points tall around a 64-point portrait.
   */
  stacked?: boolean;
  /**
   * Draw this side facing the other one: portrait at the outer edge, copy
   * running inward. It is what makes two boxes read as a fight rather than as
   * two entries in a list.
   */
  mirrored?: boolean;
  mode: ModeDefinition;
  onClear: () => void;
  role: 'FIRST' | 'SECOND';
}) {
  const align = mirrored ? styles.mirroredText : null;
  const body = bot ? (
    <>
      <BotIcon name={bot.name} size={64} uri={botIconUrl(bot.botId, bot.iconSha256)} />
      <View style={styles.slotCopy}>
        <Text style={[styles.slotRoleFilled, align]}>{role}</Text>
        <Text numberOfLines={1} style={[styles.slotName, align]}>
          {bot.name}
        </Text>
        <Text numberOfLines={1} style={[styles.slotAuthor, align]}>
          {bot.engineAuthor ? `by ${bot.engineAuthor}` : bot.engineName || 'engine'}
        </Text>
        <Text style={[styles.slotRating, align]}>{engineElo(bot, mode.id)}</Text>
      </View>
    </>
  ) : (
    <>
      <View style={styles.slotArtEmpty}>
        <Text style={styles.slotQuery}>?</Text>
      </View>
      <View style={styles.slotCopy}>
        <Text style={[styles.slotRole, align]}>{role}</Text>
        <Text numberOfLines={1} style={[styles.slotHint, align]}>
          PRESS VS ON A CARD ABOVE
        </Text>
      </View>
    </>
  );

  if (!bot) {
    return (
      <View
        style={[
          styles.slot,
          styles.slotEmpty,
          mirrored && styles.slotMirrored,
          stacked && styles.slotStacked,
        ]}
      >
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityLabel={`Take ${bot.name} out of the ${role.toLowerCase()} slot`}
      accessibilityRole="button"
      onPress={onClear}
      style={({ pressed }) => [
        styles.slot,
        styles.slotFilled,
        mirrored && styles.slotMirrored,
        stacked && styles.slotStacked,
        pressed && styles.pressed,
      ]}
    >
      {body}
    </Pressable>
  );
}

export interface BotSeriesPanelProps {
  /** The engine on the first side, which opens game one of every pair. */
  first: BotPresence | null;
  second: BotPresence | null;
  /**
   * How many engines could be entered right now.
   *
   * Two slots and a dead START button are not a form, they are a picture of one
   * — so under two, this panel says why instead of drawing it. The count rather
   * than a boolean because the sentence needs to tell "nobody is connected"
   * from "the one connected engine has nobody to play".
   */
  available: number;
  /** The mode the run is played at, chosen once for the page above. */
  mode: ModeDefinition;
  /** Exchange the two sides. */
  onSwap: () => void;
  onClear: (side: 'first' | 'second') => void;
}

export default function BotSeriesPanel({
  first,
  second,
  available,
  mode,
  onSwap,
  onClear,
}: BotSeriesPanelProps) {
  const identity = useRequestIdentity();
  const admin = useAdminToken();
  const [hostFormOpen, setHostFormOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const [pairs, setPairs] = useState('2');
  const [plies, setPlies] = useState('3');
  const [seed, setSeed] = useState('');
  const [minutes, setMinutes] = useState('1');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the two sides still fit beside each other, measured on the row
  // itself rather than on the window: this panel sits in a column between the
  // shell's sidebar and its live rail, and the window is a long way wider than
  // the space it actually has. Safe against oscillation because the row fills
  // its parent either way, so the flag cannot change the width it is read from.
  const [narrow, setNarrow] = useState(false);
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
    if (!first || !second) return;
    setBusy(true);
    setError(null);
    try {
      const options = {
        firstBotId: first.botId,
        secondBotId: second.botId,
        modeId: mode.id,
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

  // Whether the two chosen engines belong to one person, which is what decides
  // whether the run is casual. The server settles it — see sameBotOwner in
  // bot_series.go — and this is the form saying so in advance rather than a
  // second opinion about it.
  //
  // The empty check is the whole of the care needed: `ownerUserId` is absent for
  // an engine whose owner the roster does not carry, and two absent owners
  // compared as strings would read as one person owning both.
  const sameOwner =
    Boolean(first?.ownerUserId) && first?.ownerUserId === second?.ownerUserId;
  const canStart = !busy && Boolean(first) && Boolean(second) && first !== second;
  const mine = (run: BotSeries) =>
    Boolean(run.requestedByUserId) && run.requestedByUserId === identity.userId;

  return (
    <>
      <Panel style={asHost ? styles.adminPanel : undefined}>
        <SectionHeading
          eyebrow={asHost ? 'HOST' : 'ANYBODY'}
          title="Pit two engines against each other"
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

        {available < 2 ? (
          <EmptyState
            detail={
              available === 1
                ? 'One engine is free. A run needs two, so wait for another to finish its game or come online.'
                : 'No engine is free. A run needs two, so wait for one to finish its game or come online.'
            }
            title="Not enough free engines"
          />
        ) : (
          <>
        {/*
          The fight itself, at the size of the decision. Both slots and the SWAP
          between them are the same control the cards above are — press VS there
          to fill a side, press a portrait here to empty one.
        */}
        <View
          onLayout={(event) => setNarrow(event.nativeEvent.layout.width < 520)}
          style={[styles.pit, narrow && styles.pitStacked]}
        >
          <PitSlot
            bot={first}
            mode={mode}
            onClear={() => onClear('first')}
            role="FIRST"
            stacked={narrow}
          />
          <View style={[styles.versus, narrow && styles.versusStacked]}>
            <Text style={styles.versusText}>VS</Text>
            <GhostButton
              accessibilityLabel="Exchange the two engines"
              compact
              disabled={!first && !second}
              label="SWAP"
              onPress={onSwap}
            />
          </View>
          {/*
            Facing inward only while the two are side by side. Stacked, a
            right-aligned second slot is not a fight, it is one box of text
            hanging off the wrong edge.
          */}
          <PitSlot
            bot={second}
            mirrored={!narrow}
            mode={mode}
            onClear={() => onClear('second')}
            role="SECOND"
            stacked={narrow}
          />
        </View>

        <Text style={styles.summary}>
          {first && second
            ? `${mode.name} · ${pairs} pairs, colours swapped each time · ${timeControlLabel(clock)}`
            : `Pick two engines above. They will play ${mode.name} and the ladder will rate the result.`}
        </Text>

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
          </>
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
  summary: { ...type.body, color: colors.textDim, marginTop: space.medium },
  pit: {
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: space.small,
    marginTop: space.medium,
  },
  pitStacked: { flexDirection: 'column' },
  slot: {
    // Both slots share whatever is left once VS has taken its width, so the
    // fight stays symmetrical at every page width instead of the filled side
    // growing to its name. A basis rather than `flexBasis: 0` so that the row
    // can wrap on a phone instead of squeezing two portraits into 160 points.
    flexBasis: 220,
    flexGrow: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.medium,
    padding: space.medium,
    borderRadius: radius.medium,
    borderWidth: 1,
  },
  slotMirrored: { flexDirection: 'row-reverse' },
  slotStacked: { flexBasis: 'auto', flexGrow: 0 },
  // `minWidth: 0`, or an engine name with no spaces in it keeps this column at
  // its own intrinsic width and pushes the portrait off the slot.
  slotCopy: { flex: 1, minWidth: 0 },
  mirroredText: { textAlign: 'right' },
  slotFilled: { borderColor: colors.accentBorder, backgroundColor: colors.accentSurfaceQuiet },
  slotEmpty: {
    borderColor: colors.borderSoft,
    borderStyle: 'dashed',
    backgroundColor: colors.surfaceSunken,
  },
  slotRole: { ...type.eyebrow, color: colors.textFaint },
  slotRoleFilled: { ...type.eyebrow, color: colors.accentText },
  slotArtEmpty: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderStyle: 'dashed',
  },
  slotQuery: { fontSize: 28, fontWeight: '900', color: colors.borderLight },
  slotHint: { ...type.label, color: colors.textFaint, marginTop: space.tight },
  slotName: { ...type.cardTitle, color: colors.text },
  slotAuthor: { ...type.meta, fontSize: 10, color: colors.textFaint },
  slotRating: { fontSize: 22, fontWeight: '900', color: colors.accentSoft, marginTop: space.hair },
  versus: { minWidth: 62, alignItems: 'center', justifyContent: 'center', gap: space.snug },
  versusStacked: { flexDirection: 'row', gap: space.medium },
  versusText: { ...type.cardTitle, color: colors.textFaint },
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: space.medium, marginTop: space.medium },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.small,
    marginTop: space.medium,
  },
  pressed: { opacity: 0.7 },
});
