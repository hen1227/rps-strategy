import { failureMessage } from '@/errors';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import DiscordSignInButton from '@/features/account/DiscordSignInButton';
import { isReservedIn, useIdentityPolicy } from '@/hooks/useIdentityPolicy';
import { useMyBots } from '@/hooks/useMyBots';
import { links } from '@/navigation/links';
import { isSignedIn } from '@/store/accountSession';
import type { OwnedBot } from '@/store/api/bots';
import { registerBotForTournament, signupForTournament } from '@/store/api/tournaments';
import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, type } from '@/theme';
import type { Tournament } from '@/types/protocol';
import { Badge, Banner, Checkbox, LabeledInput, PrimaryButton } from '@/ui/primitives';

// The registration panel, shared by the home screen and the tournament board.
// It owns its own request state so either surface can drop it in unchanged.
//
// **It asks for nothing that the account already answers.** The bracket name and
// the Discord handle used to be two text boxes prefilled from the account, which
// meant an entrant could quietly enter under a name that was not theirs, and the
// field a host contacts people on was whatever somebody had typed that day. Both
// now come from the account and are shown rather than edited.
//
// # Who is entering
//
// The one question this form does ask. An account may enter itself or exactly
// one of its engines, never both and never two engines — the server enforces
// that in tournamentPartyID, and the picker here is the shape of the same rule.
//
// It replaced a host button that swept every online bot into the field, which
// is why the picker offers ineligible engines rather than hiding them: an
// author whose bot cannot enter needs to be told which of the four reasons it
// is, because each one has a different fix and none of them is visible from a
// list that simply omits it.
//
// # The doors
//
// The rest is a series of doors, and each one names the single thing that is
// missing and points at the page that fixes it:
//
//   1. no account — there is no name to enter under, and no bots to enter;
//   2. an engines-only event, from an account with no engines;
//   3. an account that has not verified with Discord.
//
// The third is asked of the account, not of the entrant, and that is the whole
// of how it applies to engines: a program has no Discord account and never
// will, so what is checked is the owner — the person a host has to reach when
// the engine stops turning up. Switching the picker to a bot does not get past
// it, so it is the one door drawn without the picker above it.

export interface TournamentRegisterFormProps {
  /** Tightened spacing, for the home screen's card. */
  compact?: boolean;
  /** Called with the tournament the server returned after registering. */
  onRegistered?: (tournament: Tournament) => void;
  tournament: Tournament;
}

/** `'self'`, or the id of one of the caller's bots. */
type Entrant = string;

const SELF: Entrant = 'self';

/**
 * Why an engine cannot be entered, or empty when it can.
 *
 * The same four questions the server asks in registerBotForTournament, asked
 * here so the answer arrives before the press rather than after it. The server
 * is still the authority — this is a copy for the sake of the sentence under
 * the name, and a stale copy costs a refusal instead of a wrong entry.
 */
const refusalFor = (bot: OwnedBot, tournament: Tournament): string => {
  if (!bot.claimed || !bot.userId || !bot.name) {
    return 'Has never connected, so it has no name to enter under.';
  }
  if (bot.disabled) return 'Disabled by an administrator.';
  if (!bot.enterTournaments) {
    return 'Set not to enter tournaments — change that on your bots page.';
  }
  if (bot.engineModes?.length && !bot.engineModes.includes(tournament.modeId)) {
    return `Does not play ${tournament.modeName}.`;
  }
  return '';
};

