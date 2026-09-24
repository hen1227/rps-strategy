import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, themedSheet, type } from '@/theme';
import { Banner } from '@/ui/primitives';

import ReportDialog from './ReportDialog';
import { useBlocking } from './useBlocking';

// Report and block, on somebody's player page.
//
// The other half of ChatMessageActions, and the reason there are two: a chat
// sheet reports *a message* and this reports *a person*. Somebody who met an
// offensive username on the leaderboard has no message to point at, and a page
// that only offered reporting from inside a game would leave them with nowhere
// to go.
//
// Nothing is shown on your own page, and nothing is shown for a bot: an engine
// does not type, cannot be reported for what it said, and blocking one would
// only stop you challenging it — which the page already lets you not do.

export interface PlayerModerationRowProps {
  userId: string;
  username: string;
  /** Bots get nothing here. See the note above. */
  isBot?: boolean;
}

export default function PlayerModerationRow({
  userId,
  username,
  isBot,
}: PlayerModerationRowProps) {
  const accountId = useGameStore((state) => state.accountId);
  const [reporting, setReporting] = useState(false);
  const blocking = useBlocking();

  if (isBot || !userId || userId === accountId) return null;

  const blocked = blocking.isBlocked(userId);

  return (
    <View style={styles.root}>
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel={`Report ${username}`}
          accessibilityRole="button"
          onPress={() => setReporting(true)}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <Text style={styles.buttonText}>REPORT</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={blocked ? `Unblock ${username}` : `Block ${username}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: blocking.busy }}
          disabled={blocking.busy}
          onPress={() =>
            blocked ? blocking.unblock(userId) : blocking.block({ userId, username })
          }
          style={({ pressed }) => [
            styles.button,
            blocked && styles.buttonActive,
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.buttonText, blocked && styles.buttonTextActive]}>
            {blocked ? 'BLOCKED' : 'BLOCK'}
          </Text>
        </Pressable>
      </View>

      {blocked && (
        <Text style={styles.note}>
          You do not see each other's messages, and neither of you can challenge the
          other.
        </Text>
      )}
      <Banner message={blocking.error} onDismiss={blocking.clearError} tone="error" />

      {/*
        No preselected reason, even though this page is where an offensive
        username gets reported from. Guessing on somebody's behalf is how the
        queue fills with reports filed under whatever the surface assumed — and
        the person pressing REPORT here may just as well be reporting what was
        said in a game.
      */}
      <ReportDialog
        onClose={() => setReporting(false)}
        targetName={username}
        targetUserId={userId}
        visible={reporting}
      />
    </View>
  );
}

const styles = themedSheet(() => ({
  root: { marginTop: space.small },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.snug },
  button: {
    paddingVertical: 5,
    paddingHorizontal: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.border,
  },
  // A block already in force reads as a state rather than as another button to
  // press, so it wears the danger frame instead of the neutral one.
  buttonActive: { borderColor: colors.dangerBorder, backgroundColor: colors.dangerSurfaceQuiet },
  buttonText: { ...type.label, color: colors.textMuted },
  buttonTextActive: { color: colors.dangerText },
  note: { ...type.meta, color: colors.textFaint, marginTop: space.tight },
  pressed: { opacity: 0.7 },
}));
