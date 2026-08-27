import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, type } from '@/theme';
import ToolStep from './ToolStep';
import type { AgentRun, ChatItem } from './agent/events';

// The conversation, and the agent working inside it.
//
// Modelled on a coding agent's transcript rather than on a chat app, because
// that is what this is: most of what arrives is not prose, it is work. So the
// agent's messages are plain text with no bubble around them — the person's own
// are the ones that need marking, since they are the rarer thing — and the tool
// calls hang off a hairline rule as a timeline you can skim.
//
// The one thing this must never do is look idle while something is happening.
// Hence the live status line, the pulse on the running step, and the ticking
// elapsed time: a model thinking for eight seconds with nothing on screen is
// indistinguishable from a model that has crashed.

export interface ChatRailProps {
  items: ChatItem[];
  run: AgentRun | null;
}

/** Ticks while a run is going, so the elapsed time is honest. */
const useTick = (active: boolean) => {
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow((value) => value + 1), 250);
    return () => clearInterval(timer);
  }, [active]);
};

function StatusLine({ run }: { run: AgentRun }) {
  const dot = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(dot, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(dot, { toValue: 0.3, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [dot]);

  const seconds = Math.max(0, Math.round((Date.now() - run.startedAtMs) / 1000));
  return (
    <View style={styles.status}>
      <Animated.View style={[styles.dot, { opacity: dot }]} />
      <Text style={styles.statusText} numberOfLines={1}>
        {run.statusLine || 'Working…'}
      </Text>
      <Text style={styles.statusTime}>{seconds}s</Text>
    </View>
  );
}

/** What a finished run cost, in the only two units anybody reads. */
function RunFooter({ run, steps }: { run: AgentRun; steps: number }) {
  if (run.endedAtMs === null) return null;
  const seconds = Math.max(1, Math.round((run.endedAtMs - run.startedAtMs) / 1000));
  const reason =
    run.stop?.reason === 'stopped'
      ? ' · stopped'
      : run.stop?.reason === 'max-turns'
        ? ' · reached its limit'
        : run.stop?.reason === 'max-wall'
          ? ' · ran out of time'
          : '';
  return (
    <Text style={styles.runFooter}>
      Worked for {seconds}s · {steps} step{steps === 1 ? '' : 's'}
      {reason}
    </Text>
  );
}

export default function ChatRail({ items, run }: ChatRailProps) {
  const scroller = useRef<ScrollView>(null);
  const running = run !== null && run.endedAtMs === null;
  useTick(running);

  // Follow the bottom while work arrives. `useEffect` on the item count rather
  // than on the array: the array is new on every text delta.
  const signature = `${items.length}:${run?.statusLine ?? ''}`;
  useEffect(() => {
    const timer = setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 30);
    return () => clearTimeout(timer);
  }, [signature]);

  const steps = items.filter(
    (item) => item.kind === 'step' && (!run || item.runId === run.id),
  ).length;

  return (
    <ScrollView
      ref={scroller}
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <View key={item.id} style={[styles.you, item.queued && styles.youQueued]}>
                <Text style={styles.youText}>{item.text}</Text>
                {item.queued ? <Text style={styles.queued}>Will send when this finishes</Text> : null}
              </View>
            );

          case 'assistant':
            return item.text ? (
              <Text key={item.id} style={styles.said}>
                {item.text}
              </Text>
            ) : null;

          case 'step':
            return (
              <View key={item.id} style={styles.timeline}>
                <ToolStep step={item.step} />
              </View>
            );

          case 'external':
            return (
              <View key={item.id} style={styles.external}>
                <Text style={styles.externalLabel}>YOUR BROWSER’S AGENT</Text>
                <ToolStep
                  external
                  step={{
                    id: item.step.id,
                    runId: '',
                    turn: 0,
                    tool: item.step.tool,
                    argsText: JSON.stringify(item.step.input ?? {}),
                    input: (item.step.input ?? {}) as Record<string, unknown>,
                    status: item.step.ok ? 'ok' : 'failed',
                    summary: item.step.summary,
                    detail: null,
                    changes: [],
                    startedAtMs: null,
                    endedAtMs: null,
                  }}
                />
              </View>
            );

          case 'human':
            return (
              <View key={item.id} style={styles.human}>
                <Text style={styles.humanLabel}>YOU</Text>
                <View style={styles.humanChanges}>
                  {item.step.changes.map((change) => (
                    <Text key={change.label} style={styles.humanChange}>
                      {change.label}
                    </Text>
                  ))}
                </View>
              </View>
            );

          case 'notice':
            return (
              <View key={item.id} style={styles.notice}>
                <Text style={styles.noticeText}>{item.text}</Text>
              </View>
            );

          default:
            return null;
        }
      })}

      {run ? (running ? <StatusLine run={run} /> : <RunFooter run={run} steps={steps} />) : null}
    </ScrollView>
  );
}

