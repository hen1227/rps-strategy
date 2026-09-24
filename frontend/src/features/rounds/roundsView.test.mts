import assert from 'node:assert/strict';
import test from 'node:test';

import {
  awayNote,
  canPlayRankedNow,
  enteredSummary,
  fieldStatus,
  fieldSummary,
  ladderFieldGroups,
  waitingNote,
  lastRoundSummary,
  ownedEntries,
  ownedStatus,
  scheduleRows,
  shortFieldNote,
} from './roundsView.ts';
import type { LadderFieldEngine, LadderRounds } from '../../store/api/ladderPool.ts';
import type { OwnedBot } from '../../store/api/bots.ts';
import type { ModeDefinition } from '../../types/game.ts';

const MODES = [
  { id: 'V5', shortCode: 'V5', name: 'Total War', playable: true },
  { id: 'V6', shortCode: 'V6', name: 'Intransitive', playable: true },
] as unknown as ModeDefinition[];

const engine = (name: string, extra: Partial<LadderFieldEngine> = {}): LadderFieldEngine => ({
  botId: `bot-${name}`,
  userId: `user-${name}`,
  name,
  reference: false,
  rating: 100,
  ratingState: 'rated',
  online: true,
  ready: true,
  waiting: false,
  ...extra,
});

/** An entered engine nobody is running, which is the case the field hides. */
const away = (name: string): LadderFieldEngine =>
  engine(name, { online: false, ready: false, reason: 'not connected' });

/** An engine the round will use, once the game it is in finishes. */
const busy = (name: string): LadderFieldEngine => engine(name, { waiting: true });

/** An engine the round cannot use at all. */
const out = (name: string, reason: string): LadderFieldEngine =>
  engine(name, { ready: false, reason });

const owned = (name: string, extra: Partial<OwnedBot> = {}): OwnedBot =>
  ({
    botId: `bot-${name}`,
    ownerUserId: 'me',
    name,
    description: '',
    allowPublicPlay: true,
    enterTournaments: true,
    enterLadder: true,
    claimed: true,
    disabled: false,
    retired: false,
    online: true,
    createdAtUnixMs: 0,
    ...extra,
  }) as OwnedBot;

const rounds = (extra: Partial<LadderRounds> = {}): LadderRounds =>
  ({
    intervalMs: 3_600_000,
    gamesPerRound: 2,
    roundsRun: 12,
    minimumField: 2,
    lastRoundAtUnixMs: 3_600_000,
    schedule: [],
    field: [],
    last: null,
    anchorBotId: 'anchor',
    ratingFloor: 1,
    ratingPointsPerDoubling: 20,
    ...extra,
  }) as LadderRounds;

test('the field is split by why each engine is in it, and ready is counted across both', () => {
  // The two groups are two different claims — one owner entered this, the host
  // runs that one — and the count is about the round, which does not care.
  const groups = ladderFieldGroups([
    engine('mine'),
    engine('anchor', { reference: true }),
    out('wrongmode', 'does not play Intransitive'),
    { ...out('rung', 'shutting down'), reference: true },
  ]);
  assert.deepEqual(
    groups.entered.map((one) => one.name),
    ['mine', 'wrongmode'],
  );
  assert.deepEqual(
    groups.references.map((one) => one.name),
    ['anchor', 'rung'],
  );
  assert.equal(groups.inRound, 2);
  assert.equal(groups.away, 0);
});

test('an engine in a game is in the round, counted and tagged as in', () => {
  // The bug this replaced: a busy engine was counted out and tagged in the same
  // grey a refusal wears, so a field of three with one playing read as "two are
  // in and one is not" when all three are in and one starts a few minutes late.
  const groups = ladderFieldGroups([engine('free'), busy('playing'), out('nope', 'shutting down')]);
  assert.equal(groups.inRound, 2);
  assert.equal(groups.waiting, 1);
  assert.equal(fieldSummary(groups), '2 of 3 in');
  assert.deepEqual(fieldStatus(busy('playing')), { label: 'IN WHEN FREE', tone: 'cool' });
  assert.match(waitingNote(groups) ?? '', /^1 engine is busy\./);
  assert.match(waitingNote(groups) ?? '', /when a slot opens, not next hour\.$/);
});

test('nothing is said about waiting when nobody is', () => {
  assert.equal(waitingNote(ladderFieldGroups([engine('free')])), null);
});

test('a field that is entirely waiting still counts as enough to run', () => {
  // Two engines both mid-game is a round that happens, late. Reporting it as
  // short of a field would be the old skip in new words.
  const groups = ladderFieldGroups([busy('a'), busy('b')]);
  assert.equal(shortFieldNote({ inRound: groups.inRound, minimumField: 2 }), null);
});

