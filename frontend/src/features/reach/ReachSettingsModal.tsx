import { StyleSheet, Text, View } from 'react-native';

import ModalCard from '@/ui/ModalCard';
import { Checkbox, GhostButton, OptionChips } from '@/ui/primitives';
import { squareLabel } from '@/engine/analysisGame';
import type { ObstacleModel, SafetyRule } from '@/engine/reach';
import {
  OBSTACLE_BLURBS,
  OBSTACLE_LABELS,
  REACH_VIEWS,
  REACH_VIEW_BLURBS,
  REACH_VIEW_LABELS,
  SAFETY_BLURBS,
  SAFETY_LABELS,
  type ReachSettings,
  type ReachView,
} from './settings';
import { colors, radius, space } from '@/theme';
import { PLAYABLE_PIECES, SIDE_COLORS, type PlayablePiece, type SideColor } from '@/types/game';

// Every knob, with the sentence that says what it changes.
//
// The compact panel beside the board carries the four settings that get touched
// while reading a position; these are the ones that decide what the numbers
// *mean*, and getting them wrong quietly is the failure mode worth spending a
// dialog on. Hence a blurb under each — none of `per move` versus `whole run`,
// or `as it stands` versus `friends move`, is guessable from its label.

const VIEW_OPTIONS = REACH_VIEWS.map((view) => ({
  value: view,
  label: REACH_VIEW_LABELS[view],
}));

const OBSTACLE_OPTIONS: { value: ObstacleModel; label: string }[] = (
  ['open', 'static', 'friendlyVacates'] as const
).map((model) => ({ value: model, label: OBSTACLE_LABELS[model] }));

const SAFETY_OPTIONS: { value: SafetyRule; label: string }[] = (
  ['perStep', 'wholeRun', 'off'] as const
).map((rule) => ({ value: rule, label: SAFETY_LABELS[rule] }));

const TEMPO_OPTIONS: { value: 'position' | SideColor; label: string }[] = [
  { value: 'position', label: 'FOLLOW GAME' },
  { value: 'Red', label: 'RED FIRST' },
  { value: 'Blue', label: 'BLUE FIRST' },
];

const SIDE_OPTIONS = SIDE_COLORS.map((color) => ({ value: color, label: color.toUpperCase() }));

const KIND_OPTIONS: { value: PlayablePiece | 'all'; label: string }[] = [
  { value: 'all', label: 'ALL' },
  ...PLAYABLE_PIECES.map((piece) => ({ value: piece, label: piece.toUpperCase() })),
];

