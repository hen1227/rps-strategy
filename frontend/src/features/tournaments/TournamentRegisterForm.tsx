import { failureMessage } from '@/errors';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import DiscordSignInButton from '@/features/account/DiscordSignInButton';
import { isReservedIn, useIdentityPolicy } from '@/hooks/useIdentityPolicy';
import { useMyBots } from '@/hooks/useMyBots';
import { links } from '@/navigation/links';
import { isSignedIn } from '@/store/accountSession';
import { setBotSwitch, type OwnedBot } from '@/store/api/bots';
import { signupForTournament } from '@/store/api/tournaments';
import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, themedSheet, type } from '@/theme';
import type { Tournament } from '@/types/protocol';
import { Badge, Banner, Checkbox, LabeledInput, PrimaryButton } from '@/ui/primitives';

// The entry panel, shared by the home screen and the tournament board.
// It owns its own request state so either surface can drop it in unchanged.
//
// **It asks for nothing that the account already answers.** The bracket name and
// the Discord handle used to be two text boxes prefilled from the account, which
// meant an entrant could quietly enter under a name that was not theirs, and the
// field a host contacts people on was whatever somebody had typed that day. Both
// now come from the account and are shown rather than edited.
//
// # People register. Engines have a switch.
//
// Which is the one real choice on this panel, and it is not a choice made here:
// an engine is entered by the server sweeping up everything that is online with
// `enterTournaments` on, so the only thing an owner decides is that switch. It
// is drawn here, on the event, because that is where somebody stands when the
// question occurs to them — and it is the same switch as the one on the bots
// page, not a copy of it scoped to this event.
//
// It used to be a picker: your name or one of your bots, one place per account,
// and a REGISTER button under it. That was answering a question the server had
// already answered differently. The weekend arena — which is the only event most
// engines ever enter — swept in every online engine whatever the picker said, so
// an author who had carefully registered one of their three watched all three
// play, and an author who had registered none watched theirs play anyway. The
// switch is what was deciding all along, so the switch is what is shown.
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
// the engine stops turning up. An engine whose author is unverified is passed
// over by the sweep with its switch on and everything else in order, which is
// why this door is drawn for an engines-only event too.

/**
 * Whether this panel has anything to draw for an account.
 *
 * Exported because the screens put a heading above it, and a heading over
 * nothing is worse than no section at all. The panel has content whenever there
 * are engine switches to show, and otherwise whenever the account is not itself
 * in the field yet — which covers the doors as well as the form, since somebody
 * who cannot enter still needs to be told why.
 */
export const hasEntryPanel = (
  tournament: Tournament,
  accountId: string,
  bots: OwnedBot[],
): boolean =>
  (tournament.field !== 'humans' && bots.some((bot) => !bot.retired)) ||
  !tournament.players?.some((player) => player.userId === accountId);

export interface TournamentRegisterFormProps {
  /** Tightened spacing, for the home screen's card. */
  compact?: boolean;
  /** Called with the tournament the server returned after registering. */
  onRegistered?: (tournament: Tournament) => void;
  tournament: Tournament;
}

/**
 * What this event will do with an engine, beyond what its switch says.
 *
 * Three states the switch cannot fix, so they are worth saying next to it: an
 * owner who turns the switch on for a slot that has never connected would
 * otherwise be waiting for an event that is never going to call it.
 *
 * The server asks the same questions in enrolOnlineBots. This is a copy for the
 * sake of the sentence under the name, and a stale copy costs a wrong sentence
 * rather than a wrong entry — nothing here is what enters anybody.
 */