test('an engine nobody is running is counted, not listed', () => {
  // An engine that is here and unavailable says something about the round. One
  // that is switched off says only that its owner's machine is off, and it
  // would say it every hour until they started it.
  const groups = ladderFieldGroups([
    engine('here'),
    away('asleep'),
    { ...away('dormant'), reference: true },
  ]);
  assert.deepEqual(
    groups.entered.map((one) => one.name),
    ['here'],
  );
  assert.deepEqual(groups.references, []);
  assert.equal(groups.away, 2);
  // And the summary counts the rows under it rather than the whole field, or it
  // is the same trap the rail's single number was.
  assert.equal(fieldSummary(groups), '1 of 1 in');
});

test('the engines that are away are said out loud, and nothing is said when none are', () => {
  // Dropping them silently would make the page look wrong to anybody who knows
  // how many bots are entered.
  assert.equal(awayNote(ladderFieldGroups([engine('here')])), null);
  assert.match(
    awayNote(ladderFieldGroups([engine('here'), away('a')])) ?? '',
    /^1 more engine is entered but offline/,
  );
  assert.match(
    awayNote(ladderFieldGroups([away('a'), away('b')])) ?? '',
    /^2 more engines are entered but offline/,
  );
});

test('a status badge shows the server own reason rather than a second set of words', () => {
  assert.deepEqual(fieldStatus(engine('a')), { label: 'IN', tone: 'accent' });
  assert.deepEqual(fieldStatus(engine('a', { ready: false, reason: 'shutting down' })), {
    label: 'SHUTTING DOWN',
    tone: 'neutral',
  });
});

test('an engine that is not ready and gave no reason still says something', () => {
  // Only reachable against a server older than the reasons. A blank badge would
  // read as a loading state that never finishes.
  assert.equal(fieldStatus(engine('a', { ready: false })).label, 'NOT AVAILABLE');
});

test('a field too small to run a round says so before the hour', () => {
  assert.equal(shortFieldNote({ inRound: 2, minimumField: 2 }), null);
  assert.equal(shortFieldNote({ inRound: 5, minimumField: 2 }), null);
  assert.match(
    shortFieldNote({ inRound: 1, minimumField: 2 }) ?? '',
    /^1 entered; at least 2 needed to play\./,
  );
  assert.match(shortFieldNote({ inRound: 0, minimumField: 2 }) ?? '', /^No engines entered\. At least 2 are needed to play\./);
});

test('your own engines are joined to the field, and retired slots are dropped', () => {
  const entries = ownedEntries(
    [owned('live'), owned('gone', { retired: true }), owned('out', { enterLadder: false })],
    [engine('live')],
  );
  assert.deepEqual(
    entries.map((entry) => entry.bot.name),
    ['live', 'out'],
  );
  assert.equal(entries[0].field?.name, 'live');
  // Not entered means not in the field at all, which is the state the page has
  // to tell apart from every circumstantial one.
  assert.equal(entries[1].field, null);
  assert.equal(entries[1].entered, false);
});

test('your own engine in a game is told it is in the round, not left out of it', () => {
  // The one an owner is most likely to be looking at. "Entered, but every slot
  // is playing" read as a refusal; it is not one.
  assert.equal(
    ownedStatus({ bot: owned('a'), entered: true, field: busy('a') }),
    'Entered. Joins when its current game ends.',
  );
});

test('an engine reads as not entered, or entered with the server reason', () => {
  assert.match(
    ownedStatus({ bot: owned('a', { enterLadder: false }), entered: false, field: null }),
    /^Not entered/,
  );
  assert.equal(
    ownedStatus({ bot: owned('a'), entered: true, field: engine('a') }),
    'Entered and ready for the next round.',
  );
  assert.equal(
    ownedStatus({
      bot: owned('a'),
      entered: true,
      field: engine('a', { ready: false, reason: 'not connected' }),
    }),
    'Entered, but not connected.',
  );
});

test('a slot that has never connected is told that before anything about rounds', () => {
  // Asked first on purpose: its owner has not finished setting it up, and the
  // switch is not what is stopping it.
  assert.match(
    ownedStatus({ bot: owned('a', { claimed: false }), entered: true, field: null }),
    /Run the client with this token/,
  );
});

test('an entered engine missing from the field is not given an invented reason', () => {
  assert.equal(
    ownedStatus({ bot: owned('a'), entered: true, field: null }),
    'Entered, but unavailable for the next round.',
  );
});

