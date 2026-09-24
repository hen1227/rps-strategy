import { failureMessage } from '@/errors';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import DiscordSignInButton from './DiscordSignInButton';
import { Banner, LabeledInput, Panel, PrimaryButton, SectionHeading } from '@/ui/primitives';
import { useGameStore } from '@/store/gameStore';
import { colors, themedSheet } from '@/theme';

// Getting into an account.
//
// Discord is the only way to make one, so it leads and it is the only thing
// most people will ever see here. Underneath, folded away, is the password form
// for accounts that predate the change — kept because those players still have
// to be able to get in, and folded because offering it alongside would suggest
// it is a choice somebody new could make.

export default function AccountSignInPanel() {
  const signIn = useGameStore((state) => state.signIn);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
      setPassword('');
    } catch (caught) {
      setError(failureMessage(caught, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel tone="accent">
      <SectionHeading eyebrow="ACCOUNT" title="Sign in with Discord" />
      <View style={styles.discordAction}>
        <DiscordSignInButton />
      </View>

      {showPasswordForm ? (
        <View style={styles.legacy}>
          <SectionHeading eyebrow="OLDER ACCOUNTS" title="Sign in with a password" />
          <Text style={styles.help}>
            For older accounts. Sign in once, then link Discord.
          </Text>
          {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
          <LabeledInput
            autoCapitalize="none"
            autoCorrect={false}
            label="USERNAME"
            onChangeText={setUsername}
            placeholder="Your username"
            value={username}
          />
          <LabeledInput
            autoCapitalize="none"
            autoCorrect={false}
            label="PASSWORD"
            onChangeText={setPassword}
            secureTextEntry
            value={password}
          />
          <View style={styles.actions}>
            <PrimaryButton
              disabled={busy || !username.trim() || !password}
              label="SIGN IN"
              loading={busy}
              onPress={submit}
            />
          </View>
        </View>
      ) : (
        // A footnote rather than a second button. Everyone it is for already
        // knows they have a password; anybody else reading this panel should
        // see one way in, not a choice between two.
        <Pressable
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => setShowPasswordForm(true)}
          style={({ pressed }) => [styles.legacyLink, pressed && styles.legacyLinkPressed]}
        >
          <Text style={styles.legacyLinkText}>Sign in with a password</Text>
        </Pressable>
      )}
    </Panel>
  );
}

const styles = themedSheet(() => ({
  help: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },
  discordAction: { marginTop: 14 },
  legacyLink: { alignSelf: 'center', marginTop: 16, paddingVertical: 2 },
  legacyLinkPressed: { opacity: 0.7 },
  // Muted and small, but not dimmer than that: it is still the only door left
  // for the accounts that need it, and it has to stay readable.
  legacyLinkText: {
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 14,
    textDecorationLine: 'underline',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
  },
  legacy: { marginTop: 18 },
}));
