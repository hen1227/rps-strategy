import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { failureMessage } from '@/errors';
import { deleteOwnAccount } from '@/store/api/moderation';
import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, themedSheet, type } from '@/theme';
import ModalCard from '@/ui/ModalCard';
import { Banner, LabeledInput, PrimaryButton } from '@/ui/primitives';
import type { Account } from '@/types/protocol';

// Deleting your own account, from the account screen.
//
// It used to be a sentence in the privacy policy asking people to message the
// host on Discord. That is a real answer and it is not one anybody can rely on:
// it needs the host awake, it needs the player to have Discord, and it makes a
// right conditional on a favour.
//
// # What the dialog has to say
//
// Deletion here is not total, and the dialog says so before the button rather
// than in a policy page nobody opens. An account that has played keeps its
// games, with the name stripped out of every copy of them including the stored
// PGN — because a game belongs to two people, and erasing one player's copy of
// a shared result would rewrite the other player's history and rating with it.
// An account that never played is removed outright.
//
// Saying that plainly is the point. A deletion that quietly keeps something is
// worse than one that tells you what it keeps.

export interface DeleteAccountPanelProps {
  account: Account | null | undefined;
  /** Where to send the player once there is no account left to be on. */
  onDeleted: () => void;
}

export default function DeleteAccountPanel({ account, onDeleted }: DeleteAccountPanelProps) {
  const accountId = useGameStore((state) => state.accountId);
  const sessionToken = useGameStore((state) => state.sessionToken);
  const profileKey = useGameStore((state) => state.profileKey);

  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const username = account?.username?.trim() ?? '';
  // A session when there is one, and the browser's own key otherwise. A guest
  // owns an account too — it holds their games and the name their opponents
  // saw — and "sign up before you may delete the account you already have" is
  // not an answer.
  const credential = sessionToken || profileKey;
  const typedCorrectly = confirm.trim().toLowerCase() === username.toLowerCase();
  const hasPlayed = (account?.gamesPlayed ?? 0) > 0;

  const remove = async () => {
    if (!credential || !typedCorrectly) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteOwnAccount(credential, account?.userId ?? accountId, confirm.trim());
      setOpen(false);
      onDeleted();
    } catch (requestError) {
      setError(failureMessage(requestError));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <View style={styles.panel}>
      <Text style={styles.eyebrow}>PERMANENT</Text>
      <Text style={styles.title}>Delete your account</Text>
      <Text style={styles.copy}>
        {hasPlayed
          ? 'Your account details are permanently removed. Finished games stay with your name removed.'
          : 'You have no finished games. Your account will be permanently deleted.'}
      </Text>

      <View style={styles.action}>
        <Pressable
          accessibilityLabel="Delete your account"
          accessibilityRole="button"
          onPress={() => {
            setConfirm('');
            setError(null);
            setOpen(true);
          }}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <Text style={styles.buttonText}>DELETE ACCOUNT</Text>
        </Pressable>
      </View>

      <ModalCard
        eyebrow="THIS CANNOT BE UNDONE"
        maxWidth={460}
        onClose={() => setOpen(false)}
        title="Delete your account?"
        visible={open}
      >
        <Text style={styles.dialogBody}>What goes, immediately and for good:</Text>
        <View style={styles.bullets}>
          {[
            'Your username and your Discord link.',
            "Your titles and leaderboard entry.",
            "Your sign-in. This account cannot be recovered.",
            'Any bots you own are retired and stop playing.',
          ].map((line) => (
            <View key={line} style={styles.bulletRow}>
              <Text style={styles.bulletMark}>◆</Text>
              <Text style={styles.bulletText}>{line}</Text>
            </View>
          ))}
        </View>

        {hasPlayed && (
          <>
            <Text style={styles.dialogBody}>What stays, and why:</Text>
            <View style={styles.bullets}>
              <View style={styles.bulletRow}>
                <Text style={styles.bulletMark}>◆</Text>
                <Text style={styles.bulletText}>
                  Finished games stay in the archive under “Deleted player” to preserve your opponents’ records and ratings.
                </Text>
              </View>
            </View>
          </>
        )}

        <LabeledInput
          autoCapitalize="none"
          autoCorrect={false}
          hint={`Type ${username || 'your username'} to confirm.`}
          label="CONFIRM"
          onChangeText={setConfirm}
          placeholder={username || 'your username'}
          value={confirm}
        />

        <Banner message={error} onDismiss={() => setError(null)} tone="error" />

        <View style={styles.dialogActions}>
          <Pressable
            accessibilityLabel="Keep my account"
            accessibilityRole="button"
            onPress={() => setOpen(false)}
            style={({ pressed }) => [styles.keepButton, pressed && styles.pressed]}
          >
            <Text style={styles.keepButtonText}>KEEP MY ACCOUNT</Text>
          </Pressable>
          <PrimaryButton
            accessibilityLabel="Permanently delete this account"
            disabled={!typedCorrectly || deleting}
            label="DELETE FOR GOOD"
            loading={deleting}
            onPress={remove}
            tone="quiet"
          />
        </View>
      </ModalCard>
    </View>
  );
}

const styles = themedSheet(() => ({
  // Its own frame rather than a Panel, because it is the one thing on this
  // screen that should not read as another setting in the stack.
  panel: {
    padding: space.medium,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurfaceQuiet,
  },
  eyebrow: { ...type.eyebrow, color: colors.dangerSoft },
  title: { ...type.cardTitle, color: colors.textStrong, marginTop: space.tight },
  copy: { ...type.body, color: colors.textMuted, marginTop: space.small },
  action: { flexDirection: 'row', marginTop: space.medium },
  button: {
    paddingVertical: space.snug,
    paddingHorizontal: space.medium,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurface,
  },
  buttonText: { ...type.label, color: colors.dangerText },

  dialogBody: { ...type.body, color: colors.text, marginTop: space.medium },
  bullets: { gap: space.tight, marginTop: space.small },
  bulletRow: { flexDirection: 'row', gap: space.small },
  bulletMark: { color: colors.dangerSoft, fontSize: 9, lineHeight: 17 },
  bulletText: { ...type.body, flex: 1, color: colors.textMuted },
  dialogActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space.small,
    marginTop: space.medium,
  },
  keepButton: {
    paddingVertical: space.snug,
    paddingHorizontal: space.medium,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  keepButtonText: { ...type.label, color: colors.text },
  pressed: { opacity: 0.7 },
}));