function Section({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export interface ReachSettingsModalProps {
  visible: boolean;
  onClose: () => void;
  settings: ReachSettings;
  onChange: (patch: Partial<ReachSettings>) => void;
  onReset: () => void;
}

export default function ReachSettingsModal({
  visible,
  onClose,
  settings,
  onChange,
  onReset,
}: ReachSettingsModalProps) {
  return (
    <ModalCard
      eyebrow="TOOL"
      footer={<GhostButton label="Reset to defaults" onPress={onReset} />}
      maxWidth={560}
      onClose={onClose}
      subtitle="Every square a piece can stand on, and whether anything can stop it getting there."
      title="Reach settings"
      visible={visible}
    >
      <View style={styles.body}>
        <Section title="WHAT TO SHOW">
          <OptionChips<ReachView>
            onChange={(view) => onChange({ view })}
            options={VIEW_OPTIONS}
            value={settings.view}
          />
          <Text style={styles.blurb}>{REACH_VIEW_BLURBS[settings.view]}</Text>
        </Section>

        <Section title="WHAT COUNTS AS A BLOCKER">
          <OptionChips<ObstacleModel>
            onChange={(obstacles) => onChange({ obstacles })}
            options={OBSTACLE_OPTIONS}
            value={settings.obstacles}
          />
          <Text style={styles.blurb}>{OBSTACLE_BLURBS[settings.obstacles]}</Text>
        </Section>

        <Section title="WHEN A SQUARE IS TOO DANGEROUS">
          <OptionChips<SafetyRule>
            onChange={(safety) => onChange({ safety })}
            options={SAFETY_OPTIONS}
            value={settings.safety}
          />
          <Text style={styles.blurb}>{SAFETY_BLURBS[settings.safety]}</Text>
        </Section>

        <Section title="WHO MOVES NEXT">
          <OptionChips<'position' | SideColor>
            changed={settings.tempo !== 'position'}
            onChange={(tempo) => onChange({ tempo })}
            options={TEMPO_OPTIONS}
            value={settings.tempo}
          />
          <Text style={styles.blurb}>
            One tempo is worth exactly one square of the chase, so a run that is safe on the
            move is often lost off it. Force a side to see the other half of the answer.
          </Text>
          <Checkbox
            checked={settings.goalEndsGame}
            label="Landing on the goal wins before the reply"
            onToggle={() => onChange({ goalEndsGame: !settings.goalEndsGame })}
          />
          <Text style={styles.blurb}>
            The rule as the game plays it. Turn it off to ask the stricter question: could the
            piece stand on the goal square and survive?
          </Text>
        </Section>

        <Section title="WHICH PIECES">
          <OptionChips<SideColor>
            label="SIDE"
            onChange={(side) => onChange({ side })}
            options={SIDE_OPTIONS}
            value={settings.side}
          />
          <OptionChips<PlayablePiece | 'all'>
            label="KIND"
            changed={settings.kind !== 'all'}
            onChange={(kind) => onChange({ kind })}
            options={KIND_OPTIONS}
            value={settings.kind}
          />
        </Section>

        <Section title="A PIECE THAT IS NOT THERE">
          <Text style={styles.blurb}>
            Put one anywhere and the whole reading is redone as though it were on the board —
            the quickest way to ask what a square is worth before you spend four moves getting
            to it.
          </Text>
          <OptionChips<PlayablePiece>
            label="GHOST KIND"
            onChange={(piece) =>
              onChange({
                ghost: settings.ghost ? { ...settings.ghost, piece } : null,
                placingGhost: settings.ghost ? settings.placingGhost : true,
              })
            }
            options={PLAYABLE_PIECES.map((piece) => ({ value: piece, label: piece.toUpperCase() }))}
            value={settings.ghost?.piece ?? 'Rock'}
          />
          <View style={styles.ghostRow}>
            <GhostButton
              compact
              label={settings.placingGhost ? 'Tap a square…' : 'Place ghost'}
              onPress={() => onChange({ placingGhost: !settings.placingGhost })}
            />
            {settings.ghost && (
              <>
                <Text style={styles.ghostAt}>on {squareLabel(settings.ghost.at)}</Text>
                <GhostButton
                  compact
                  label="Clear"
                  onPress={() => onChange({ ghost: null, placingGhost: false })}
                />
              </>
            )}
          </View>
        </Section>

        <Section title="DRAWING">
          <View style={styles.checks}>
            <Checkbox
              checked={settings.showNumbers}
              label="Number every square"
              onToggle={() => onChange({ showNumbers: !settings.showNumbers })}
            />
            <Checkbox
              checked={settings.showFrontier}
              label="Outline the frontier"
              onToggle={() => onChange({ showFrontier: !settings.showFrontier })}
            />
            <Checkbox
              checked={settings.dimBeyond}
              label="Fade what lies past it, rather than hiding it"
              onToggle={() => onChange({ dimBeyond: !settings.dimBeyond })}
            />
            <Checkbox
              checked={settings.showDanger}
              label="Wash the squares a predator reaches first"
              onToggle={() => onChange({ showDanger: !settings.showDanger })}
            />
            <Checkbox
              checked={settings.showPath}
              label="Draw the safe run"
              onToggle={() => onChange({ showPath: !settings.showPath })}
            />
            <Checkbox
              checked={settings.pinned}
              label="Pin the focus, so tapping the board does not move it"
              onToggle={() => onChange({ pinned: !settings.pinned })}
            />
          </View>
        </Section>
      </View>
    </ModalCard>
  );
}

const styles = StyleSheet.create({
  body: { gap: space.large },
  section: { gap: space.snug },
  sectionTitle: {
    color: colors.textFaint,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1.2,
  },
  blurb: { color: colors.textMuted, fontSize: 10, lineHeight: 15 },
  checks: { gap: space.tight },
  ghostRow: { flexDirection: 'row', alignItems: 'center', gap: space.small, flexWrap: 'wrap' },
  ghostAt: {
    color: colors.textSoft,
    fontSize: 10,
    fontWeight: '800',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: radius.small,
    backgroundColor: colors.surfaceSunken,
  },
});
