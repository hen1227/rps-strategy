import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Banner, PrimaryButton } from '@/ui/primitives';
import { useGameStore } from '@/store/gameStore';
import { colors, themedSheet } from '@/theme';

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
        Update the app from the App Store to sign in with Discord.
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

  // Discord's own colour and the full width of whatever it is dropped into.
  // This is the front door — on the sign-in panel it is the only way in — so it
  // is not a button sized to its label sitting in a row of equals.
  return (
    <View style={styles.wrapper}>
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
      <PrimaryButton
        disabled={busy}
        fullWidth
        label={label}
        loading={busy}
        onPress={press}
        tone="discord"
      />
    </View>
  );
}

const styles = themedSheet(() => ({
  // Carries the fill through a row parent, which stretches neither this nor the
  // button inside it on its own.
  wrapper: { flexGrow: 1, flexBasis: '100%' },
  unavailable: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 8 },
}));
