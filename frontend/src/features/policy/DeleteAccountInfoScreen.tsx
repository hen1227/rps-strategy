import { Text, View } from 'react-native';

import { DELETING_YOUR_ACCOUNT } from './PolicyScreen';
import { links } from '@/navigation/links';
import { up } from '@/navigation/upFrom';
import { colors, contentWidth, space, themedSheet } from '@/theme';
import BackLink from '@/ui/BackLink';
import ScreenShell from '@/ui/ScreenShell';
import { GhostLink, Panel, SectionHeading } from '@/ui/primitives';

// The address the Google Play listing gives for deleting an account.
//
// Play asks that page to name the app and its developer, to put the steps
// first, and to say what is deleted and what is kept, for somebody who may no
// longer have the app at all. The policy says all of that in its tenth section,
// so this shows the one section on its own, from the same data, so the two can
// never disagree.

export default function DeleteAccountInfoScreen() {
  return (
    <ScreenShell width={contentWidth.reading}>
      <BackLink href={up.deleteAccount.href} label={up.deleteAccount.label} />

      <View style={styles.hero}>
        <Text style={styles.eyebrow}>RPS STRATEGY</Text>
        <Text style={styles.title}>Delete your account</Text>
        <Text style={styles.subtitle}>
          RPS Strategy is made by Henry Abrahamsen and run by Henhen1227, LLC.
        </Text>
      </View>

      <Panel>
        <SectionHeading eyebrow={DELETING_YOUR_ACCOUNT.eyebrow} title="How, and what is kept" />
        {DELETING_YOUR_ACCOUNT.paragraphs?.map((paragraph) => (
          <Text key={paragraph} style={styles.body}>
            {paragraph}
          </Text>
        ))}
        <View style={styles.actions}>
          <GhostLink href={links.account()} label="YOUR ACCOUNT" tone="accent" />
          <GhostLink href={links.policy()} label="THE WHOLE POLICY" />
        </View>
      </Panel>
    </ScreenShell>
  );
}

const styles = themedSheet(() => ({
  hero: { paddingBottom: 22 },
  eyebrow: { color: colors.textFaint, fontSize: 10, fontWeight: '900', letterSpacing: 2.1 },
  title: {
    color: colors.textStrong,
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -1,
    marginTop: 5,
  },
  subtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 20, marginTop: 6 },
  body: { color: colors.textMuted, fontSize: 12, lineHeight: 19, marginTop: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.small, marginTop: space.medium },
}));
