import assert from 'node:assert/strict';
import test from 'node:test';

import {
  engineElo,
  engineIsAvailable,
  engineStatus,
  liveGameGrid,
  liveHeadline,
  liveMoveLabel,
  liveSnapshot,
  waitingCount,
  type LiveSource,
} from './liveSelectors.ts';
import type { BotPresence, Challenge, LiveGameSummary } from '../../types/protocol.ts';
import type { ModeDefinition } from '../../types/game.ts';

const MODES = [
  { id: 'V5', shortCode: 'V5', name: 'Total War', playable: true },
  { id: 'V3', shortCode: 'V3', name: 'Infiltration', playable: true },
] as unknown as ModeDefinition[];

const emptySource = (): LiveSource => ({
  accountId: 'viewer',
  onlineCount: 0,
  liveGames: [],
  botPlayerCount: 0,
  engineBots: [],
  openChallenges: [],
  tournaments: [],
  modes: MODES,
});

const liveGame = (gameId: string, series?: object): LiveGameSummary =>
  ({ gameId, modeId: 'V5', modeName: 'Total War', ...(series ? { series } : {}) }) as LiveGameSummary;

const engineBot = (
  botId: string,
  name: string,
  extra: Partial<BotPresence> = {},
): BotPresence =>
  ({
    botId,
    userId: `${botId}-user`,
    name,
    elo: 1500,
    busy: false,
    allowPublicPlay: true,
    ...extra,
  }) as BotPresence;

/** A live game with two named seats, so an engine can be found sitting in one. */
const seatedGame = (
  gameId: string,
  redUserId: string,
  blueUserId: string,
  series?: object,
): LiveGameSummary =>
  ({
    gameId,
    modeId: 'V5',
    modeName: 'Total War',
    redPlayer: { userId: redUserId, username: redUserId },
    bluePlayer: { userId: blueUserId, username: blueUserId },
    ...(series ? { series } : {}),
  }) as LiveGameSummary;

const openChallenge = (id: string, username: string, queued = false): Challenge =>
  ({
    id,
    challenger: { userId: `${id}-user`, username },
    modeName: 'Total War',
    setup: { modeId: 'V5' },
    queued,
    createdAtUnixMs: 0,
  }) as unknown as Challenge;

test('a bot fight is a live game carrying a series, not a guess about its players', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    liveGames: [liveGame('human'), liveGame('run', { seriesId: 's1', gameNumber: 2 })],
  });
  assert.deepEqual(
    snapshot.playerGames.map((game) => game.gameId),
    ['human'],
  );
  assert.deepEqual(
    snapshot.botFights.map((game) => game.gameId),
    ['run'],
  );
});

test('a compact live position restores pieces and territory for the board', () => {
  const grid = liveGameGrid({
    position: {
      rows: ['R........', '.........', '.........', '.........', '....p....', '.........', '.........', '.........', '........s'],
      owners: ['b........', '.........', '.........', '.........', '....r....', '.........', '.........', '.........', '........b'],
    },
  });

  assert.deepEqual(
    [grid[0]?.[0]?.occupant, grid[0]?.[0]?.occupantOwner, grid[0]?.[0]?.ownerColor],
    ['Rock', 'Blue', 'Blue'],
  );
  assert.deepEqual(
    [grid[4]?.[4]?.occupant, grid[4]?.[4]?.occupantOwner, grid[4]?.[4]?.ownerColor],
    ['Paper', 'Red', 'Red'],
  );
  // Territory belongs to Blue even though the Red piece occupies it.
  assert.deepEqual(
    [grid[8]?.[8]?.occupant, grid[8]?.[8]?.occupantOwner, grid[8]?.[8]?.ownerColor],
    ['Scissors', 'Red', 'Blue'],
  );
});

test('a live row without preview fields uses the mode opening instead of a blank board', () => {
  const grid = liveGameGrid(
    {},
    [
      '...SSS...',
      '...PPP...',
      '...RRR...',
      '.........',
      '.........',
      '.........',
      '...rrr...',
      '...ppp...',
      '...sss...',
    ],
  );

  assert.deepEqual(
    [grid[0]?.[3]?.occupant, grid[0]?.[3]?.occupantOwner],
    ['Scissors', 'Blue'],
  );
  assert.deepEqual(
    [grid[8]?.[5]?.occupant, grid[8]?.[5]?.occupantOwner],
    ['Scissors', 'Red'],
  );
});

