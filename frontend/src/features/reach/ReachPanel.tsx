import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import ReachLegend from './ReachLegend';
import ReachSettingsModal from './ReachSettingsModal';
import ReachSummary from './ReachSummary';
import { REACH_VIEWS, REACH_VIEW_LABELS, type ReachView } from './settings';
import type { ReachToolResult } from '@/hooks/useReach';
import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, themedSheet } from '@/theme';
import { BOARD_SIZE } from '@/types/game';

// The tool's controls, in a column 310 points wide.
//
// What lives here is what gets touched while reading a position — the view, how
// far to look, and whether the numbers are in the way. Everything that decides
// what the numbers *mean* is a press away in the settings dialog, because a
// panel with fifteen controls in it beside a board is a panel nobody reads.
//
// One component for every host. The game screen and the analysis board differ
// in where they put it, not in what it does.

/** The largest distance worth asking about: a king crosses the board in eight. */
const MAX_MOVES = BOARD_SIZE - 1;

function TogglePill({
  checked,
  label,
  onPress,
}: {
  checked: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={`${label}, ${checked ? 'on' : 'off'}`}
      accessibilityRole="switch"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        checked && styles.pillOn,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.pillText, checked && styles.pillTextOn]}>{label}</Text>
    </Pressable>
  );
}

function StepButton({
  disabled,
  label,
  onPress,
  name,
}: {
  disabled: boolean;
  label: string;
  onPress: () => void;
  name: string;
}) {
  return (
    <Pressable
      accessibilityLabel={name}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.step,
        disabled && styles.stepDisabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.stepText}>{label}</Text>
    </Pressable>
  );
}

export interface ReachPanelProps {
  tool: ReachToolResult;
}

export default function ReachPanel({ tool }: ReachPanelProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const resetSettings = useGameStore((state) => state.resetReachSettings);
  const { settings, setSettings, analysis, focus, focusReading } = tool;

  if (!tool.active) return null;

  const showingAll = settings.maxMoves === 0;
  const rangeLabel = showingAll ? 'ALL' : `${settings.maxMoves} MOVE${settings.maxMoves === 1 ? '' : 'S'}`;

  return (
    <>
      <View style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.title}>REACH</Text>
          <Pressable
            accessibilityLabel="Reach settings"
            accessibilityRole="button"
            onPress={() => setSettingsOpen(true)}
            style={({ pressed }) => [styles.more, pressed && styles.pressed]}
          >
            <Text style={styles.moreText}>SETTINGS ▸</Text>
          </Pressable>
        </View>

        <View style={styles.views}>
          {REACH_VIEWS.map((view: ReachView) => {
            const selected = settings.view === view;
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                key={view}
                onPress={() => setSettings({ view })}
                style={({ pressed }) => [
                  styles.viewChip,
                  selected && styles.viewChipOn,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.viewChipText, selected && styles.viewChipTextOn]}>
                  {REACH_VIEW_LABELS[view]}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.rangeRow}>
          <StepButton
            disabled={showingAll || settings.maxMoves <= 1}
            label="−"
            name="Fewer moves"
            onPress={() => setSettings({ maxMoves: Math.max(1, settings.maxMoves - 1) })}
          />
          <Text style={styles.rangeLabel}>{rangeLabel}</Text>
          <StepButton
            disabled={showingAll || settings.maxMoves >= MAX_MOVES}
            label="+"
            name="More moves"
            onPress={() => setSettings({ maxMoves: Math.min(MAX_MOVES, settings.maxMoves + 1) })}
          />
          <TogglePill
            checked={showingAll}
            label="NO LIMIT"
            onPress={() => setSettings({ maxMoves: showingAll ? 4 : 0 })}
          />
        </View>

        <View style={styles.pills}>
          <TogglePill
            checked={settings.showNumbers}
            label="NUMBERS"
            onPress={() => setSettings({ showNumbers: !settings.showNumbers })}
          />
          <TogglePill
            checked={settings.showDanger}
            label="DANGER"
            onPress={() => setSettings({ showDanger: !settings.showDanger })}
          />
          <TogglePill
            checked={settings.showPath}
            label="RUN"
            onPress={() => setSettings({ showPath: !settings.showPath })}
          />
          <TogglePill
            checked={settings.pinned}
            label="PIN"
            onPress={() => setSettings({ pinned: !settings.pinned })}
          />
        </View>

        <ReachLegend focusColor={focus?.owner ?? null} settings={settings} />

        <Text style={styles.hint}>
          {settings.placingGhost
            ? 'Tap a square to put the ghost piece on it.'
            : settings.pinned
              ? 'Pinned. Unpin to follow the board again.'
              : 'Tap a piece to measure it.'}
        </Text>
      </View>

      <ReachSummary
        analysis={analysis}
        focusReading={focusReading}
        onFocus={(square) => setSettings({ focus: square, ghost: null })}
        settings={settings}
      />

      <ReachSettingsModal
        onChange={setSettings}
        onClose={() => setSettingsOpen(false)}
        onReset={resetSettings}
        settings={settings}
        visible={settingsOpen}
      />
    </>
  );
}

const styles = themedSheet(() => ({
  card: {
    width: '100%',
    gap: space.snug,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.textFaint, fontSize: 7, fontWeight: '900', letterSpacing: 1.1 },
  more: { paddingVertical: 1, paddingHorizontal: 2 },
  moreText: { color: colors.accentText, fontSize: 8, fontWeight: '900', letterSpacing: 0.7 },

  views: { flexDirection: 'row', flexWrap: 'wrap', gap: 3 },
  viewChip: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceSunken,
  },
  viewChipOn: { borderColor: colors.accentBorder, backgroundColor: colors.accentSurfaceRaised },
  viewChipText: { color: colors.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 0.6 },
  viewChipTextOn: { color: colors.accentTextStrong },

  rangeRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  rangeLabel: {
    minWidth: 54,
    textAlign: 'center',
    color: colors.text,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  step: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceSunken,
  },
  stepDisabled: { opacity: 0.35 },
  stepText: { color: colors.textSoft, fontSize: 12, fontWeight: '900', lineHeight: 14 },

  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 3 },
  pill: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceSunken,
  },
  pillOn: { borderColor: colors.accentBorder, backgroundColor: colors.accentSurface },
  pillText: { color: colors.textFaint, fontSize: 7, fontWeight: '900', letterSpacing: 0.6 },
  pillTextOn: { color: colors.accentSoft },

  hint: { color: colors.textFaint, fontSize: 8, lineHeight: 12 },
  pressed: { opacity: 0.7 },
}));
