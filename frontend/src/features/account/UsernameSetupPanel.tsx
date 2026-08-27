import { failureMessage } from '@/errors';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Banner, GhostButton, LabeledInput, Panel, PrimaryButton, SectionHeading } from '@/ui/primitives';
import { isReservedIn, useIdentityPolicy } from '@/hooks/useIdentityPolicy';
import { useGameStore } from '@/store/gameStore';
import { colors } from '@/theme';

// Choosing the name a brand-new account will hold.
//
// A panel and not a route, which matters more than it looks. Nothing has been
// written to the database yet — no account, no claim on the name — so there is
// nothing to clean up if somebody closes the tab here, and nobody can be
// trapped mid-flow. Backing out costs one more trip through Discord and no
// data.
//
// The suggestion comes from the server, because only the server can check the
// name is actually free. A suggestion the player cannot accept is worse than
// none: they press the obvious button, are told it is taken, and have to think
// of one anyway — having been led to believe the work was done.

export default function UsernameSetupPanel() {
  const policy = useIdentityPolicy();
  const pending = useGameStore((state) => state.pendingDiscordSignup);
  const claimDiscordUsername = useGameStore((state) => state.claimDiscordUsername);
  const dismissDiscordSignup = useGameStore((state) => state.dismissDiscordSignup);

  // Null until they type, so the server's suggestion can still appear if it
  // arrives after this panel has mounted.
  const [typed, setTyped] = useState<string | null>(null);
  const [reservationToken, setReservationToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!pending) return null;

  const username = typed ?? pending.suggestedUsername;
  const trimmed = username.trim();
  const needsReservationToken = isReservedIn(policy, trimmed);
  const canSubmit =
    !busy &&
    trimmed.length >= policy.minLength &&
    trimmed.length <= policy.maxLength &&
    (!needsReservationToken || Boolean(reservationToken.trim()));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await claimDiscordUsername(pending.ticket, trimmed, reservationToken.trim());
    } catch (caught) {
      // The ticket survives a refused name, so they can pick another without
      // going back through Discord.
      setError(failureMessage(caught, 'That name did not work.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel tone="accent">
      <SectionHeading eyebrow="ALMOST THERE" title="Choose your username" />
      <Text style={styles.help}>
        {pending.discordHandle
          ? `Signed in as ${pending.discordHandle} on Discord. `
          : ''}
        This is the name other players see. You can change it later.
      </Text>

      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}

      <LabeledInput
        autoCapitalize="none"
        autoCorrect={false}
        hint={`${policy.minLength}-${policy.maxLength} characters: letters, digits, and _ . -`}
        label="USERNAME"
        maxLength={policy.maxLength}
        onChangeText={setTyped}
        placeholder="Your username"
        value={username}
      />

      {needsReservationToken ? (
        <LabeledInput
          autoCapitalize="none"
          autoCorrect={false}
          hint="This username is held by the host."
          label="SPECIAL TOKEN"
          onChangeText={setReservationToken}
          placeholder="Paste special token"
          secureTextEntry
          value={reservationToken}
        />
      ) : null}

      <View style={styles.actions}>
        <PrimaryButton
          disabled={!canSubmit}
          label="CLAIM USERNAME"
          loading={busy}
          onPress={submit}
        />
        <GhostButton label="Not now" onPress={dismissDiscordSignup} />
      </View>
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
});
