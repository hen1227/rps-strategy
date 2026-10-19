import { failureMessage } from '@/errors';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import AppleSignInButton from './AppleSignInButton';
import DiscordSignInButton from './DiscordSignInButton';
import { useCommunityRules } from '@/features/policy/CommunityRules';
import { useAppleOffered } from '@/hooks/useSignInProviders';
import { isReservedIn, useIdentityPolicy } from '@/hooks/useIdentityPolicy';
import type { PendingSignup, SignInOutcome } from '@/store/accountSession';
import type { SignInProvider } from '@/store/api/bots';
import { useGameStore } from '@/store/gameStore';
import { colors, space, themedSheet } from '@/theme';
import PageHeading from '@/ui/PageHeading';
import {
  Banner,
  LabeledInput,
  Panel,
  PrimaryButton,
  SectionHeading,
  TextButton,
} from '@/ui/primitives';

// The step after a provider has vouched for somebody this server has never
// seen: is this their first time here, or do they already play?
//
// Asked as a question, with both answers drawn side by side at the same size,
// and neither chosen for them. That is the whole design, and it comes from
// what went wrong when there was one answer drawn and the other was a link.
// The drawn one was "pick a name", so the people who already had an account —
// a Discord player pressing Apple on their new phone, an account from before
// Discord — pressed it, and made a second, empty account holding the identity
// that should have joined their real one. There is no undo for that short of
// deleting the stray.
//
// So the second card is the way back to an existing account, as a first-class
// answer: sign in with the other provider and this one is linked to whatever
// that opens (`continueWithOther`), or, for an account from before Discord,
// its password. Nothing has been written to the database yet — no account, no
// claim on the name — so leaving here costs nothing but another press.
//
// The suggestion in the name field comes from the server, because only the
// server can check the name is actually free. After Apple there is none at
// all, since Apple is asked for no name, and the field starts empty rather
// than holding a filler to delete.

const providerName = (provider: SignInProvider) => (provider === 'apple' ? 'Apple' : 'Discord');
const identityName = (provider: SignInProvider) =>
  provider === 'apple' ? 'APPLE ID' : 'DISCORD';

interface NewAccountStepProps {
  pending: PendingSignup;
  /** How the other provider's sign-in ended, for the screen to move on. */
  onOutcome: (outcome: SignInOutcome) => void;
}

export default function NewAccountStep({ pending, onOutcome }: NewAccountStepProps) {
  const carried = useGameStore((state) => state.carriedSignIn);
  const dismissSignup = useGameStore((state) => state.dismissSignup);
  // A carried identity is the one the player arrived with before this one:
  // they pressed "I already have an account", and the other provider was new
  // here too. Both will join whatever account comes of this step.
  const alsoLinking = carried && carried.ticket !== pending.ticket ? carried.provider : null;
  const verified = [pending.provider, ...(alsoLinking ? [alsoLinking] : [])];

  return (
    <>
      <PageHeading
        detail={
          alsoLinking ? 'Neither is linked to an account here yet.' : 'Not linked to an account here yet.'
        }
        eyebrow={`${verified.map(identityName).join(' AND ')} VERIFIED`}
        title="First time here?"
      />
      <View style={styles.choices}>
        <CreateAccountCard pending={pending} />
        <LinkAccountCard alsoLinking={alsoLinking} onOutcome={onOutcome} pending={pending} />
      </View>
      <View style={styles.footer}>
        <TextButton label="Cancel" onPress={dismissSignup} />
      </View>
    </>
  );
}

