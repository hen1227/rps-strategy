import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useGameStore } from '@/store/gameStore';
import { usePushStore } from '@/store/push';
import { ALERTS_PITCH, QUEUE_COPY, type QueueCall } from '@/store/queueSelectors';
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
//
// It says nothing about being matched, because being matched is no longer a
// state you sit in. Pairing opens the board, and the board takes the screen.

export default function QueueCallout({ call }: { call: QueueCall }) {
  const leaveQueue = useGameStore((state) => state.leaveQueue);
  const cancelChallenge = useGameStore((state) => state.cancelChallenge);
  const sessionToken = useGameStore((state) => state.sessionToken);
  const enablePush = usePushStore((state) => state.enable);
  const snoozeOffer = usePushStore((state) => state.snoozeOffer);

  const copy = QUEUE_COPY[call.kind];
  const isPaused = call.kind === 'reconnecting';

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={[styles.pulse, isPaused && styles.pulsePaused]} />
        <View style={styles.copy}>
          <Text numberOfLines={2} style={styles.title}>
            {copy.title(call)}
          </Text>
          <Text numberOfLines={2} style={styles.detail}>
            {copy.detail(call)}
          </Text>
        </View>
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

  row: { flexDirection: 'row', alignItems: 'center', gap: space.medium },
  pulse: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accentSoft },
  pulsePaused: { backgroundColor: colors.textFaint },
  copy: { flex: 1 },
  title: { ...type.rowTitle, color: colors.textStrong, fontWeight: '900' },
  detail: { ...type.meta, color: colors.textMuted, marginTop: 2 },

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