export default function TournamentRegisterForm({
  compact,
  onRegistered,
  tournament,
}: TournamentRegisterFormProps) {
  const router = useRouter();
  // Which handles are held for the organisers is the server's rule to state.
  const policy = useIdentityPolicy();
  const accountId = useGameStore((state) => state.accountId);
  const account = useGameStore((state) => state.account);
  const sessionToken = useGameStore((state) => state.sessionToken);
  const applyTournamentUpdate = useGameStore((state) => state.applyTournamentUpdate);
  const mine = useMyBots();

  const [chosen, setChosen] = useState<Entrant | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [reservationToken, setReservationToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signedIn = isSignedIn(sessionToken, account);
  const ign = account?.username?.trim() ?? '';
  const discord = account?.discord?.trim() ?? '';
  const discordVerified = Boolean(account?.discordVerified);

  // The host's field rule, which decides what the picker may offer at all. An
  // engines-only event is the whole reason any of this exists.
  const admitsPeople = tournament.field !== 'bots';
  const admitsEngines = tournament.field !== 'humans';
  const bots = admitsEngines ? mine.bots.filter((bot) => !bot.retired) : [];
  const firstEligible = bots.find((bot) => !refusalFor(bot, tournament));

  // Derived rather than held in an effect, so the default follows the list in
  // as it loads instead of flashing the wrong row.
  const entrant: Entrant | null =
    chosen ?? (admitsPeople ? SELF : (firstEligible?.botId ?? null));
  const enteringSelf = entrant === SELF;
  const chosenBot = bots.find((bot) => bot.botId === entrant) ?? null;
  const chosenRefusal = chosenBot ? refusalFor(chosenBot, tournament) : '';

  // The token is still asked for, and it is the one thing here that is typed.
  // It is not a name or a handle: it is the proof that somebody entering under
  // an organiser's identity is the organiser. Almost nobody ever sees it — an
  // account only holds a reserved name by having produced this once already —
  // but the server enforces it on the signup regardless of where the name came
  // from, so a form that could not supply it would lock the owner out of their
  // own events. Engines are past it: a bot's name was checked when it claimed
  // its account, not here.
  const needsToken =
    enteringSelf && (isReservedIn(policy, ign) || isReservedIn(policy, discord));
  const canSubmit =
    agreed &&
    Boolean(entrant) &&
    !chosenRefusal &&
    (!needsToken || Boolean(reservationToken.trim()));

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const registered = enteringSelf
        ? await signupForTournament(tournament.tournamentId, {
            userId: accountId,
            ign,
            discord,
            agreedToUnfilteredChat: agreed,
            reservationToken: reservationToken.trim(),
          })
        : await registerBotForTournament(
            sessionToken ?? '',
            tournament.tournamentId,
            entrant ?? '',
          );
      applyTournamentUpdate(registered);
      setReservationToken('');
      onRegistered?.(registered);
    } catch (requestError) {
      setError(failureMessage(requestError, 'The registration could not be completed.'));
    } finally {
      setSubmitting(false);
    }
  };

  /** The same door, before there is a choice to show above it. */
  const bareGate = (detail: string, label: string, href = links.account()) => (
    <View style={styles.form}>
      <Text style={styles.help}>{detail}</Text>
      <View style={styles.submit}>
        <PrimaryButton label={label} onPress={() => router.push(href)} />
      </View>
    </View>
  );

  const picker =
    admitsEngines && bots.length > 0 ? (
      <EntrantPicker
        bots={bots}
        entrant={entrant}
        ign={ign}
        onChange={setChosen}
        showSelf={admitsPeople}
        tournament={tournament}
      />
    ) : null;

  /**
   * A door: what is missing, and the button that goes and fixes it.
   *
   * The picker stays above it whenever there is one. Doors 3 and 4 are about
   * the person, and an owner who is only there to enter an engine must be able
   * to walk past them — a Discord handle they have not got is not a reason to
   * strand them on a page with one button that is not the one they wanted.
   */
  const gate = (detail: string, label: string, href = links.account()) => (
    <View style={styles.form}>
      {picker}
      <Text style={styles.help}>{detail}</Text>
      <View style={styles.submit}>
        <PrimaryButton label={label} onPress={() => router.push(href)} />
      </View>
    </View>
  );

  // 1. There is no name to enter under, and nothing to enter, until there is an
  //    account.
  if (!signedIn || !ign) {
    return bareGate(
      'You need an account to enter. Your account page is where you pick the name you ' +
        'appear under in the bracket and the Discord handle the host reaches you on — both ' +
        'are required, and both come from there rather than from this form.',
      'GO TO YOUR ACCOUNT',
    );
  }

  // 2. An engines-only event, from somebody who has not connected one. Nothing
  //    on this page can fix that, and the bots page is where it is fixed.
  if (!admitsPeople && bots.length === 0) {
    return bareGate(
      mine.loading
        ? 'Checking which of your engines can enter…'
        : 'This event is for engines, and your account has none. Register a bot, run the ' +
            'client once so it claims its name, and it can enter.',
      'YOUR BOTS',
      links.myBots(),
    );
  }

  // 3. Every entrant is verified, engines included — and for an engine the
  //    question is asked of *you*, because a program has no Discord account and
  //    the host chasing one that has not turned up needs to reach a person. So
  //    no picker here: switching to a bot does not get past this, and offering
  //    the choice would imply it might. The button is the whole fix, and it
  //    fills the handle in as a side effect.
  if (!discordVerified) {
    return (
      <View style={styles.form}>
        <Text style={styles.help}>
          Tournaments are open to verified accounts only. Link yours and you can register
          straight away — your username, rating and games all stay exactly as they are.
          {bots.length > 0
            ? ' This covers your bots too: an engine enters on its owner’s verification.'
            : ''}
        </Text>
        <View style={styles.submit}>
          <DiscordSignInButton label="VERIFY WITH DISCORD" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.form}>
      {picker ?? (
        !compact && (
          <Text style={styles.help}>
            You enter under the name on your account, and the host reaches you on its
            Discord handle. Change either of them on your account page.
          </Text>
        )
      )}


      {enteringSelf ? (
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
      ) : (
        // The one thing about entering an engine that is not obvious from the
        // row above: the host chases *you* when it does not turn up, so the
        // handle on your account is the one written beside its name.
        <Text style={styles.help}>
          {`${chosenBot?.name ?? 'Your bot'} enters under its own name, and the host ` +
            `reaches you on ${discord} about its matches.`}
        </Text>
      )}

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
          disabled={!canSubmit || submitting}
          label="REGISTER"
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

interface EntrantPickerProps {
  bots: OwnedBot[];
  entrant: Entrant | null;
  ign: string;
  onChange: (entrant: Entrant) => void;
  showSelf: boolean;
  tournament: Tournament;
}

/**
 * Who is taking this account's one place.
 *
 * A list rather than a chip row, because each option carries a second line: an
 * engine's rating and whether it is up, or the reason it cannot enter. Chips
 * would fit the names and drop exactly the part that answers the question.
 */
function EntrantPicker({
  bots,
  entrant,
  ign,
  onChange,
  showSelf,
  tournament,
}: EntrantPickerProps) {
  const row = (
    key: Entrant,
    title: string,
    detail: string,
    badge: string | null,
    refusal: string,
  ) => {
    const selected = entrant === key;
    return (
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ selected, disabled: Boolean(refusal) }}
        disabled={Boolean(refusal)}
        key={key}
        onPress={() => onChange(key)}
        style={({ pressed }) => [
          styles.option,
          selected && styles.optionSelected,
          Boolean(refusal) && styles.optionDisabled,
          pressed && styles.optionPressed,
        ]}
      >
        <View style={[styles.dot, selected && styles.dotSelected]} />
        <View style={styles.optionCopy}>
          <View style={styles.optionTop}>
            <Text style={styles.optionTitle}>{title}</Text>
            {badge ? <Badge label={badge} tone={refusal ? 'neutral' : 'accent'} /> : null}
          </View>
          <Text style={[styles.optionDetail, Boolean(refusal) && styles.optionRefusal]}>
            {refusal || detail}
          </Text>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.picker}>
      <Text style={styles.fieldLabel}>WHO IS ENTERING</Text>
      <Text style={styles.pickerHelp}>
        {showSelf
          ? 'One place per account: yourself, or one of your bots.'
          : 'One place per account, and this event is engines only.'}
      </Text>
      {showSelf
        ? row(SELF, ign, 'You play your own matches on the board.', 'YOU', '')
        : null}
      {bots.map((bot) =>
        row(
          bot.botId,
          bot.name || 'Unclaimed slot',
          `${bot.online ? 'online' : 'offline'} · turns up for its own matches, ` +
            'so you do not have to',
          'BOT',
          refusalFor(bot, tournament),
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { marginTop: space.tight },
  help: { color: colors.textMuted, ...type.body, marginTop: space.small },
  compactFields: { flexDirection: 'row', flexWrap: 'wrap', gap: space.small + 2 },
  compactField: { flexGrow: 1, flexBasis: 150 },
  fieldLabel: {
    color: colors.textFaint,
    ...type.label,
    fontSize: 9,
    letterSpacing: 1.2,
    marginTop: 14,
  },
  value: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    marginTop: space.snug,
  },
  valueText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  picker: { marginBottom: space.tight },
  pickerHelp: { color: colors.textFaint, ...type.meta, marginTop: space.tight },
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.small + 2,
    marginTop: space.small,
    padding: space.medium - 2,
    backgroundColor: colors.surfaceSunken,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radius.medium,
  },
  optionSelected: {
    backgroundColor: colors.accentSurfaceQuiet,
    borderColor: colors.accentBorder,
  },
  optionDisabled: { opacity: 0.55 },
  optionPressed: { opacity: 0.8 },
  dot: {
    width: 14,
    height: 14,
    marginTop: 2,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.borderStrong,
  },
  dotSelected: { borderColor: colors.accent, backgroundColor: colors.accent },
  optionCopy: { flex: 1, minWidth: 0 },
  optionTop: { flexDirection: 'row', alignItems: 'center', gap: space.small },
  optionTitle: { color: colors.text, ...type.rowTitle, flexShrink: 1 },
  optionDetail: { color: colors.textFaint, ...type.meta, marginTop: space.hair },
  optionRefusal: { color: colors.textDim },
  submit: { marginTop: 14 },
  error: { marginTop: space.small + 2 },
});
