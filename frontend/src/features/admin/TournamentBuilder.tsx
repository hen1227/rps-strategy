import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { adminStyles } from './adminStyles';
import { useGameStore } from '@/store/gameStore';
import type { TournamentConfig } from '@/store/api/tournaments';
import { colors, radius, space, type } from '@/theme';
import type { ModeID } from '@/types/game';
import type {
  Tournament,
  TournamentField,
  TournamentFormat,
  TournamentSeeding,
} from '@/types/protocol';
import {
  Checkbox,
  GhostButton,
  LabeledInput,
  OptionChips,
  PrimaryButton,
} from '@/ui/primitives';

// The form that decides what a tournament is.
//
// Every answer here used to be a constant somewhere — round robin, signup
// order, the default clock, open to anybody — and the event was public from the
// moment it existed. This is the other half of fixing that: a host writes the
// whole thing down, looks at it, and publishes when it is right.
//
// The form is used for two jobs and the difference is one prop: creating a
// draft, and editing something that already exists. What is *editable* is not
// this component's judgement — the server decides, and it narrows as an event
// progresses:
//
//   - a **draft** takes everything;
//   - one **taking signups** takes the name, the description, the intended
//     start, and a cap that is not below the field that has already entered,
//     because the rules of the competition are what people signed up for;
//   - one **started or finished** takes the words only.
//
// `locked` mirrors that, so a host is not offered a control whose save will be
// refused. The server is still the authority; this is a courtesy.

const FORMATS: { label: string; value: TournamentFormat }[] = [
  { label: 'Round robin', value: 'round_robin' },
  { label: 'Double round robin', value: 'double_round_robin' },
  { label: 'Single elimination', value: 'single_elimination' },
  { label: 'Swiss', value: 'swiss' },
];

/** What each format costs, in the units a host is deciding in: games. */
const FORMAT_DETAIL: Record<TournamentFormat, string> = {
  round_robin:
    'Everybody plays everybody once. The fairest, and the one that does not scale — sixteen entrants is 120 games.',
  double_round_robin:
    'Everybody plays everybody twice, with the seats swapped so nobody gets both openings. Twice the games.',
  single_elimination:
    'A knockout. Lose and you are out; a field that is not a power of two byes its top seeds in round one. Rounds are paired as they are reached.',
  swiss:
    'Fixed number of rounds, paired by score, nobody plays the same opponent twice. Scales to a large field without eliminating anybody.',
};

const FIELDS: { label: string; value: TournamentField }[] = [
  { label: 'Open to all', value: 'open' },
  { label: 'Humans only', value: 'humans' },
  { label: 'Bots only', value: 'bots' },
];

const FIELD_DETAIL: Record<TournamentField, string> = {
  open: 'Anybody may enter, engines included.',
  humans: 'Engines are refused, and are not conscripted by the enrol sweep.',
  bots: 'People are refused. Engines entered in a running event are held in reserve for it — they take no challenges and no series until it finishes, even after their last match.',
};

const SEEDINGS: { label: string; value: TournamentSeeding }[] = [
  { label: 'Signup order', value: 'signup' },
  { label: 'By rating', value: 'rating' },
];

/**
 * The clocks on offer, in milliseconds.
 *
 * A handful of named controls rather than two number fields, for the reason
 * `OptionChips` exists: every clock choice elsewhere in this app is a choice
 * between named things, and a host setting up an event should not have to
 * decide whether 420000 is a sensible number. Zero is the server's default,
 * which is what every event before the builder used.
 */
const CLOCKS: { label: string; initial: number; increment: number }[] = [
  { label: 'Server default', initial: 0, increment: 0 },
  { label: '3 + 2', initial: 180_000, increment: 2_000 },
  { label: '5 + 3', initial: 300_000, increment: 3_000 },
  { label: '10 + 5', initial: 600_000, increment: 5_000 },
  { label: '15 + 10', initial: 900_000, increment: 10_000 },
];

