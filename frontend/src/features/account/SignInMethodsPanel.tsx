import { Text, View } from 'react-native';

import AppleSignInButton from './AppleSignInButton';
import DiscordSignInButton from './DiscordSignInButton';
import { Badge, Panel, SectionHeading } from '@/ui/primitives';
import { useAppleOffered } from '@/hooks/useSignInProviders';
import type { SignInMethods } from '@/store/api/bots';
import { useGameStore } from '@/store/gameStore';
import { colors, radius, themedSheet } from '@/theme';

// Which ways in this account has, and the button for the one it is missing.
//
// The reason linking exists: somebody who signed up with Apple on the phone and
// then presses Discord on the website gets a second account, unless both are
// linked to one. A provider already linked is a line saying so; one that is not
// is that provider's own button, which from a signed-in session links rather
// than signs in. Linking Apple to an account somebody else's Apple ID already
// opens is refused by the server, and its refusal says what to do instead.
//
// Nothing here for a store review account, which the server refuses every link,
// or for a password account still waiting to link, whose prompt at the top of
// the screen already is this. And on the Account screen, nothing when there is
// nothing to add and only one way in to list — a panel that only repeats the
// profile above it. The sign-in screen's last step passes `always`, because
// there the list is the answer to "what did that just do".

interface SignInMethodsPanelProps {
  /** The owner's own answer from the server; null until it has come. */
  methods: SignInMethods | null;
  /** Show the list even when it has one line and nothing to add. */
  always?: boolean;
}

export default function SignInMethodsPanel({ methods, always = false }: SignInMethodsPanelProps) {
  const discordAvailable = useGameStore((state) => state.discordSignInAvailable);
  const appleOffered = useAppleOffered();

  if (!methods || methods.canLink === false || methods.awaitingLink) return null;
  const linked = new Set(methods.methods);
  const rows = [
    { id: 'discord', name: 'Discord', linked: linked.has('discord'), offered: discordAvailable },
    { id: 'apple', name: 'Apple', linked: linked.has('apple'), offered: appleOffered !== false },
  ].filter((row) => row.linked || row.offered);
  const addable = rows.some((row) => !row.linked);
  if (!always && !addable && rows.length < 2) return null;

  return (
    <Panel>
      <SectionHeading eyebrow="SIGN-IN" title="Ways to sign in" />
      {addable ? <Text style={styles.helper}>Link both to sign in with either.</Text> : null}
      <View style={styles.rows}>
        {rows.map((row) =>
          row.linked ? (
            <View key={row.id} style={styles.linkedRow}>
              <Text style={styles.name}>{row.name}</Text>
              <Badge label="LINKED" tone="neutral" />
            </View>
          ) : row.id === 'discord' ? (
            <DiscordSignInButton key={row.id} label="LINK DISCORD" />
          ) : (
            <AppleSignInButton key={row.id} />
          ),
        )}
      </View>
    </Panel>
  );
}

const styles = themedSheet(() => ({
  helper: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },
  rows: { gap: 10, marginTop: 14 },
  linkedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 42,
    paddingHorizontal: 12,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceMuted,
  },
  name: { color: colors.text, fontSize: 13, fontWeight: '900' },
}));