test('a missing or invalid live move number stays at the opening position', () => {
  assert.equal(liveMoveLabel(undefined), 'Opening position');
  assert.equal(liveMoveLabel(Number.NaN), 'Opening position');
  assert.equal(liveMoveLabel(0), 'Opening position');
  assert.equal(liveMoveLabel(1), 'Move 2');
});

test('everyone waiting is one list, searching players first', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    openChallenges: [openChallenge('c1', 'Ada'), openChallenge('c2', 'Bo', true)],
  });
  // Bo pressed play and is sitting there expecting a game; Ada's posted game
  // will wait ten minutes for one. The urgent one goes on top.
  assert.equal(snapshot.waiting[0]?.label, 'Bo');
  assert.equal(snapshot.waiting[1]?.label, 'Ada');
  assert.equal(waitingCount(snapshot), 2);
});

test('each waiting row carries the game on offer and the mode that defines it', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    openChallenges: [openChallenge('c1', 'Ada')],
  });
  // The rail draws a board for every row, and looking the mode up there would
  // be the second place that knows how.
  assert.equal(snapshot.waiting[0]?.mode?.name, 'Total War');
  assert.equal(snapshot.waiting[0]?.challenge.id, 'c1');
  assert.equal(snapshot.waiting[0]?.modeId, 'V5');
});

test('your own open challenge stays on the board, marked as yours', () => {
  const mine = openChallenge('c1', 'Viewer');
  mine.challenger.userId = 'viewer';
  const snapshot = liveSnapshot({
    ...emptySource(),
    openChallenges: [mine, openChallenge('c2', 'Ada')],
  });
  // Hiding it would lose the only feedback that a posted game is up; offering
  // it back as something to accept would offer a game the server refuses.
  assert.equal(snapshot.waiting.length, 2);
  assert.equal(snapshot.waiting.find((seat) => seat.key === 'c1')?.mine, true);
  assert.equal(snapshot.waiting.find((seat) => seat.key === 'c2')?.mine, false);
});

test('a private challenge is nobody\'s to take, so it is not on the board', () => {
  const invitation = openChallenge('c1', 'Ada');
  (invitation as { targetUsername?: string }).targetUsername = 'Bo';
  const snapshot = liveSnapshot({
    ...emptySource(),
    openChallenges: [invitation, openChallenge('c2', 'Cleo')],
  });
  assert.equal(snapshot.waiting.length, 1);
  assert.equal(snapshot.waiting[0]?.key, 'c2');
});

test('the headline leaves out everything that is zero', () => {
  assert.equal(liveHeadline(liveSnapshot({ ...emptySource(), onlineCount: 3 })), '3 here');
  assert.equal(
    liveHeadline(
      liveSnapshot({
        ...emptySource(),
        onlineCount: 12,
        liveGames: [liveGame('a'), liveGame('b', { seriesId: 's' })],
        openChallenges: [openChallenge('c1', 'Ada')],
      }),
    ),
    '12 here · 2 live · 1 waiting',
  );
});

test('a running tournament outranks an open signup, and a finished one is history', () => {
  const registration = { tournamentId: 'r', status: 'registration' };
  const running = { tournamentId: 'p', status: 'in_progress' };
  const done = { tournamentId: 'd', status: 'completed' };
  const source = emptySource();

  assert.equal(
    liveSnapshot({ ...source, tournaments: [registration, running] as never })
      .activeTournament?.tournamentId,
    'p',
  );
  assert.equal(
    liveSnapshot({ ...source, tournaments: [registration] as never })
      .activeTournament?.tournamentId,
    'r',
  );
  assert.equal(
    liveSnapshot({ ...source, tournaments: [done] as never }).activeTournament,
    null,
  );
});

test('a busy engine is joined to the board it is sitting at', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    engineBots: [engineBot('b1', 'Pebble', { busy: true })],
    liveGames: [seatedGame('g1', 'someone', 'b1-user')],
  });

  const [seat] = snapshot.engines;
  // The roster says busy; it does not say which board. Without this join the
  // rail can only print a number, which is what it used to do.
  assert.equal(seat?.game?.gameId, 'g1');
  assert.equal(seat?.color, 'Blue');
  assert.equal(seat?.opponentName, 'someone');
  assert.equal(seat?.mode?.name, 'Total War');
  assert.equal(seat?.status.label, 'PLAYING');
  // A person is in this one, so the board keeps the featured slot at the top of
  // the rail and this row points at it rather than drawing it again.
  assert.equal(seat?.showsBoard, false);
});

