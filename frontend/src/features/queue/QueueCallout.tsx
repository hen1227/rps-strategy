import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import { useGameStore } from '@/store/gameStore';
import { usePushStore } from '@/store/push';
import { ALERTS_PITCH, CLAIM_WINDOW_MS, QUEUE_COPY, type QueueCall } from '@/store/queueSelectors';
import { colors, radius, space, type } from '@/theme';
import { GhostButton, PrimaryButton } from '@/ui/primitives';

// The queue, following you.
//
// Waiting for a game used to be a spinner on a card you had to stay and watch.
// It is now something that happens in the background, so it needs a place that
// is always the same and always visible — one card, pinned to the bottom of
// every screen, that answers "what am I waiting on" wherever you have wandered
// to in the meantime.
//
// It is deliberately the same card as the tournament call-out rather than a new
// invention: a player should not have to learn two shapes for "something down
// here wants your attention".

export default function QueueCallout({ call }: { call: QueueCall }) {
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const leaveQueue = useGameStore((state) => state.leaveQueue);
  const cancelChallenge = useGameStore((state) => state.cancelChallenge);
  const claimMatch = useGameStore((state) => state.claimMatch);
  const declineMatch = useGameStore((state) => state.declineMatch);
  const sessionToken = useGameStore((state) => state.sessionToken);
  const enablePush = usePushStore((state) => state.enable);
  const snoozeOffer = usePushStore((state) => state.snoozeOffer);

  const copy = QUEUE_COPY[call.kind];
  const isClaim = call.kind === 'claiming';
  const isHolding = call.kind === 'holding';
  const isPaused = call.kind === 'reconnecting';
  const urgent = (isClaim || isHolding) && call.critical;

  return (
    <View style={[styles.card, isClaim && styles.cardClaim, urgent && styles.cardUrgent]}>
      {isClaim || isHolding ? (
        <Countdown
          critical={call.critical}
          pendingId={call.pendingId}
          remainingMs={call.remainingMs}
        />
      ) : null}
      <View style={styles.row}>
        <View
          style={[
            styles.pulse,
            isClaim && styles.pulseClaim,
            urgent && styles.pulseUrgent,
            isPaused && styles.pulsePaused,
          ]}
        />
        <View style={styles.copy}>
          <Text numberOfLines={2} style={styles.title}>
            {copy.title(call)}
          </Text>
          <Text numberOfLines={2} style={styles.detail}>
            {copy.detail(call)}
          </Text>
        </View>
        {isClaim ? (
          <View style={styles.actions}>
            <GhostButton
              accessibilityLabel="Give up this match so your opponent can find another"
              compact
              label={copy.secondary ?? 'NOT NOW'}
              onPress={declineMatch}
            />
            <PrimaryButton
              accessibilityLabel={`Take your seat against ${call.opponentName ?? 'your opponent'}`}
              compact
              disabled={connectionStatus !== 'connected'}
              label={copy.action}
              loading={call.busy}
              onPress={claimMatch}
            />
          </View>
        ) : (
          <GhostButton
            accessibilityLabel={
              call.kind === 'posted' ? 'Take your game off the board' : 'Leave the queue'
            }
            compact
            label={copy.action}
            onPress={() =>
              call.kind === 'posted' && call.challengeId
                ? cancelChallenge(call.challengeId)
                : leaveQueue()
            }
          />
        )}
      </View>

      {/*
        The offer, at the one moment it is obviously in the player's interest:
        they are staring at a wait and would rather be doing something else. It
        is never made on load, never made twice after a dismissal, and never
        made at all once the answer is settled either way.
      */}
      {call.offerAlerts ? (
        <View style={styles.pitch}>
          <Text style={styles.pitchLine}>{ALERTS_PITCH.line}</Text>
          <PrimaryButton
            accessibilityLabel="Turn on match alerts so you can close this tab"
            compact
            label={ALERTS_PITCH.action}
            onPress={() => {
              // Called straight from the press handler with nothing awaited
              // first: iOS shows the permission prompt only while the gesture
              // that asked for it is still live.
              void enablePush(sessionToken ?? null);
            }}
            tone="quiet"
          />
          <Pressable
            accessibilityLabel={ALERTS_PITCH.dismissLabel}
            accessibilityRole="button"
            onPress={snoozeOffer}
            style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
          >
            <Text style={styles.dismissMark}>✕</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/**
 * A hairline draining along the top of the card.
 *
 * It animates itself from the time remaining rather than being redrawn on every
 * tick, because a hidden tab throttles timers to about a frame a second and a
 * countdown that stutters is a countdown nobody believes. `width` is not a
 * transform, so the native driver is unavailable — acceptable for one hairline
 * moving while nothing else on screen does.
 */
function Countdown({
  critical,
  pendingId,
  remainingMs,
}: {
  critical: boolean;
  pendingId: string | null;
  remainingMs: number;
}) {
  const progress = useRef(new Animated.Value(1)).current;
  // Read through a ref so a new hold restarts the animation but a passing tick
  // does not, which would make the bar jump backwards instead of running down.
  const remaining = useRef(remainingMs);
  remaining.current = remainingMs;

  useEffect(() => {
    const left = remaining.current;
    progress.setValue(Math.max(0, Math.min(1, left / CLAIM_WINDOW_MS)));
    const animation = Animated.timing(progress, {
      toValue: 0,
      duration: Math.max(0, left),
      easing: Easing.linear,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [pendingId, progress]);

  return (
    <View style={styles.countdownTrack}>
      <Animated.View
        style={[
          styles.countdownFill,
          critical && styles.countdownFillCritical,
          { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    maxWidth: 620,
    overflow: 'hidden',
    padding: space.medium,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurfaceQuiet,
    // Keeps the bar readable over the board on web and native alike.
    shadowColor: colors.surfaceDeep,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  cardClaim: { borderColor: colors.accentBright, backgroundColor: colors.accentSurfaceRaised },
  cardUrgent: { borderColor: colors.dangerBorder },

  row: { flexDirection: 'row', alignItems: 'center', gap: space.medium },
  pulse: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accentSoft },
  pulseClaim: { backgroundColor: colors.accentBright },
  pulseUrgent: { backgroundColor: colors.danger },
  pulsePaused: { backgroundColor: colors.textFaint },
  copy: { flex: 1 },
  title: { ...type.rowTitle, color: colors.textStrong, fontWeight: '900' },
  detail: { ...type.meta, color: colors.textMuted, marginTop: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.snug },

  countdownTrack: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: colors.borderStrong,
  },
  countdownFill: { height: 2, backgroundColor: colors.accentBright },
  countdownFillCritical: { backgroundColor: colors.danger },

  pitch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    marginTop: space.small,
    paddingTop: space.small,
    borderTopWidth: 1,
    borderTopColor: colors.accentBorder,
  },
  pitchLine: { ...type.meta, flex: 1, color: colors.textMuted },
  dismiss: { paddingHorizontal: space.tight, paddingVertical: space.hair },
  dismissMark: { ...type.meta, color: colors.textFaint },
  pressed: { opacity: 0.7 },
});