/** Which clock a stored pair of numbers is, for the chip row's value. */
const clockKey = (initial: number, increment: number) =>
  `${initial}:${increment}`;

export interface TournamentBuilderProps {
  /** The event being edited, or null when composing a new draft. */
  tournament: Tournament | null;
  busy: boolean;
  /**
   * Which groups of controls the server will refuse. See the note above: this
   * mirrors the server's rule rather than inventing one.
   */
  locked: { rules: boolean; cap: boolean };
  onSubmit: (config: TournamentConfig) => void;
  onCancel?: () => void;
}

export default function TournamentBuilder({
  tournament,
  busy,
  locked,
  onSubmit,
  onCancel,
}: TournamentBuilderProps) {
  const modes = useGameStore((state) => state.modes);
  const playableModes = useMemo(
    () => modes.filter((mode) => mode.playable !== false),
    [modes],
  );

  const [name, setName] = useState(tournament?.name ?? '');
  const [description, setDescription] = useState(tournament?.description ?? '');
  const [modeId, setModeId] = useState<ModeID | null>(tournament?.modeId ?? null);
  const [format, setFormat] = useState<TournamentFormat>(
    tournament?.format ?? 'round_robin',
  );
  const [field, setField] = useState<TournamentField>(tournament?.field ?? 'open');
  const [seeding, setSeeding] = useState<TournamentSeeding>(
    tournament?.seeding ?? 'signup',
  );
  const [requireDiscord, setRequireDiscord] = useState(
    tournament?.requireDiscord ?? false,
  );
  // Kept as text rather than as a number, because a cleared field is a real
  // state a host passes through while typing and `Number('')` is zero, which
  // here means something specific: uncapped.
  const [maxPlayers, setMaxPlayers] = useState(
    tournament?.maxPlayers ? String(tournament.maxPlayers) : '',
  );
  const [swissRounds, setSwissRounds] = useState(
    tournament?.swissRounds ? String(tournament.swissRounds) : '',
  );
  const [clock, setClock] = useState(
    clockKey(tournament?.initialTimeMs ?? 0, tournament?.incrementMs ?? 0),
  );

  const selectedMode = modeId ?? playableModes[0]?.id ?? null;
  const chosenClock =
    CLOCKS.find((option) => clockKey(option.initial, option.increment) === clock) ??
    CLOCKS[0];

  const submit = () => {
    const config: TournamentConfig = {
      name: name.trim(),
      description: description.trim(),
    };
    // Only what the server will accept, so an edit of a published event does
    // not send it rules it is going to refuse and get a 409 for the whole save.
    if (!locked.rules) {
      config.modeId = selectedMode ?? undefined;
      config.format = format;
      config.field = field;
      config.seeding = seeding;
      config.requireDiscord = requireDiscord;
      config.swissRounds = Number(swissRounds) || 0;
      config.initialTimeMs = chosenClock.initial;
      config.incrementMs = chosenClock.increment;
    }
    if (!locked.cap) {
      config.maxPlayers = Number(maxPlayers) || 0;
    }
    onSubmit(config);
  };

  return (
    <View style={styles.form}>
      <LabeledInput
        label="NAME"
        maxLength={80}
        onChangeText={setName}
        placeholder="Friday Night Open"
        value={name}
      />
      <LabeledInput
        hint="Shown on the event's page. The rules, the prize, where to be and when."
        label="DESCRIPTION"
        maxLength={2000}
        multiline
        numberOfLines={3}
        onChangeText={setDescription}
        placeholder="Five rounds, Swiss, starting at 8pm Eastern."
        style={styles.multiline}
        value={description}
      />

      {locked.rules ? (
        <Text style={styles.lockNote}>
          The format, the mode, the seeding and the clock are what people signed up for, so
          they are fixed now. The name, the description
          {locked.cap ? '' : ', the field cap'} and the intended start time can still change.
        </Text>
      ) : (
        <>
          <OptionChips
            label="GAME MODE"
            onChange={setModeId}
            options={playableModes.map((mode) => ({ label: mode.name, value: mode.id }))}
            value={selectedMode}
          />

          <OptionChips
            label="FORMAT"
            onChange={setFormat}
            options={FORMATS}
            value={format}
          />
          <Text style={styles.detail}>{FORMAT_DETAIL[format]}</Text>

          {/*
            Only for Swiss, because it means nothing anywhere else. A field that
            is inert on three of the four formats is a field a host has to learn
            to ignore.
          */}
          {format === 'swiss' ? (
            <LabeledInput
              hint="Leave blank to let the field size decide, which is what a Swiss normally does."
              keyboardType="number-pad"
              label="ROUNDS"
              onChangeText={setSwissRounds}
              placeholder="auto"
              value={swissRounds}
            />
          ) : null}

          <OptionChips label="WHO MAY ENTER" onChange={setField} options={FIELDS} value={field} />
          <Text style={styles.detail}>{FIELD_DETAIL[field]}</Text>

          {/*
            A second door beside the field rule rather than a fourth chip in it,
            because it answers a different question. The field rule is what kind
            of entrant may play; this is how sure you are the entrant is who the
            form says they are. An event can want either without the other — a
            bots-only event verifies nobody, and an open one may want every
            person in it accounted for.
          */}
          <Checkbox
            checked={requireDiscord}
            label="Require a verified Discord account"
            onToggle={() => setRequireDiscord((current) => !current)}
          />
          <Text style={styles.detail}>
            {requireDiscord
              ? field === 'bots'
                ? 'Asked of people only, so this changes nothing for a bots-only event: an engine has no Discord account to link.'
                : 'Anybody who signs in with Discord is in. Anybody who has not linked one is refused at the signup form and told to link it — it takes about ten seconds. Their signup carries the handle Discord vouched for rather than one they typed, so the handles you contact the field on are known to work.'
              : 'Anybody may enter and type whatever Discord handle they like, which nothing checks.'}
          </Text>

          <OptionChips
            label="SEEDING"
            onChange={setSeeding}
            options={SEEDINGS}
            value={seeding}
          />
          <Text style={styles.detail}>
            {seeding === 'rating'
              ? "Strongest first, using each entrant's rating in this event's mode. What a bracket wants, so the two favourites do not meet in round one."
              : 'The order people entered. Nothing about it is a judgement, which is its own kind of fair.'}
          </Text>

          <OptionChips
            label="CLOCK"
            onChange={setClock}
            options={CLOCKS.map((option) => ({
              label: option.label,
              value: clockKey(option.initial, option.increment),
            }))}
            value={clock}
          />
        </>
      )}

      {locked.cap ? null : (
        <LabeledInput
          hint="Leave blank for no cap. A cap is how a round robin stays finishable."
          keyboardType="number-pad"
          label="MAXIMUM PLAYERS"
          onChangeText={setMaxPlayers}
          placeholder="no cap"
          value={maxPlayers}
        />
      )}

      <View style={styles.actions}>
        <PrimaryButton
          disabled={busy || !name.trim() || (!locked.rules && !selectedMode)}
          label={tournament ? 'SAVE CHANGES' : 'CREATE DRAFT'}
          onPress={submit}
        />
        {onCancel ? (
          <GhostButton compact disabled={busy} label="CANCEL" onPress={onCancel} />
        ) : null}
      </View>
      {tournament ? null : (
        <Text style={adminStyles.help}>
          A new event is a draft. It is not on the public board, it takes no signups, and
          nobody but you can reach its address — so it can sit half-decided for as long as you
          like. Publishing is what opens it.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: space.snug,
    marginTop: space.small,
    padding: space.medium,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.goldBorder,
    backgroundColor: colors.surfaceWell,
  },
  multiline: { minHeight: 64, textAlignVertical: 'top' },
  detail: { ...type.meta, color: colors.textFaint, marginTop: -space.tight },
  lockNote: { ...type.body, color: colors.textMuted },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    marginTop: space.small,
  },
});