test('both engines of a series are listed, and the board is drawn once', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    engineBots: [
      engineBot('b1', 'Zeta', { busy: true }),
      engineBot('b2', 'Alpha', { busy: true }),
    ],
    liveGames: [seatedGame('g1', 'b1-user', 'b2-user', { seriesId: 's1' })],
  });

  assert.deepEqual(
    snapshot.engines.map((seat) => [seat.bot.name, seat.showsBoard]),
    [
      ['Alpha', true],
      ['Zeta', false],
    ],
  );
  // Two rows, one game: both point at the same board rather than at two.
  assert.equal(snapshot.engines[1]?.game?.gameId, 'g1');
  assert.equal(snapshot.engines[0]?.opponentName, 'b1-user');
});

test('engines at work come first, and a private one sorts last', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    engineBots: [
      engineBot('b1', 'Quiet', { allowPublicPlay: false }),
      engineBot('b2', 'Ready'),
      engineBot('b3', 'Working', { busy: true }),
    ],
    liveGames: [seatedGame('g1', 'b3-user', 'human')],
  });

  assert.deepEqual(
    snapshot.engines.map((seat) => [seat.bot.name, seat.status.label]),
    [
      ['Working', 'PLAYING'],
      ['Ready', 'IDLE'],
      ['Quiet', 'PRIVATE'],
    ],
  );
});

test('a busy engine whose game has already ended is still a row, without a board', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    engineBots: [engineBot('b1', 'Pebble', { busy: true })],
    liveGames: [],
  });

  // The snapshot can land a beat after the game finished. Dropping the engine
  // would make the roster count and the list disagree.
  assert.equal(snapshot.engines.length, 1);
  assert.equal(snapshot.engines[0]?.game, null);
  assert.equal(snapshot.engines[0]?.showsBoard, false);
});

test('an idle engine is never joined to a board it merely appears in', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    engineBots: [engineBot('b1', 'Pebble')],
    liveGames: [seatedGame('g1', 'b1-user', 'human')],
  });

  // Only the roster knows whether an engine is playing. A stale live row that
  // still names it must not put a "PLAYING" board under an idle engine.
  assert.equal(snapshot.engines[0]?.status.label, 'IDLE');
  assert.equal(snapshot.engines[0]?.game, null);
});

test('a board the engine rows draw is not featured a second time above them', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    engineBots: [
      engineBot('b1', 'Zephyr', { busy: true }),
      engineBot('b2', 'Anvil', { busy: true }),
    ],
    liveGames: [
      seatedGame('series', 'b1-user', 'b2-user', { seriesId: 's1' }),
      seatedGame('humans', 'ada', 'bo'),
    ],
  });

  // The engines' own game is explained by the rows around it. Featuring it as
  // well is the same board twice in a column 296 points wide.
  assert.deepEqual(
    snapshot.watchable.map((game) => game.gameId),
    ['humans'],
  );
  // Both are still live, which is what the phone's top-bar line counts.
  assert.equal(liveHeadline(snapshot).includes('2 live'), true);
});

test('an engine playing a person leaves that board at the top of the rail', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    engineBots: [engineBot('b1', 'Zephyr', { busy: true })],
    liveGames: [seatedGame('mixed', 'b1-user', 'ada')],
  });

  // A game with a person in it is something to watch, so it keeps the featured
  // slot and the engine row points at it rather than redrawing it.
  assert.deepEqual(
    snapshot.watchable.map((game) => game.gameId),
    ['mixed'],
  );
  assert.equal(snapshot.engines[0]?.showsBoard, false);
  assert.equal(snapshot.engines[0]?.opponentName, 'ada');
});

test('a series whose engines are not on the roster is still watchable', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    engineBots: [],
    liveGames: [seatedGame('series', 'gone-1', 'gone-2', { seriesId: 's1' })],
  });

  // Nothing below claims this board, so dropping it from the watch list would
  // lose it from the rail entirely.
  assert.deepEqual(
    snapshot.watchable.map((game) => game.gameId),
    ['series'],
  );
});

// A draining engine is on its way out: it is playing what it already owes and
// will take nothing new. The badge and the button have to agree about that, and
// they agree by both coming from here.
test('an engine shutting down says so ahead of anything else it is doing', () => {
  const draining = engineBot('one', 'Leaver', { draining: true, busy: true });
  assert.equal(engineStatus(draining).label, 'SHUTTING DOWN');
  assert.equal(engineStatus(draining).activity, 'draining');
  assert.equal(engineIsAvailable(draining), false);
});