test('PLAY NOW is offered only to an engine that could start one this second', () => {
  assert.equal(canPlayRankedNow({ bot: owned('a'), entered: true, field: engine('a') }), true);

  // Every no, and each is a different question. Not entered is the owner's own
  // choice; the rest are circumstance.
  assert.equal(
    canPlayRankedNow({ bot: owned('a', { enterLadder: false }), entered: false, field: null }),
    false,
  );
  assert.equal(
    canPlayRankedNow({ bot: owned('a', { claimed: false }), entered: true, field: engine('a') }),
    false,
  );
  assert.equal(
    canPlayRankedNow({ bot: owned('a'), entered: true, field: out('a', 'not connected') }),
    false,
  );
  assert.equal(canPlayRankedNow({ bot: owned('a'), entered: true, field: null }), false);
});

test('an engine mid-game is in the round but cannot be played right now', () => {
  // The one state where this and the field deliberately disagree: a round pairs
  // a busy engine and holds the pairing, and a press has nothing to hold with.
  // The status line still says it is in the round, so the disabled button is
  // not the only thing explaining itself.
  const entry = { bot: owned('a'), entered: true, field: busy('a') };
  assert.equal(entry.field.ready, true);
  assert.equal(canPlayRankedNow(entry), false);
});

test('the schedule drops rounds that have already started and marks the next', () => {
  // The served head is the round still owed, so just after an hour it is in the
  // past. A row naming a time that has been reads as a schedule that slipped.
  const schedule = [
    { modeId: 'V5' as const, initialTimeMs: 60_000, incrementMs: 1_000, atUnixMs: 1_000, entered: 2 },
    { modeId: 'V6' as const, initialTimeMs: 180_000, incrementMs: 1_000, atUnixMs: 5_000, entered: 0 },
  ];
  const rows = scheduleRows(schedule, MODES, 2_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mode, 'Intransitive');
  assert.equal(rows[0].clock, '3+1');
  assert.equal(rows[0].next, true);
});

test('a mode this client has never heard of is drawn as its id, not dropped', () => {
  const rows = scheduleRows(
    [{ modeId: 'V9' as never, initialTimeMs: 60_000, incrementMs: 0, atUnixMs: 9_000, entered: 0 }],
    MODES,
    0,
  );
  assert.equal(rows[0].mode, 'V9');
});

test('the last round is summarised by its pairings and the games they played', () => {
  const view = rounds({
    last: {
      atUnixMs: 3_600_000,
      modeId: 'V5',
      initialTimeMs: 60_000,
      incrementMs: 1_000,
      series: [
        {
          seriesId: 'one',
          games: [{ result: 'first_win' }, { result: 'second_win' }],
        },
        { seriesId: 'two', games: [{ result: 'draw' }, { result: 'pending' }] },
      ] as never,
    },
  });
  assert.equal(lastRoundSummary(view), '2 pairings · 3 games played');
});

test('a round that seated nothing says so, and no round at all says something else', () => {
  // Two states that look identical on an empty scoreboard and are not the same
  // news: one is a quiet hour, the other is a pool that has never run.
  assert.equal(
    lastRoundSummary(
      rounds({
        last: {
          atUnixMs: 3_600_000,
          modeId: 'V5',
          initialTimeMs: 60_000,
          incrementMs: 1_000,
          series: [],
        },
      }),
    ),
    'No games played. No engines were available.',
  );
  assert.equal(lastRoundSummary(rounds()), 'The pool has not run a round yet.');
});

test('the field summary carries both numbers, not one doing two jobs', () => {
  // The rail's old "7 engines entered" meant the number the round would seat
  // and was read as the size of the field. An owner whose engine was entered
  // and shutting down was inside one of those and outside the other.
  const groups = ladderFieldGroups([
    engine('a'),
    out('b', 'shutting down'),
    engine('anchor', { reference: true }),
  ]);
  assert.equal(fieldSummary(groups), '2 of 3 in');
});

test('the entered summary counts only slots the question applies to', () => {
  // An unclaimed slot reads as entered because that is the column default, and
  // the client overwrites it on the first connect. Counting it would be a claim
  // about an engine that does not exist.
  assert.equal(
    enteredSummary(
      ownedEntries([owned('on'), owned('off', { enterLadder: false }), owned('slot', { claimed: false })], []),
    ),
    '1 of 2 entered',
  );
  assert.equal(enteredSummary(ownedEntries([owned('slot', { claimed: false })], [])), null);
  assert.equal(enteredSummary([]), null);
});
