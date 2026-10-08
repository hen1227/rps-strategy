import { Text } from 'react-native';

import SignInButtons from './SignInButtons';
import { Panel, SectionHeading } from '@/ui/primitives';
import { useAppleOffered } from '@/hooks/useSignInProviders';
import { colors, themedSheet } from '@/theme';

// The nudge shown to an account that still signs in with a password.
//
// Persistent, with no dismiss and no snooze. That is deliberate: passwords are
// being retired, and this is the only thing telling the people who still have
// one that they need to act. A prompt that can be dismissed is a prompt that
// will be, months before the password stops working.
//
// It is a panel rather than a modal, so it blocks nothing. Nobody is locked out
// of anything for ignoring it — until the password route is finally removed,
// which is the day this component and its reason both go.
//
// Either provider will do. Linking one retires the password, and the other can
// be added afterwards from the same screen.

export default function LinkSignInPrompt() {
  const appleOffered = useAppleOffered();
  return (
    <Panel tone="accent">
      <SectionHeading
        eyebrow="ACTION NEEDED"
        title={appleOffered ? 'Link Discord or Apple' : 'Link your Discord'}
      />
      <Text style={styles.help}>
        {appleOffered ? 'Link one' : 'Link Discord'} to sign in without a password. Keep your
        username, rating, and games.
      </Text>
      <SignInButtons discordLabel="LINK DISCORD" />
    </Panel>
  );
}

const styles = themedSheet(() => ({
  help: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8, marginBottom: 6 },
}));
