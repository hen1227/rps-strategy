import { failureMessage } from '@/errors';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  Banner,
  GhostButton,
  LabeledInput,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';
import { isReservedIn, useIdentityPolicy } from '@/hooks/useIdentityPolicy';
import type { IdentityPolicy } from '@/store/api/bots';
import { useGameStore } from '@/store/gameStore';
import { colors } from '@/theme';
import type { Account } from '@/types/protocol';

// Creating an account, or signing back into one.
//
// Registering is an upgrade of the anonymous identity this browser has been
// playing under rather than a fresh start: the account keeps its user ID, so
// the rating, the record, and every archived game come with it. That is why
// the account screen leads with this panel instead of a name field — a name
// here belongs to somebody, and claiming one is what an account is.

const MINIMUM_PASSWORD_LENGTH = 4;

// The name a player has been going by, trimmed to something the username rule
// will accept, so that somebody who has been "Rock Star" for months is offered
// "RockStar" rather than an empty box.
export const suggestedUsername = (
  account: Account | null | undefined,
  policy: IdentityPolicy,
) => {
  const current = account?.username?.trim() ?? '';
  if (!current || current.toLowerCase() === 'guest') return '';
  const cleaned = current
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, policy.maxLength);
  return cleaned.length >= policy.minLength ? cleaned : '';
};

export default function AccountAuthPanel() {
  const policy = useIdentityPolicy();
  const account = useGameStore((state) => state.account);
  const register = useGameStore((state) => state.register);
  const signIn = useGameStore((state) => state.signIn);

  // Registering upgrades the account this browser already has, so a browser
  // whose account has been claimed already has nothing left to create: what it
  // needs is the way back in.
  const alreadyRegistered = Boolean(account?.registered);
  const [chosenMode, setChosenMode] = useState<'login' | 'register' | null>(null);
  const mode = chosenMode ?? (alreadyRegistered ? 'login' : 'register');
  // Null until the player types, so a suggestion can still appear when the
  // account arrives from the server after this panel has mounted.
  const [typedUsername, setTypedUsername] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [reservationToken, setReservationToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const registering = mode === 'register';
  const suggested = registering
    ? suggestedUsername(account, policy)
    : (alreadyRegistered && account?.username) || '';
  const username = typedUsername ?? suggested;
  const trimmed = username.trim();
  const needsReservationToken = registering && isReservedIn(policy, trimmed);
  const canSubmit =
    !busy &&
    trimmed.length >= policy.minLength &&
    trimmed.length <= policy.maxLength &&
    password.length >= MINIMUM_PASSWORD_LENGTH &&
    (!needsReservationToken || Boolean(reservationToken.trim()));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (registering) await register(trimmed, password, reservationToken.trim());
      else await signIn(trimmed, password);
      setPassword('');
      setReservationToken('');
    } catch (caught) {
      setError(failureMessage(caught, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  };

  const switchMode = () => {
    setChosenMode(registering ? 'login' : 'register');
    setTypedUsername(null);
    setError(null);
  };

  return (
    <Panel tone="accent">
      <SectionHeading
        eyebrow="ACCOUNT"
        title={registering ? 'Create your account' : 'Sign in'}
      />
      <Text style={styles.help}>
        {registering
          ? 'Everything this browser has already earned comes with you: your rating, '
            + 'your record, and every game you have played. A username is yours once '
            + 'you claim it here.'
          : alreadyRegistered
            ? `This browser plays as ${account?.username}. Sign in to manage the account, `
              + 'or sign in as somebody else.'
            : 'Signing in brings your account to this browser, including one you have '
              + 'never played on before.'}
      </Text>

      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}

      <LabeledInput
        autoCapitalize="none"
        autoCorrect={false}
        hint={
          registering
            ? `${policy.minLength}-${policy.maxLength} characters: letters, digits, and _ . -`
            : undefined
        }
        label="USERNAME"
        maxLength={policy.maxLength}
        onChangeText={setTypedUsername}
        placeholder="Your username"
        value={username}
      />
      {registering && suggested && typedUsername === null ? (
        <Text style={styles.help}>The name you have been playing under, ready to claim.</Text>
      ) : null}

      <LabeledInput
        autoCapitalize="none"
        autoCorrect={false}
        hint={registering ? `At least ${MINIMUM_PASSWORD_LENGTH} characters` : undefined}
        label="PASSWORD"
        onChangeText={setPassword}
        secureTextEntry
        value={password}
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
          label={registering ? 'CREATE ACCOUNT' : 'SIGN IN'}
          loading={busy}
          onPress={submit}
        />
        {alreadyRegistered ? null : (
          <GhostButton
            label={registering ? 'I already have one' : 'Create one instead'}
            onPress={switchMode}
          />
        )}
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
