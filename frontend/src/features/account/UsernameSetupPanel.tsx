import { failureMessage } from '@/errors';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Banner, GhostButton, LabeledInput, Panel, PrimaryButton, SectionHeading } from '@/ui/primitives';
import { isReservedIn, useIdentityPolicy } from '@/hooks/useIdentityPolicy';
import { useGameStore } from '@/store/gameStore';
import { colors, themedSheet } from '@/theme';

// Choosing the name a brand-new account will hold — or claiming the one an
// older account already holds.
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
//
// The second half of this panel is for the people it strands otherwise. An
// account made before Discord sign-in has a name and a password and no session
// here, so its owner arrives at *this* step — and the suggested name is drawn
// from their Discord handle, so it does not collide with their own and the
// obvious button quietly builds them a second, empty account. Their real one
// keeps the rating and the games and can never be linked afterwards, because
// the stray now holds the identity. So the way back to it is offered up front,
// and typing the name they already have leads to the same place rather than to
// "that username is taken".

export default function UsernameSetupPanel() {
  const policy = useIdentityPolicy();
  const pending = useGameStore((state) => state.pendingDiscordSignup);
  const claimDiscordUsername = useGameStore((state) => state.claimDiscordUsername);
  const dismissDiscordSignup = useGameStore((state) => state.dismissDiscordSignup);

  // Null until they type, so the server's suggestion can still appear if it
  // arrives after this panel has mounted.
  const [typed, setTyped] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [reservationToken, setReservationToken] = useState('');
  // Whether they have said they already have an account. The server can also
  // put this panel in that state, by answering a name with a request for its
  // password; either way the form is the same.
  const [claiming, setClaiming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!pending) return null;

  const username = typed ?? (claiming ? '' : pending.suggestedUsername);
  const trimmed = username.trim();
  // The server has recognised this exact name as an older account's. It stays
  // true only while that name is still in the box, so editing it goes back to
  // being an ordinary signup without the password field going stale.
  const serverAskedForPassword =
    Boolean(pending.claimingUsername) && pending.claimingUsername === trimmed;
  const askingForPassword = claiming || serverAskedForPassword;

  const needsReservationToken = !askingForPassword && isReservedIn(policy, trimmed);
  const canSubmit =
    !busy &&
    trimmed.length >= policy.minLength &&
    trimmed.length <= policy.maxLength &&
    (!askingForPassword || Boolean(password)) &&
    (!needsReservationToken || Boolean(reservationToken.trim()));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const account = await claimDiscordUsername(
        pending.ticket,
        trimmed,
        askingForPassword ? password : '',
        reservationToken.trim(),
      );
      // Null means the server has asked for a password for this name. The
      // store has recorded which name, so the field appears on the next
      // render and there is nothing to say here.
      if (!account) setPassword('');
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
      <SectionHeading
        eyebrow={askingForPassword ? 'OLDER ACCOUNT' : 'ALMOST THERE'}
        title={askingForPassword ? 'Sign in to your account' : 'Choose your username'}
      />
      <Text style={styles.help}>
        {pending.discordHandle ? `Signed in as ${pending.discordHandle} on Discord. ` : ''}
        {askingForPassword
          ? "Enter your old username and password to link Discord and keep your account."
          : 'This is the name other players see. You can change it later.'}
      </Text>

      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}

      <LabeledInput
        autoCapitalize="none"
        autoCorrect={false}
        hint={
          askingForPassword
            ? 'The name on your existing account.'
            : `${policy.minLength}-${policy.maxLength} characters: letters, digits, and _ . -`
        }
        label="USERNAME"
        maxLength={policy.maxLength}
        onChangeText={setTyped}
        placeholder="Your username"
        value={username}
      />

      {askingForPassword ? (
        <LabeledInput
          autoCapitalize="none"
          autoCorrect={false}
          label="PASSWORD"
          onChangeText={setPassword}
          placeholder="Your existing password"
          secureTextEntry
          value={password}
        />
      ) : null}

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
          label={askingForPassword ? 'SIGN IN AND LINK' : 'CLAIM USERNAME'}
          loading={busy}
          onPress={submit}
        />
        <GhostButton label="Not now" onPress={dismissDiscordSignup} />
      </View>

      {/*
        Offered before they press anything, not after it has gone wrong. By the
        time a legacy account holder has claimed the suggested name there is no
        undo: a second account exists and it holds their Discord identity.
      */}
      <Pressable
        accessibilityRole="button"
        hitSlop={10}
        onPress={() => {
          setClaiming(!askingForPassword);
          setTyped(null);
          setPassword('');
          setError(null);
        }}
        style={({ pressed }) => [styles.switchLink, pressed && styles.switchLinkPressed]}
      >
        <Text style={styles.switchLinkText}>
          {askingForPassword
            ? 'I do not have an account yet'
            : "Link an existing account"}
        </Text>
      </Pressable>
    </Panel>
  );
}

const styles = themedSheet(() => ({
  help: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
  },
  switchLink: { alignSelf: 'center', marginTop: 16, paddingVertical: 2 },
  switchLinkPressed: { opacity: 0.7 },
  // Muted and small, but not dimmer than that: for the accounts that need it
  // this is the only door left, and it has to stay readable.
  switchLinkText: {
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 14,
    textDecorationLine: 'underline',
  },
}));
