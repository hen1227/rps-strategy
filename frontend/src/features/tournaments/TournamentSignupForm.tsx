import { failureMessage } from '@/errors';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme';
import { useGameStore } from '@/store/gameStore';
import { isReservedIn, useIdentityPolicy } from '@/hooks/useIdentityPolicy';
import { signupForTournament } from '@/store/api/tournaments';
import type { Tournament } from '@/types/protocol';
import { Banner, Checkbox, LabeledInput, PrimaryButton } from '@/ui/primitives';

// The signup panel, shared by the home screen and the tournament board. It owns
// its own request state so either surface can drop it in unchanged.
export interface TournamentSignupFormProps {
  /** Tightened spacing, for the home screen's card. */
  compact?: boolean;
  /** Called with the tournament the server returned after signing up. */
  onSignedUp?: (tournament: Tournament) => void;
  tournamentId: string;
}

export default function TournamentSignupForm({
  compact,
  onSignedUp,
  tournamentId,
}: TournamentSignupFormProps) {
  // Which handles are held for the organisers is the server's rule to state.
  const policy = useIdentityPolicy();
  const accountId = useGameStore((state) => state.accountId);
  const account = useGameStore((state) => state.account);
  const applyTournamentUpdate = useGameStore((state) => state.applyTournamentUpdate);

  const [ign, setIGN] = useState('');
  const [discord, setDiscord] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [reservationToken, setReservationToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill from the account so signing up is usually two taps.
  useEffect(() => {
    const username = account?.username?.trim();
    if (username && username.toLowerCase() !== 'guest') setIGN((current) => current || username);
    if (account?.discord) setDiscord((current) => current || account.discord);
  }, [account?.username, account?.discord]);

  const needsToken = isReservedIn(policy, ign) || isReservedIn(policy, discord);
  const canSubmit =
    Boolean(ign.trim()) &&
    Boolean(discord.trim()) &&
    agreed &&
    (!needsToken || Boolean(reservationToken.trim()));

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const tournament = await signupForTournament(tournamentId, {
        userId: accountId,
        ign: ign.trim(),
        discord: discord.trim(),
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

  return (
    <View style={styles.form}>
      {!compact && (
        <Text style={styles.help}>
          Your IGN is how you appear in the bracket. Discord is how the host reaches you.
        </Text>
      )}
      <View style={compact ? styles.compactFields : undefined}>
        <View style={compact ? styles.compactField : undefined}>
          <LabeledInput
            autoCapitalize="none"
            label="IN-GAME NAME"
            maxLength={32}
            onChangeText={setIGN}
            placeholder="Your display name"
            value={ign}
          />
        </View>
        <View style={compact ? styles.compactField : undefined}>
          <LabeledInput
            autoCapitalize="none"
            autoCorrect={false}
            label="DISCORD"
            maxLength={64}
            onChangeText={setDiscord}
            placeholder="username"
            value={discord}
          />
        </View>
      </View>
      {needsToken && (
        <LabeledInput
          autoCapitalize="none"
          autoCorrect={false}
          hint="That handle is reserved for the organisers."
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
  submit: { marginTop: 14 },
  error: { marginTop: 10 },
});
