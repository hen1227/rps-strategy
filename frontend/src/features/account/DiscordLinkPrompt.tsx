import { StyleSheet, Text } from 'react-native';

import DiscordSignInButton from './DiscordSignInButton';
import { Panel, SectionHeading } from '@/ui/primitives';
import { colors } from '@/theme';

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

export default function DiscordLinkPrompt() {
  return (
    <Panel tone="accent">
      <SectionHeading eyebrow="ACTION NEEDED" title="Link your Discord" />
      <Text style={styles.help}>
        This account still signs in with a password. Link your Discord and you will not need one
        any more — your username, rating and games all stay exactly as they are.
      </Text>
      <DiscordSignInButton label="LINK DISCORD" />
    </Panel>
  );
}

const styles = StyleSheet.create({
  help: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8, marginBottom: 6 },
});
