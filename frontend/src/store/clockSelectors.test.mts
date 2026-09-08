import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { grantedTimeExtension } from './clockSelectors';
import type { ActiveGame } from './types';
import { testMode } from '@/testing/modes';
import type { PlayerColor } from '@/types/game';

const BONUS_MS = 3 * 60 * 1000;

interface Snapshot {
  redRemainingMs?: number;
  blueRemainingMs?: number;
  activeColor?: PlayerColor;
  timeOfferedBy?: PlayerColor;
  moveNumber?: number;
  gameId?: string;
}

const game = ({
  redRemainingMs = 60_000,
  blueRemainingMs = 60_000,
  activeColor = 'Red',
  timeOfferedBy,
  moveNumber = 8,
  gameId = 'game-1',
}: Snapshot = {}): ActiveGame => ({
  gameId,
  grid: [],
  mode: testMode('V5'),
  timeControl: { initialTimeMs: 300_000, incrementMs: 2_000 },
  clock: { redRemainingMs, blueRemainingMs, activeColor, updatedAtUnixMs: 0 },
  currentTurn: activeColor,
  status: 'InProgress',
  winner: 'Neutral',
  timeOfferedBy,
  moveNumber,
  redPlayer: { userId: 'red', username: 'Red' },
  bluePlayer: { userId: 'blue', username: 'Blue' },
});

describe('grantedTimeExtension', () => {
  it('reads the bonus off both clocks when a request is accepted', () => {
    const before = game({ timeOfferedBy: 'Blue' });
    const after = game({ redRemainingMs: 240_000, blueRemainingMs: 240_000 });
    assert.equal(grantedTimeExtension(before, after), BONUS_MS);
  });

  it('takes the untouched clock, not the one that has been running down', () => {
    // Red thought for four minutes before Blue granted the extension, so Red's
    // clock came out of it lower than it went in. Blue's shows the real bonus.
    const before = game({ redRemainingMs: 600_000, timeOfferedBy: 'Red' });
    const after = game({ redRemainingMs: 540_000, blueRemainingMs: 240_000 });
    assert.equal(grantedTimeExtension(before, after), BONUS_MS);
  });

  it('ignores a declined request, which adds nothing', () => {
    const before = game({ timeOfferedBy: 'Blue' });
    const after = game({ redRemainingMs: 51_000 });
    assert.equal(grantedTimeExtension(before, after), null);
  });

  it('ignores a request that is still pending', () => {
    const before = game({ timeOfferedBy: 'Blue' });
    const after = game({ redRemainingMs: 240_000, blueRemainingMs: 240_000, timeOfferedBy: 'Blue' });
    assert.equal(grantedTimeExtension(before, after), null);
  });

  it('ignores the increment a move adds', () => {
    const before = game({ timeOfferedBy: 'Blue' });
    const after = game({ redRemainingMs: 62_000, moveNumber: 9 });
    assert.equal(grantedTimeExtension(before, after), null);
  });

  it('ignores a snapshot from a different game', () => {
    const before = game({ timeOfferedBy: 'Blue' });
    const after = game({ redRemainingMs: 240_000, blueRemainingMs: 240_000, gameId: 'game-2' });
    assert.equal(grantedTimeExtension(before, after), null);
  });

  it('has nothing to say about a clockless bot game', () => {
    const before = { ...game({ timeOfferedBy: 'Blue' }), clock: null };
    const after = { ...game(), clock: null };
    assert.equal(grantedTimeExtension(before, after), null);
  });
});
