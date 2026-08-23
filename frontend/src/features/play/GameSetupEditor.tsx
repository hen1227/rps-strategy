import { StyleSheet, Text, View } from 'react-native';

import { timeControlLabel, withMode } from '@/store/setupSelectors';
import { colors, radius, space, type } from '@/theme';
import { Checkbox, GhostButton, OptionChips } from '@/ui/primitives';
import type { GameSetup, ModeDefinition, SideColor, TimeControl } from '@/types/game';

// Every knob on a game, in one panel.
//
// The panel is deliberately a *diff* from the standard game rather than a form
// you must fill in: it opens on the normal match, and each control moves one
// thing away from it. That is the same shape as the value it edits — where every
// field is a deviation and an untouched setup is an ordinary game — which is
// what lets the button underneath say honestly whether this is still just a
// game of matchmaking.

/**
 * The clocks worth offering as one tap. The middle one is the default, so the
 * row always contains the setting that changes nothing.
 */
const CLOCK_PRESETS: readonly TimeControl[] = [
  { initialTimeMs: 60_000, incrementMs: 0 },
  { initialTimeMs: 180_000, incrementMs: 2_000 },
  { initialTimeMs: 300_000, incrementMs: 3_000 },
  { initialTimeMs: 600_000, incrementMs: 5_000 },
  { initialTimeMs: 900_000, incrementMs: 0 },
];

const MOVE_CAPS: readonly number[] = [0, 40, 60, 100];

const SEATS: readonly { value: SideColor | 'random'; label: string }[] = [
  { value: 'random', label: 'EITHER' },
  { value: 'Red', label: 'RED · FIRST' },
  { value: 'Blue', label: 'BLUE · SECOND' },
];

/** A clock as a chip value: primitives compare, objects do not. */
const clockKey = ({ initialTimeMs, incrementMs }: TimeControl) => `${initialTimeMs}:${incrementMs}`;

export interface GameSetupEditorProps {
  modes: ModeDefinition[];
  setup: GameSetup;
  onChange: (setup: GameSetup) => void;
  /** Opens the board editor. Owned by the screen, which already has the modal. */
  onEditPosition: () => void;
  /** Puts the board back to the mode's own opening. */
  onResetPosition: () => void;
  positionIsCustom: boolean;
  defaultTimeControl?: TimeControl | null;
  disabled?: boolean;
}

