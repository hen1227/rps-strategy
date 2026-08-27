import { failureMessage } from '@/errors';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import DiscordSignInButton from './DiscordSignInButton';
import { Banner, GhostButton, LabeledInput, Panel, PrimaryButton, SectionHeading } from '@/ui/primitives';
import { useGameStore } from '@/store/gameStore';
import { colors } from '@/theme';

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
      <Text style={styles.help}>
        Everything this browser has already earned comes with you: your rating, your record, and
        every game you have played. Signing in is also what unlocks ranked games.
      </Text>

      <View style={styles.actions}>
        <DiscordSignInButton />
      </View>

      {showPasswordForm ? (
        <View style={styles.legacy}>
          <SectionHeading eyebrow="OLDER ACCOUNTS" title="Sign in with a password" />
          <Text style={styles.help}>
            For accounts made before Discord sign-in. Once you are in, you can link your Discord
            and stop needing this.
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
        <GhostButton
          label="I have an older account with a password"
          onPress={() => setShowPasswordForm(true)}
        />
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  help: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
  },
  legacy: { marginTop: 18 },
});
