import { useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useEffect, useRef } from 'react';

import { colors, radius, space, type } from '@/theme';
import type { ToolStep as Step } from './agent/events';
import { TOOL_LABELS } from './agent/toolLabels';

// One thing the agent did, as a line you can read at a glance.
//
// The ordering here is the whole design. What a person wants is the *effect* —
// "Edited the rules", "board 9×9 → 7×7" — so that leads. The tool's name is
// present but small, because a demo of a page that hands an agent real tools has
// to show the tools being real, and because when something goes wrong the name
// is the first thing you need. The arguments and the full answer are one tap
// away and never in the way.

export interface ToolStepProps {
  step: Step;
  /** An external step is somebody else's agent, and says so. */
  external?: boolean;
}

const GLYPH: Record<Step['status'], string> = {
  pending: '◇',
  running: '◈',
  ok: '✓',
  failed: '×',
  rejected: '×',
  stopped: '·',
};

const toneOf = (status: Step['status']) => {
  if (status === 'ok') return colors.accentText;
  if (status === 'failed' || status === 'rejected') return colors.dangerSoft;
  if (status === 'running') return colors.accentBright;
  return colors.textFaint;
};

/** A quiet pulse while a step is in flight, so a slow tool does not read as a hang. */
function Pulse({ children }: { children: string }) {
  const value = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 1, duration: 620, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(value, { toValue: 0.35, duration: 620, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [value]);
  return (
    <Animated.Text style={[styles.glyph, { color: colors.accentBright, opacity: value }]}>
      {children}
    </Animated.Text>
  );
}

const elapsed = (step: Step) => {
  if (step.startedAtMs === null || step.endedAtMs === null) return null;
  const seconds = (step.endedAtMs - step.startedAtMs) / 1000;
  if (seconds < 0.1) return null;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
};

export default function ToolStep({ step, external = false }: ToolStepProps) {
  const [open, setOpen] = useState(false);
  const label = TOOL_LABELS[step.tool]?.label ?? step.tool.replace(/^lab_/, '').replace(/_/g, ' ');
  const time = elapsed(step);
  const detail =
    step.detail === null || step.detail === undefined
      ? ''
      : typeof step.detail === 'string'
        ? step.detail
        : JSON.stringify(step.detail, null, 2);

  return (
    <View style={styles.row}>
      <View style={styles.gutter}>
        {step.status === 'running' ? (
          <Pulse>{GLYPH.running}</Pulse>
        ) : (
          <Text style={[styles.glyph, { color: toneOf(step.status) }]}>{GLYPH[step.status]}</Text>
        )}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}. ${step.summary ?? 'running'}. Tap for detail.`}
        onPress={() => setOpen((was) => !was)}
        style={styles.body}
      >
        <View style={styles.headline}>
          <Text style={styles.label} numberOfLines={1}>
            {label}
          </Text>
          <Text style={styles.tool} numberOfLines={1}>
            {step.tool}
          </Text>
          {time ? <Text style={styles.time}>{time}</Text> : null}
        </View>

        {step.summary ? (
          <Text
            style={[styles.summary, step.status === 'failed' && styles.failed]}
            numberOfLines={open ? undefined : 2}
          >
            {step.summary}
          </Text>
        ) : null}

        {step.changes.length > 0 ? (
          <View style={styles.chips}>
            {step.changes.map((change) => (
              <View
                key={change.label}
                style={[styles.chip, change.kind === 'remove' && styles.chipRemove]}
              >
                <Text
                  style={[styles.chipText, change.kind === 'remove' && styles.chipTextRemove]}
                  numberOfLines={1}
                >
                  {change.label}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {open ? (
          <View style={styles.detail}>
            {external ? <Text style={styles.detailLabel}>FROM YOUR BROWSER’S AGENT</Text> : null}
            <Text style={styles.detailLabel}>SENT</Text>
            <Text style={styles.mono}>
              {step.input ? JSON.stringify(step.input, null, 2) : step.argsText || '{}'}
            </Text>
            {detail ? (
              <>
                <Text style={styles.detailLabel}>ANSWERED</Text>
                {/* The board-touching tools answer with the position drawn in
                    text, which is worth showing exactly as it came back. */}
                <Text style={styles.mono}>{detail}</Text>
              </>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.small, alignItems: 'flex-start' },
  gutter: { width: 14, alignItems: 'center', paddingTop: 1 },
  glyph: { ...type.meta, fontWeight: '900', lineHeight: 16 },
  body: { flex: 1, minWidth: 0, gap: 3, paddingBottom: space.small },
  headline: { flexDirection: 'row', alignItems: 'baseline', gap: space.snug },
  label: { ...type.bodyStrong, color: colors.text, flexShrink: 1, minWidth: 0 },
  tool: { ...type.eyebrow, color: colors.textFaint, fontFamily: 'monospace', letterSpacing: 0 },
  time: { ...type.eyebrow, color: colors.textFaint, marginLeft: 'auto', letterSpacing: 0 },
  summary: { ...type.meta, color: colors.textDim },
  failed: { color: colors.dangerSoft },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.tight, marginTop: 2 },
  chip: {
    backgroundColor: colors.accentSurfaceQuiet,
    borderColor: colors.accentBorder,
    borderWidth: 1,
    borderRadius: radius.small,
    paddingHorizontal: space.snug,
    paddingVertical: 1,
    maxWidth: '100%',
  },
  chipRemove: { backgroundColor: colors.dangerSurfaceQuiet, borderColor: colors.dangerBorder },
  chipText: { ...type.eyebrow, color: colors.accentText, letterSpacing: 0 },
  chipTextRemove: { color: colors.dangerText },
  detail: {
    marginTop: space.snug,
    gap: space.tight,
    backgroundColor: colors.surfaceWell,
    borderRadius: radius.small,
    padding: space.small,
  },
  detailLabel: { ...type.eyebrow, color: colors.textFaint },
  mono: { ...type.meta, color: colors.textSoft, fontFamily: 'monospace' },
});
