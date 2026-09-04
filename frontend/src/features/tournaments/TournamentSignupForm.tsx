import { failureMessage } from '@/errors';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import DiscordSignInButton from '@/features/account/DiscordSignInButton';
import { isReservedIn, useIdentityPolicy } from '@/hooks/useIdentityPolicy';
import { links } from '@/navigation/links';
import { isSignedIn } from '@/store/accountSession';
import { signupForTournament } from '@/store/api/tournaments';
import { useGameStore } from '@/store/gameStore';
import { colors } from '@/theme';
import type { Tournament } from '@/types/protocol';
import { Badge, Banner, Checkbox, LabeledInput, PrimaryButton } from '@/ui/primitives';

// The signup panel, shared by the home screen and the tournament board. It owns
// its own request state so either surface can drop it in unchanged.
//
// **It asks for nothing that the account already answers.** The bracket name and
// the Discord handle used to be two text boxes prefilled from the account, which
// meant an entrant could quietly enter under a name that was not theirs, and the
// field a host contacts people on was whatever somebody had typed that day. Both
// now come from the account and are shown rather than edited.
//
// So the form is a series of doors, and each one names the single thing that is
// missing and points at the page that fixes it:
//
//   1. no account — there is no name to enter under;
//   2. an event that wants verified entrants, from an account that has not
//      linked Discord;
//   3. no Discord handle at all, which is how the host reaches people.
//
// Only when all three are answered is there a form, and by then it is one
// checkbox and a button.

export interface TournamentSignupFormProps {
  /** Tightened spacing, for the home screen's card. */
  compact?: boolean;
  /** Called with the tournament the server returned after signing up. */
  onSignedUp?: (tournament: Tournament) => void;
  tournamentId: string;
  /**
   * Whether this event admits only verified accounts, from
   * `tournament.requireDiscord`. The server is the authority; this decides what
   * the form looks like.
   */
  requireDiscord?: boolean;
}

export default function TournamentSignupForm({
  compact,
  onSignedUp,
  tournamentId,
  requireDiscord,
}: TournamentSignupFormProps) {
  const router = useRouter();
  // Which handles are held for the organisers is the server's rule to state.
  const policy = useIdentityPolicy();
  const accountId = useGameStore((state) => state.accountId);
  const account = useGameStore((state) => state.account);
  const sessionToken = useGameStore((state) => state.sessionToken);
  const applyTournamentUpdate = useGameStore((state) => state.applyTournamentUpdate);

  const [agreed, setAgreed] = useState(false);
  const [reservationToken, setReservationToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signedIn = isSignedIn(sessionToken, account);
  const ign = account?.username?.trim() ?? '';
  const discord = account?.discord?.trim() ?? '';
  const discordVerified = Boolean(account?.discordVerified);

  // The token is still asked for, and it is the one thing here that is typed.
  // It is not a name or a handle: it is the proof that somebody entering under
  // an organiser's identity is the organiser. Almost nobody ever sees it — an
  // account only holds a reserved name by having produced this once already —
  // but the server enforces it on the signup regardless of where the name came
  // from, so a form that could not supply it would lock the owner out of their
  // own events.
  const needsToken = isReservedIn(policy, ign) || isReservedIn(policy, discord);
  const canSubmit = agreed && (!needsToken || Boolean(reservationToken.trim()));

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const tournament = await signupForTournament(tournamentId, {
        userId: accountId,
        ign,
        discord,
        agreedToUnfilteredChat: agreed,
        reservationToken: reservationToken.trim(),
      });
      applyTournamentUpdate(tournament);
      setReservationToken('');
      onSignedUp?.(tournament);
    } catch (requestError) {
      setError(failureMessage(requestError, 'The signup could not be completed.'));
    } finally {
      setSubmitting(false);
    }
  };

  /** A door: what is missing, and the button that goes and fixes it. */
  const gate = (detail: string, label: string) => (
    <View style={styles.form}>
      <Text style={styles.help}>{detail}</Text>
      <View style={styles.submit}>
        <PrimaryButton label={label} onPress={() => router.push(links.account())} />
      </View>
    </View>
  );

  // 1. There is no name to enter under until there is an account.
  if (!signedIn || !ign) {
    return gate(
      'You need an account to enter. Your account page is where you pick the name you ' +
        'appear under in the bracket and the Discord handle the host reaches you on — both ' +
        'are required, and both come from there rather than from this form.',
      'GO TO YOUR ACCOUNT',
    );
  }

  // 2. The host asked for verified entrants. The button is the whole fix, and
  //    it fills the handle in as a side effect, so it is offered here rather
  //    than as another trip to the account page.
  if (requireDiscord && !discordVerified) {
    return (
      <View style={styles.form}>
        <Text style={styles.help}>
          This event is only open to players who have verified their account with Discord.
          Link yours and you can sign up straight away — your username, rating and games all
          stay exactly as they are.
        </Text>
        <View style={styles.submit}>
          <DiscordSignInButton label="VERIFY WITH DISCORD" />
        </View>
      </View>
    );
  }

  // 3. An entrant the host cannot reach is a forfeit waiting to happen.
  if (!discord) {
    return gate(
      'Your account has no Discord handle, which is how the host reaches you about your ' +
        'matches. Add one on your account page and come back.',
      'ADD YOUR DISCORD HANDLE',
    );
  }

  return (
    <View style={styles.form}>
      {!compact && (
        <Text style={styles.help}>
          You enter under the name on your account, and the host reaches you on its Discord
          handle. Change either of them on your account page.
        </Text>
      )}
      <View style={compact ? styles.compactFields : undefined}>
        <View style={compact ? styles.compactField : undefined}>
          <Text style={styles.fieldLabel}>IN-GAME NAME</Text>
          <View style={styles.value}>
            <Text style={styles.valueText}>{ign}</Text>
          </View>
        </View>
        <View style={compact ? styles.compactField : undefined}>
          <Text style={styles.fieldLabel}>DISCORD</Text>
          <View style={styles.value}>
            <Text style={styles.valueText}>{discord}</Text>
            {discordVerified ? <Badge label="VERIFIED" tone="accent" /> : null}
          </View>
        </View>
      </View>
      {needsToken && (
        <LabeledInput
          autoCapitalize="none"
          autoCorrect={false}
          hint="That name is reserved for the organisers."
          label="SPECIAL TOKEN"
          onChangeText={setReservationToken}
          placeholder="Paste special token"
          secureTextEntry
          value={reservationToken}
        />
      )}
      <Checkbox
        checked={agreed}
        label="I understand tournament chat may be unfiltered, agree to take part, and accept the privacy policy and play agreement."
        onToggle={() => setAgreed((current) => !current)}
      />
      <View style={styles.submit}>
        <PrimaryButton
          disabled={!canSubmit}
          label="SIGN UP"
          loading={submitting}
          onPress={submit}
        />
      </View>
      {Boolean(error) && (
        <View style={styles.error}>
          <Banner message={error} onDismiss={() => setError(null)} tone="error" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { marginTop: 4 },
  help: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },
  compactFields: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  compactField: { flexGrow: 1, flexBasis: 150 },
  fieldLabel: {
    color: colors.textFaint,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.2,
    marginTop: 14,
  },
  value: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  valueText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  submit: { marginTop: 14 },
  error: { marginTop: 10 },
});