/** The first answer: a new account, under a name chosen here. */
function CreateAccountCard({ pending }: { pending: PendingSignup }) {
  const policy = useIdentityPolicy();
  const claimUsername = useGameStore((state) => state.claimUsername);
  const { requireAgreement, rulesDialog } = useCommunityRules();

  // Null until they type, so the server's suggestion can still appear if it
  // arrives after this card has mounted.
  const [typed, setTyped] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [reservationToken, setReservationToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const username = typed ?? pending.suggestedUsername;
  const trimmed = username.trim();
  // The server has recognised this exact name as an older account's, which
  // is very often the player's own: they typed what they have always been
  // called. True only while that name is still in the box, so editing it goes
  // back to an ordinary new account without a stale password field.
  const askingForPassword =
    Boolean(pending.claimingUsername) && pending.claimingUsername === trimmed;
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
      const account = await claimUsername(
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
      // going back through the provider.
      setError(failureMessage(caught, 'That name did not work.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel style={styles.card} tone="accent">
      <SectionHeading eyebrow="YES, I'M NEW" title="Create an account" />
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}

      <LabeledInput
        autoCapitalize="none"
        autoCorrect={false}
        hint={
          askingForPassword
            ? undefined
            : `${policy.minLength}-${policy.maxLength} characters: letters, digits, and _ . -`
        }
        label="USERNAME"
        maxLength={policy.maxLength}
        onChangeText={setTyped}
        placeholder="Choose a username"
        value={username}
      />

      {askingForPassword ? (
        <>
          <Text style={styles.help}>An older account has this name. Yours? Enter its password.</Text>
          <LabeledInput
            autoCapitalize="none"
            autoCorrect={false}
            label="PASSWORD"
            onChangeText={setPassword}
            placeholder="That account's password"
            secureTextEntry
            value={password}
          />
        </>
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

      <View style={styles.cardAction}>
        <PrimaryButton
          disabled={!canSubmit}
          fullWidth
          label={askingForPassword ? 'SIGN IN AND LINK' : 'CREATE ACCOUNT'}
          loading={busy}
          // A new name is posted where everybody reads it. Signing in to an
          // older account posts nothing new.
          onPress={askingForPassword ? submit : () => requireAgreement(() => void submit())}
        />
      </View>
      {rulesDialog}
    </Panel>
  );
}

/**
 * The second answer: an account they already have, which this identity joins.
 *
 * The other provider's own button, so the press is the one they already know.
 * The account it opens gets this identity too; one that turns out to be new as
 * well comes back here, carrying both.
 */
function LinkAccountCard({
  pending,
  alsoLinking,
  onOutcome,
}: {
  pending: PendingSignup;
  alsoLinking: SignInProvider | null;
  onOutcome: (outcome: SignInOutcome) => void;
}) {
  const continueWithOther = useGameStore((state) => state.continueWithOther);
  const appleOffered = useAppleOffered();
  const other: SignInProvider = pending.provider === 'apple' ? 'discord' : 'apple';
  const joining = [pending.provider, ...(alsoLinking ? [alsoLinking] : [])]
    .map(providerName)
    .join(' and ');
  const added = `${joining} ${alsoLinking ? 'are' : 'is'} added`;

  // The other provider is not worth offering when it has just been tried, or
  // when this device cannot do it. Apple's sheet is iOS only, and the website
  // needs a configuration the server may not have.
  const otherTried = alsoLinking === other;
  const otherHere = other === 'discord' || appleOffered !== false;

  return (
    <Panel style={styles.card}>
      <SectionHeading eyebrow="NO, I PLAY HERE" title="Use my account" />
      <Text style={styles.help}>
        {otherTried
          ? `Older account with a password? Sign in to it and ${added}.`
          : `Sign in to it and ${added}.`}
      </Text>

      {otherTried ? null : otherHere ? (
        <View style={styles.cardAction}>
          {other === 'discord' ? (
            <DiscordSignInButton
              onOutcome={onOutcome}
              start={() => continueWithOther('discord')}
            />
          ) : (
            <AppleSignInButton onOutcome={onOutcome} start={() => continueWithOther('apple')} />
          )}
        </View>
      ) : (
        <Text style={styles.help}>
          Made it with Apple? Sign in with Apple on your iPhone, then add Discord under Account.
        </Text>
      )}

      <PasswordLink pending={pending} prominent={otherTried} />
    </Panel>
  );
}

/**
 * An account from before Discord: its name and password link this identity.
 *
 * Folded, because almost nobody reading this has one. When the other provider
 * has already been tried it is the only answer left on the card, so it opens.
 */
function PasswordLink({ pending, prominent }: { pending: PendingSignup; prominent: boolean }) {
  const claimUsername = useGameStore((state) => state.claimUsername);
  const [open, setOpen] = useState(prominent);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Pressable
        accessibilityRole="button"
        hitSlop={10}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.footnote, pressed && styles.pressed]}
      >
        <Text style={styles.footnoteText}>Older account with a password?</Text>
      </Pressable>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await claimUsername(pending.ticket, username.trim(), password);
    } catch (caught) {
      setError(failureMessage(caught, 'That did not work.'));
      setBusy(false);
    }
  };

  return (
    <View style={styles.passwordForm}>
      {prominent ? null : <Text style={styles.help}>Or an older account's name and password:</Text>}
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
      <LabeledInput
        autoCapitalize="none"
        autoCorrect={false}
        label="USERNAME"
        onChangeText={setUsername}
        placeholder="Your username"
        value={username}
      />
      <LabeledInput
        autoCapitalize="none"
        autoCorrect={false}
        label="PASSWORD"
        onChangeText={setPassword}
        secureTextEntry
        value={password}
      />
      <View style={styles.cardAction}>
        <PrimaryButton
          disabled={busy || !username.trim() || !password}
          fullWidth
          label="SIGN IN AND LINK"
          loading={busy}
          onPress={submit}
          tone="quiet"
        />
      </View>
    </View>
  );
}

const styles = themedSheet(() => ({
  // Side by side when there is room for two, one above the other on a phone.
  // A wrapped row rather than a measured breakpoint, so the pre-rendered page
  // and the first render in a browser agree; cards in the same line stretch to
  // the same height.
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: space.medium },
  card: { flexGrow: 1, flexBasis: 260, minWidth: 0 },
  help: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },
  cardAction: { marginTop: 14 },
  passwordForm: { marginTop: 6 },
  footnote: { alignSelf: 'center', marginTop: 14, paddingVertical: 2 },
  footnoteText: {
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 14,
    textDecorationLine: 'underline',
  },
  pressed: { opacity: 0.7 },
  footer: { alignItems: 'center' },
}));
