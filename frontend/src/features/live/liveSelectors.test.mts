import assert from 'node:assert/strict';
import test from 'node:test';

import {
  liveHeadline,
  liveSnapshot,
  waitingCount,
  type LiveSource,
} from './liveSelectors.ts';
import type { Challenge, LiveGameSummary } from '../../types/protocol.ts';
import type { ModeDefinition } from '../../types/game.ts';

const MODES = [
  { id: 'V5', name: 'Total War' },
  { id: 'V3', name: 'Infiltration' },
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
  assert.equal(liveHeadline(liveSnapshot({ ...emptySource(), onlineCount: 3 })), '3 online');
  assert.equal(
    liveHeadline(
      liveSnapshot({
        ...emptySource(),
        onlineCount: 12,
        liveGames: [liveGame('a'), liveGame('b', { seriesId: 's' })],
        openChallenges: [openChallenge('c1', 'Ada')],
      }),
    ),
    '12 online · 2 live · 1 waiting',
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
