import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Banner, PrimaryButton } from '@/ui/primitives';
import { useGameStore } from '@/store/gameStore';
import { colors } from '@/theme';

// The one component that starts a Discord sign-in.
//
// Everything platform-specific is behind the store, which is behind
// `discordAuth`'s two halves — so this renders the same on a phone and in a
// browser, and the only thing it asks is whether signing in is possible at all.
// On the web the press navigates away and nothing after it runs; on a phone a
// sheet opens and the answer comes back here.

interface DiscordSignInButtonProps {
  /** "Create an account" reads wrong on the panel offered to a legacy account. */
  label?: string;
}

export default function DiscordSignInButton({
  label = 'CONTINUE WITH DISCORD',
}: DiscordSignInButtonProps) {
  const available = useGameStore((state) => state.discordSignInAvailable);
  const signInWithDiscord = useGameStore((state) => state.signInWithDiscord);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A build that cannot open a browser should not offer a button that does
  // nothing. Screens ask this rather than which platform they are on.
  if (!available) {
    return (
      <Text style={styles.unavailable}>
        This version of the app cannot sign in with Discord. Updating from the App Store will
        fix it.
      </Text>
    );
  }

  const press = async () => {
    setBusy(true);
    setError(null);
    const outcome = await signInWithDiscord();
    // 'pending' is the web redirect already under way, so leaving the button
    // spinning is right: this page is going away.
    if (outcome.kind !== 'pending') setBusy(false);
    if (outcome.kind === 'failed') setError(outcome.message);
  };

  return (
    <View>
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
      <PrimaryButton disabled={busy} label={label} loading={busy} onPress={press} />
    </View>
  );
}

const styles = StyleSheet.create({
  unavailable: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 8 },
});