export default function GameSetupEditor({
  modes,
  setup,
  onChange,
  onEditPosition,
  onResetPosition,
  positionIsCustom,
  defaultTimeControl,
  disabled,
}: GameSetupEditorProps) {
  const mode = modes.find((candidate) => candidate.id === setup.modeId) ?? null;
  const rules = setup.rules ?? {};
  const standardClock = defaultTimeControl ?? CLOCK_PRESETS[2];
  const clocks = CLOCK_PRESETS.map((control) => ({
    value: clockKey(control),
    label: timeControlLabel(control),
  }));
  // A clock the server sent that is not one of the presets still deserves a chip,
  // or the row would show nothing selected for the ordinary game.
  if (!clocks.some((clock) => clock.value === clockKey(standardClock))) {
    clocks.unshift({ value: clockKey(standardClock), label: timeControlLabel(standardClock) });
  }

  const setRules = (change: Partial<typeof rules>) =>
    onChange({ ...setup, rules: { ...rules, ...change } });

  return (
    <View style={styles.editor}>
      <OptionChips
        disabled={disabled}
        label="MODE"
        onChange={(modeId) => {
          const next = modes.find((candidate) => candidate.id === modeId);
          if (next) onChange(withMode(setup, next, mode));
        }}
        options={modes.map((candidate) => ({
          value: candidate.id,
          label: candidate.name.toUpperCase(),
        }))}
        value={setup.modeId}
      />

      <View style={styles.pair}>
        <View style={styles.pairCell}>
          <OptionChips
            changed={clockKey(setup.timeControl) !== clockKey(standardClock)}
            disabled={disabled}
            label="CLOCK"
            onChange={(key) => {
              const control = [standardClock, ...CLOCK_PRESETS].find(
                (candidate) => clockKey(candidate) === key,
              );
              if (control) onChange({ ...setup, timeControl: control });
            }}
            options={clocks}
            value={clockKey(setup.timeControl)}
          />
        </View>
        <View style={styles.pairCell}>
          <OptionChips
            changed={Boolean(setup.casual)}
            disabled={disabled}
            label="STAKES"
            onChange={(casual) => onChange({ ...setup, casual })}
            options={[
              { value: false, label: 'RATED' },
              { value: true, label: 'CASUAL' },
            ]}
            value={Boolean(setup.casual)}
          />
        </View>
      </View>

      <View style={styles.pair}>
        <View style={styles.pairCell}>
          <OptionChips
            changed={Boolean(setup.preferredColor)}
            disabled={disabled}
            label="YOUR SIDE"
            onChange={(seat) =>
              onChange({
                ...setup,
                preferredColor: seat === 'random' ? undefined : (seat as SideColor),
              })
            }
            options={SEATS}
            value={setup.preferredColor ?? 'random'}
          />
        </View>
        <View style={styles.pairCell}>
          <OptionChips
            changed={Boolean(rules.moveLimit)}
            disabled={disabled}
            label="MOVE CAP"
            onChange={(moveLimit) => setRules({ moveLimit: moveLimit || undefined })}
            options={MOVE_CAPS.map((cap) => ({
              value: cap,
              label: cap === 0 ? 'NONE' : `${cap} MOVES`,
            }))}
            value={rules.moveLimit ?? 0}
          />
        </View>
      </View>

      <View style={styles.position}>
        <View style={styles.positionCopy}>
          <Text style={styles.positionTitle}>Starting position</Text>
          <Text style={styles.positionDetail}>
            {positionIsCustom ? 'Custom position' : `${mode?.name ?? 'Mode'} opening`}
            {' · '}
            {setup.preferredColor === 'Blue' ? 'they move first' : 'Red moves first'}
          </Text>
        </View>
        {positionIsCustom ? (
          <GhostButton
            accessibilityLabel="Put the board back to the mode's own opening"
            compact
            disabled={disabled}
            label="RESET"
            onPress={onResetPosition}
          />
        ) : null}
        <GhostButton
          accessibilityLabel="Edit the starting position"
          compact
          disabled={disabled}
          label={positionIsCustom ? 'EDIT' : 'SET POSITION'}
          onPress={onEditPosition}
        />
      </View>

      {/*
        The three rules a game can drop. Checkboxes rather than chips: each is
        an independent thing to switch off, and phrasing them as the deviation
        keeps an unticked panel meaning "the normal rules".
      */}
      <View style={styles.rules}>
        <Text style={styles.rulesLabel}>RULES TO DROP</Text>
        <Checkbox
          checked={Boolean(rules.noRepetitionDraw)}
          label="No repetition draw — repeating a position three times is play, not half a point"
          onToggle={() => setRules({ noRepetitionDraw: !rules.noRepetitionDraw || undefined })}
        />
        <Checkbox
          checked={Boolean(rules.noDrawOffers)}
          label="No draw offers — the game ends on the board"
          onToggle={() => setRules({ noDrawOffers: !rules.noDrawOffers || undefined })}
        />
        <Checkbox
          checked={Boolean(rules.noTimeExtensions)}
          label="No extra time — neither of you can top the clocks up"
          onToggle={() => setRules({ noTimeExtensions: !rules.noTimeExtensions || undefined })}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  editor: { gap: space.medium, marginTop: space.medium },
  pair: { flexDirection: 'row', flexWrap: 'wrap', gap: space.medium },
  pairCell: { flexGrow: 1, flexBasis: 240 },

  position: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.snug,
    padding: space.small,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceSunken,
  },
  positionCopy: { flex: 1 },
  positionTitle: { ...type.meta, color: colors.textSoft, fontWeight: '900' },
  positionDetail: { fontSize: 9, color: colors.textFaint, marginTop: space.hair },

  rules: { gap: space.hair },
  rulesLabel: { ...type.eyebrow, color: colors.textFaint },
});