/** The page's own claim about itself, small and at the bottom of the rail. */
export function ToolsPill({ count, detail }: { count: number; detail: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${count} tools are live on document.modelContext. ${detail}`}
      onPress={() => setOpen((was) => !was)}
      style={styles.pill}
    >
      <View style={styles.pillDot} />
      <Text style={styles.pillText} numberOfLines={open ? undefined : 1}>
        {open ? detail : `${count} tool${count === 1 ? '' : 's'} live on document.modelContext`}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  content: { gap: space.medium, padding: space.medium, paddingBottom: space.large },

  you: {
    backgroundColor: colors.surfaceSunken,
    borderLeftColor: colors.accent,
    borderLeftWidth: 2,
    borderRadius: radius.small,
    padding: space.small,
    gap: 2,
  },
  youQueued: { opacity: 0.6, borderLeftColor: colors.borderLight },
  youText: { ...type.body, color: colors.text },
  queued: { ...type.eyebrow, color: colors.textFaint },

  said: { ...type.body, color: colors.textSoft },

  // The timeline: a hairline the steps hang off, so a run of them reads as one
  // piece of work rather than as a stack of unrelated rows.
  timeline: {
    borderLeftColor: colors.borderSoft,
    borderLeftWidth: 1,
    marginLeft: 3,
    paddingLeft: space.small,
    marginBottom: -space.small,
  },

  external: {
    borderLeftColor: colors.goldBorder,
    borderLeftWidth: 1,
    marginLeft: 3,
    paddingLeft: space.small,
    gap: 2,
  },
  externalLabel: { ...type.eyebrow, color: colors.textFaint },

  // The person's own work, on a rule of its own. Deliberately the quietest thing
  // in the rail: it is a record so the agent's reaction has something visible to
  // point back at, not an announcement to somebody about what they just did.
  human: {
    borderLeftColor: colors.accent,
    borderLeftWidth: 1,
    marginLeft: 3,
    paddingLeft: space.small,
    gap: 2,
  },
  humanLabel: { ...type.eyebrow, color: colors.textFaint },
  humanChanges: { flexDirection: 'row', flexWrap: 'wrap', gap: space.tight },
  humanChange: { ...type.meta, color: colors.textDim },

  notice: {
    backgroundColor: colors.dangerSurfaceQuiet,
    borderColor: colors.dangerBorder,
    borderWidth: 1,
    borderRadius: radius.small,
    padding: space.small,
  },
  noticeText: { ...type.meta, color: colors.dangerText },

  status: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  dot: { backgroundColor: colors.accentBright, borderRadius: 4, height: 7, width: 7 },
  statusText: { ...type.meta, color: colors.textMuted, flex: 1, minWidth: 0 },
  statusTime: { ...type.eyebrow, color: colors.textFaint, letterSpacing: 0 },
  runFooter: { ...type.eyebrow, color: colors.textFaint, letterSpacing: 0 },

  pill: { flexDirection: 'row', alignItems: 'center', gap: space.snug, minWidth: 0 },
  pillDot: { backgroundColor: colors.accent, borderRadius: 3, height: 5, width: 5 },
  pillText: { ...type.eyebrow, color: colors.textFaint, letterSpacing: 0, flex: 1, minWidth: 0 },
});