// A bench is not a shutdown, and the whole reason the server publishes them
// apart is that saying SHUTTING DOWN against every engine on the ladder for an
// afternoon reads as a broken server rather than as a scheduled break.
test('a benched engine is described as benched rather than as shutting down', () => {
  const benched = engineBot('one', 'Waiting', { benched: true });
  assert.equal(engineStatus(benched).activity, 'benched');
  assert.equal(engineStatus(benched).label, 'OFFLINE FOR THE TOURNAMENT');
  assert.equal(engineIsAvailable(benched), false);
});

// And it wins over every other reason, including a game the engine is still
// finishing: PLAYING would invite somebody to wait for the board to clear and
// then challenge it, which is the one thing that cannot work during a bench.
test('a bench outranks the game a benched engine is still finishing', () => {
  const benched = engineBot('one', 'Waiting', { benched: true, busy: true, draining: true });
  assert.equal(engineStatus(benched).activity, 'benched');
});

test('an idle engine carries a rating in every mode it plays, not one number', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    engineBots: [
      engineBot('b1', 'Pebble', {
        modes: ['V5', 'V3'],
        elo: 1500,
        modeRatings: { V5: 1834, V3: 1902 },
      }),
    ],
  });

  // Nothing about an idle engine says which mode to read it in, and the same
  // engine is hundreds of points apart in the two. One number would be a
  // rating for a mode nobody named.
  assert.deepEqual(
    snapshot.engines[0]?.ratings.map((rating) => [rating.shortCode, rating.elo]),
    [
      ['V5', 1834],
      ['V3', 1902],
    ],
  );
});

test('an engine only rated in one mode is seeded in the other, not left blank', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    engineBots: [engineBot('b1', 'Pebble', { modes: ['V5', 'V3'], elo: 1500, modeRatings: { V5: 1834 } })],
  });

  // The server seeds a mode's first rated game from the shared rating, so this
  // is the number it would actually queue at rather than a gap in the row.
  assert.deepEqual(
    snapshot.engines[0]?.ratings.map((rating) => [rating.shortCode, rating.elo]),
    [
      ['V5', 1834],
      ['V3', 1500],
    ],
  );
});

test('an engine lists only the modes it plays, and every mode when it says none', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    engineBots: [
      engineBot('b1', 'OneMode', { modes: ['V3'], modeRatings: { V5: 1834, V3: 1902 } }),
      engineBot('b2', 'Unsaid', { modeRatings: { V5: 1600, V3: 1700 } }),
    ],
  });

  // A rating in a mode the engine will not accept a game in is a number nobody
  // can act on; an engine that declares nothing is offered every mode already.
  assert.deepEqual(
    snapshot.engines.map((seat) => seat.ratings.map((rating) => rating.shortCode)),
    [['V3'], ['V5', 'V3']],
  );
});

test('a playing engine is rated in the mode of the board it is at', () => {
  const snapshot = liveSnapshot({
    ...emptySource(),
    engineBots: [
      engineBot('b1', 'Pebble', {
        busy: true,
        modes: ['V5', 'V3'],
        modeRatings: { V5: 1834, V3: 1902 },
      }),
    ],
    liveGames: [seatedGame('g1', 'b1-user', 'someone')],
  });

  // The board names its mode, so the row has one rating to show and the width
  // for the rest of what it is doing.
  assert.deepEqual(
    snapshot.engines[0]?.ratings.map((rating) => [rating.shortCode, rating.elo]),
    [['V5', 1834]],
  );
});

test('engineElo answers with the shared seed only where a mode has no rating', () => {
  const bot = engineBot('b1', 'Pebble', { elo: 1500, modeRatings: { V5: 1834 } });

  assert.equal(engineElo(bot, 'V5'), 1834);
  assert.equal(engineElo(bot, 'V3'), 1500);
});

test('an idle engine open to play is the only one that can take a game', () => {
  assert.equal(engineIsAvailable(engineBot('one', 'Ready')), true);
  assert.equal(engineIsAvailable(engineBot('two', 'Busy', { busy: true })), false);
  assert.equal(
    engineIsAvailable(engineBot('three', 'Private', { allowPublicPlay: false })),
    false,
  );
  assert.equal(engineIsAvailable(engineBot('four', 'Leaving', { draining: true })), false);
});

// A draining engine mid-game is still on a board worth watching, so the rail
// has to keep joining it to that board rather than dropping it the moment its
// badge stops saying PLAYING.
test('a draining engine still shows the board it is finishing', () => {
  const bot = engineBot('one', 'Leaver', { draining: true, busy: true });
  const snapshot = liveSnapshot({
    ...emptySource(),
    engineBots: [bot],
    liveGames: [seatedGame('g1', 'one-user', 'other')],
  });
  assert.equal(snapshot.engines[0]?.game?.gameId, 'g1');
});