const blockerFor = (bot: OwnedBot, tournament: Tournament): string => {
  if (!bot.claimed || !bot.userId || !bot.name) {
    return 'Has never connected, so it has no name to enter under.';
  }
  if (bot.disabled) return 'Disabled by an administrator.';
  if (bot.engineModes?.length && !bot.engineModes.includes(tournament.modeId)) {
    return `Does not play ${tournament.modeName}, so this event will pass it over.`;
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

  const [agreed, setAgreed] = useState(false);
  const [reservationToken, setReservationToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signedIn = isSignedIn(sessionToken, account);
  const ign = account?.username?.trim() ?? '';
  const discord = account?.discord?.trim() ?? '';
  const discordVerified = Boolean(account?.discordVerified);

  // The host's field rule, which decides what is drawn at all. An engines-only
  // event is the whole reason the switches are here.
  const admitsPeople = tournament.field !== 'bots';
  const admitsEngines = tournament.field !== 'humans';
  const bots = admitsEngines ? mine.bots.filter((bot) => !bot.retired) : [];
  // Already in, under your own name. The screens draw the entry itself — seed,
  // handle, the way out — so all this panel owes an entrant is the switches for
  // engines that are not in yet.
  const entered = Boolean(
    accountId && tournament.players?.some((player) => player.userId === accountId),
  );

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
      const registered = await signupForTournament(tournament.tournamentId, {
        userId: accountId,
        ign,
        discord,
        agreedToUnfilteredChat: agreed,
        reservationToken: reservationToken.trim(),
      });
      applyTournamentUpdate(registered);
      setReservationToken('');
      onRegistered?.(registered);
    } catch (requestError) {
      setError(failureMessage(requestError, 'The registration could not be completed.'));
    } finally {
      setSubmitting(false);
    }
  };

  /** The same door, before there is anything to show above it. */
  const bareGate = (detail: string, label: string, href = links.account()) => (
    <View style={styles.form}>
      <Text style={styles.help}>{detail}</Text>
      <View style={styles.submit}>
        <PrimaryButton label={label} onPress={() => router.push(href)} />
      </View>
    </View>
  );

  const engines =
    admitsEngines && bots.length > 0 ? (
      <EngineSwitches
        bots={bots}
        // Only when there is a second group below to tell it apart from. On an
        // engines-only event the screen's own heading already says "your
        // engines", and a second one under it labels nothing.
        labelled={admitsPeople}
        onChanged={mine.reload}
        tournament={tournament}
      />
    ) : null;

  // 1. There is no name to enter under, and nothing to enter, until there is an
  //    account.
  if (!signedIn || !ign) {
    return bareGate(
      'Set up your account to enter. Your username and Discord handle are required.',
      'GO TO YOUR ACCOUNT',
    );
  }

  // 2. An engines-only event, from somebody who has not connected one. Nothing
  //    on this page can fix that, and the bots page is where it is fixed.
  if (!admitsPeople && bots.length === 0) {
    return bareGate(
      mine.loading
        ? 'Checking which of your engines can enter…'
        : 'Register and connect a bot to enter this engine event.',
      'YOUR BOTS',
      links.myBots(),
    );
  }

  // 3. Every entrant is verified, engines included — and for an engine the
  //    question is asked of *you*, because a program has no Discord account and
  //    the host chasing one that has not turned up needs to reach a person. So
  //    no switches here either: turning one on does not get past this, and
  //    offering it would imply it might.
  if (!discordVerified) {
    return (
      <View style={styles.form}>
        <Text style={styles.help}>
          Link Discord to enter tournaments. Your username, rating, and games stay with you.
          {bots.length > 0
            ? ' Your bots also need your account to be verified.'
            : ''}
        </Text>
        <View style={styles.submit}>
          <DiscordSignInButton label="VERIFY WITH DISCORD" />
        </View>
      </View>
    );
  }

  // An engines-only event is the switches and nothing else. There is no form
  // under them, because there is nothing for a person to submit: drawing a
  // REGISTER button that entered nobody is what this panel is here to stop.
  //
  // An entrant who is already in gets the same treatment on any event, for the
  // same reason — the form under the switches would be a second place to do a
  // thing they have done.
  if (!admitsPeople || entered) {
    return <View style={styles.form}>{engines}</View>;
  }

  return (
    <View style={styles.form}>
      {engines ??
        (!compact && (
          <Text style={styles.help}>
            Your account supplies your entry name and Discord contact.
          </Text>
        ))}

      {/* Only when there is an engine list above to tell it apart from. */}
      {engines ? <Text style={styles.fieldLabel}>YOU</Text> : null}
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

interface EngineSwitchesProps {
  bots: OwnedBot[];
  /** Draw the group label, for a panel that has more than this group in it. */
  labelled: boolean;
  /** Re-read the list, because the switch that was just written lives on it. */
  onChanged: () => void;
  tournament: Tournament;
}

/**
 * Every engine this account owns, and whether it enters events.
 *
 * A list rather than one switch, because the question is per engine and an
 * owner with three of them is the case this exists for. Each row carries the
 * second line the old picker carried — whether it is up, or the thing about it
 * that the switch cannot fix — since an author whose engine is not in the field
 * needs to be told which of the reasons it is, and none of them is visible from
 * a bracket that simply does not list it.
 *
 * The write is optimistic in appearance only: the checkbox follows the list, and
 * the list is re-read when the server answers. A switch that did not save
 * therefore snaps back rather than lying.
 */
function EngineSwitches({ bots, labelled, onChanged, tournament }: EngineSwitchesProps) {
  const sessionToken = useGameStore((state) => state.sessionToken);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (bot: OwnedBot) => {
    if (!sessionToken) return;
    setSaving(bot.botId);
    setError(null);
    try {
      await setBotSwitch(sessionToken, bot, 'enterTournaments', !bot.enterTournaments);
      onChanged();
    } catch (requestError) {
      setError(failureMessage(requestError, 'That switch could not be saved.'));
    } finally {
      setSaving(null);
    }
  };

  return (
    <View style={styles.engines}>
      {labelled ? <Text style={styles.fieldLabel}>YOUR ENGINES</Text> : null}
      <Text style={styles.enginesHelp}>
        Each online engine with Tournaments enabled enters when {tournament.name} starts. You can enter more than one.
      </Text>
      {bots.map((bot) => {
        const blocker = blockerFor(bot, tournament);
        return (
          <View
            key={bot.botId}
            style={[
              styles.engine,
              bot.enterTournaments && !blocker && styles.engineIn,
              saving === bot.botId && styles.engineSaving,
            ]}
          >
            <View style={styles.engineCopy}>
              <View style={styles.engineTop}>
                <Text style={styles.engineName}>{bot.name || 'Unclaimed slot'}</Text>
                <Badge
                  label={bot.online ? 'ONLINE' : 'OFFLINE'}
                  tone={bot.online ? 'accent' : 'neutral'}
                />
              </View>
              <Text style={[styles.engineDetail, Boolean(blocker) && styles.engineBlocked]}>
                {blocker ||
                  (bot.enterTournaments
                    ? bot.online
                      ? 'Enters when the event starts.'
                      : 'Enters if it is online when the event starts.'
                    : 'Not entering events.')}
              </Text>
            </View>
            <Checkbox
              checked={bot.enterTournaments}
              label="Tournaments"
              onToggle={() => toggle(bot)}
            />
          </View>
        );
      })}
      {Boolean(error) && (
        <View style={styles.error}>
          <Banner message={error} onDismiss={() => setError(null)} tone="error" />
        </View>
      )}
    </View>
  );
}

const styles = themedSheet(() => ({
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
  engines: { marginBottom: space.tight },
  enginesHelp: { color: colors.textFaint, ...type.meta, marginTop: space.tight },
  engine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.small + 2,
    marginTop: space.small,
    padding: space.medium - 2,
    backgroundColor: colors.surfaceSunken,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radius.medium,
  },
  engineIn: {
    backgroundColor: colors.accentSurfaceQuiet,
    borderColor: colors.accentBorder,
  },
  engineSaving: { opacity: 0.6 },
  // minWidth so a long engine name wraps inside the row instead of pushing the
  // switch off the end of it.
  engineCopy: { flex: 1, minWidth: 0, flexBasis: 150 },
  engineTop: { flexDirection: 'row', alignItems: 'center', gap: space.small },
  engineName: { color: colors.text, ...type.rowTitle, flexShrink: 1 },
  engineDetail: { color: colors.textFaint, ...type.meta, marginTop: space.hair },
  engineBlocked: { color: colors.textDim },
  submit: { marginTop: 14 },
  error: { marginTop: space.small + 2 },
}));
