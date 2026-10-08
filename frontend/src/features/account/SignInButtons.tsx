import { View } from 'react-native';

import AppleSignInButton from './AppleSignInButton';
import DiscordSignInButton from './DiscordSignInButton';
import { themedSheet } from '@/theme';

// The ways in, one above the other, each the full width of the panel: Discord,
// and Apple under it wherever this build and this server can offer Apple.
// Drawn as equals on purpose — Apple's guidelines ask that its button be no
// smaller than any other sign-in button, and neither is a lesser way in.

interface SignInButtonsProps {
  /** For the prompts that link rather than sign in. */
  discordLabel?: string;
}

export default function SignInButtons({ discordLabel }: SignInButtonsProps) {
  return (
    <View style={styles.stack}>
      <DiscordSignInButton label={discordLabel} />
      <AppleSignInButton />
    </View>
  );
}

const styles = themedSheet(() => ({
  stack: { width: '100%', gap: 10 },
}));
