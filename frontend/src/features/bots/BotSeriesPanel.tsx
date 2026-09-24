import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import BotHistoryFeed from './BotHistoryFeed';
import BotIcon from './BotIcon';
import { seriesSettingsLine } from './pitSelection';
import { MIN_MINUTES, type BotSeriesForm } from './useBotSeriesForm';
import { engineElo } from '@/features/live/liveSelectors';
import { links } from '@/navigation/links';
import { botIconUrl } from '@/store/api/bots';
import { timeControlLabel } from '@/store/setupSelectors';
import { colors, radius, space, themedSheet, type } from '@/theme';
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
import type { ModeDefinition } from '@/types/game';
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
//
// And this panel no longer *starts* anything. The picks are made on the cards at
// the top of the page, which on a phone with a dozen engines online is two or
// three screens above here — so somebody who had just chosen two engines had
// filled in a form and could not see its button. START moved to a bar pinned to
// the foot of the page, next to where the choosing happens, and what is left
// here is the fight at full size and the numbers behind it: this panel is what
// the run *will be*, not the press that begins it. The state both of them read
// is `useBotSeriesForm`, arriving as one `form` prop.

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
        {/*
          Two lines, for the same reason LinkRow's detail takes two: at 320
          points this wants 158 and has 154, so a one-line clamp turned the
          instruction into "PICK ONE ON A CARD ABO…" on the narrowest phones —
          which is the one string on this panel that has to be readable.
        */}
        <Text numberOfLines={2} style={[styles.slotHint, align]}>
          PICK ONE ON A CARD ABOVE
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
  /** The run being set up, shared with the bar that starts it. */
  form: BotSeriesForm;
}

export default function BotSeriesPanel({
  first,
  second,
  available,
  mode,
  onSwap,
  onClear,
  form,
}: BotSeriesPanelProps) {
  const [hostFormOpen, setHostFormOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [draft, setDraft] = useState('');
  // Whether the two sides still fit beside each other, measured on the row
  // itself rather than on the window: this panel sits in a column between the
  // shell's sidebar and its live rail, and the window is a long way wider than
  // the space it actually has. Safe against oscillation because the row fills
  // its parent either way, so the flag cannot change the width it is read from.
  const [narrow, setNarrow] = useState(false);

  const { admin, asHost } = form;

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

        {/*
          The same error the bar shows, in the other place a request can fail
          from: a stop has to explain itself next to the STOP button that caused
          it. They are never both in view — the bar is at the foot of the screen
          and this is two screens down — and dismissing either clears it.
        */}
        {form.error ? (
          <Banner message={form.error} onDismiss={form.dismissError} tone="error" />
        ) : null}

        {available < 2 ? (
          <EmptyState
            detail={
              available === 1
                ? "One engine is available. A series needs two."
                : "No engines are available. A series needs two."
            }
            title="Not enough free engines"
          />
        ) : (
          <>
        {/*
          The fight itself, at the size of the decision. Both slots and the SWAP
          between them are the same control the cards above are — press a card's
          green button to fill a side, press a portrait here to empty one.
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

        {/*
          The same sentence the bar carries, from the same place, so the two
          cannot describe one run differently.
        */}
        <Text style={styles.summary}>
          {first && second
            ? seriesSettingsLine({ clock: form.clock, mode, pairs: form.pairs })
            : `Pick two engines to play a casual ${mode.name} series.`}
        </Text>

        {/*
          Where the button is. This panel describes a run and no longer starts
          one, and a settings form with no action in it is a form somebody will
          hunt for the action in.
        */}
        <Text style={styles.help}>Press START SERIES below when ready.</Text>

        {form.sameOwner ? (
          <Text style={styles.help}>
            These are both your engines. Series are casual and do not affect ratings.
          </Text>
        ) : null}

        {optionsOpen ? (
          <View style={styles.fields}>
            <LabeledInput
              hint={`Played twice each, colours swapped · max ${form.maxPairs}`}
              keyboardType="number-pad"
              label="PAIRS"
              onChangeText={form.setPairs}
              value={form.pairs}
            />
            <LabeledInput
              hint={`Random moves both bots start from · max ${form.maxPlies}`}
              keyboardType="number-pad"
              label="OPENING PLIES"
              onChangeText={form.setPlies}
              value={form.plies}
            />
            <LabeledInput
              hint="Blank picks one"
              keyboardType="number-pad"
              label="SEED"
              onChangeText={form.setSeed}
              value={form.seed}
            />
            <LabeledInput
              hint={`${MIN_MINUTES} is a six-second bullet clock · max ${form.maxMinutes}`}
              keyboardType="decimal-pad"
              label="MINUTES EACH"
              onChangeText={form.setMinutes}
              value={form.minutes}
            />
          </View>
        ) : null}

        <View style={styles.actions}>
          <GhostButton
            compact
            label={
              optionsOpen
                ? 'HIDE OPTIONS'
                : `${form.pairs} PAIRS · ${form.plies} PLIES · ${timeControlLabel(form.clock)}`
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
      you started, which needs the identity and the admin token the form is
      already holding.
    */}
      <BotHistoryFeed
        emptyDetail="Pick two engines above, then press START SERIES."
        eyebrow="RESULTS"
        refreshKey={form.changed}
        seriesAction={(run) =>
          String(run.status).toLowerCase() === 'running' && (asHost || form.mine(run)) ? (
            <GhostButton compact label="STOP" onPress={() => form.stop(run)} />
          ) : null
        }
        title="Recent runs"
      />
    </>
  );
}

const styles = themedSheet(() => ({
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
}));
