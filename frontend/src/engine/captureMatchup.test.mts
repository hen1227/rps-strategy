import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { captureBetweenGrids, captureMatchup, type CaptureMatchup } from './captureMatchup';
import { captureSoundFor, type GameSound } from '@/appearance/gameSound';
import type { Piece, PlayerColor, Tile } from '@/types/game';

interface Placement {
  color: PlayerColor;
  piece: Piece;
  x: number;
  y: number;
}

const position = (pieces: Placement[]): Tile[][] => {
  const grid = Array.from({ length: 3 }, (unusedRow, y) =>
    Array.from(
      { length: 3 },
      (unusedTile, x): Tile => ({
        occupant: 'Empty',
        occupantOwner: 'Neutral',
        ownerColor: 'Neutral',
        x,
        y,
      }),
    ),
  );
  pieces.forEach(({ color, piece, x, y }) => {
    grid[y]![x] = { ...grid[y]![x]!, occupant: piece, occupantOwner: color };
  });
  return grid;
};

/** Blue's `taker` on a1 takes Red's `victim` on b1, with a Red rock looking on from c3. */
const exchange = (taker: Piece, victim: Piece) => ({
  before: position([
    { color: 'Blue', piece: taker, x: 0, y: 0 },
    { color: 'Red', piece: victim, x: 1, y: 0 },
    { color: 'Red', piece: 'Rock', x: 2, y: 2 },
  ]),
  after: position([
    { color: 'Blue', piece: taker, x: 1, y: 0 },
    { color: 'Red', piece: 'Rock', x: 2, y: 2 },
  ]),
});

describe('capture matchups', () => {
  it('names each capture for the throw that won it', () => {
    assert.equal(captureMatchup('Rock', 'Scissors'), 'rockTakesScissors');
    assert.equal(captureMatchup('Scissors', 'Paper'), 'scissorsTakesPaper');
    assert.equal(captureMatchup('Paper', 'Rock'), 'paperTakesRock');
  });

  it('refuses a pair that is not a win', () => {
    assert.equal(captureMatchup('Scissors', 'Rock'), null);
    assert.equal(captureMatchup('Rock', 'Rock'), null);
    assert.equal(captureMatchup('Lizard', 'Spock'), null);
    assert.equal(captureMatchup(undefined, 'Rock'), null);
  });

  // Two tables name the same three facts: the clips, by the piece that fell,
  // and the board's capture effect, by both pieces. They must not drift apart.
  it('names each capture the way its clip does', () => {
    for (const [taker, victim] of [
      ['Rock', 'Scissors'],
      ['Scissors', 'Paper'],
      ['Paper', 'Rock'],
    ] as const) {
      assert.equal(captureMatchup(taker, victim), captureSoundFor(victim));
    }
  });

  it('reads an artwork name the same as a kind id', () => {
    assert.equal(captureMatchup('rock', 'SCISSORS'), 'rockTakesScissors');
  });

  it('is a sound the packs carry', () => {
    // A matchup is played as a clip by its own name, so every one of them has
    // to be a `GameSound`. This line fails to compile otherwise.
    const matchups: CaptureMatchup[] = ['rockTakesScissors', 'scissorsTakesPaper', 'paperTakesRock'];
    const sounds: GameSound[] = matchups;
    assert.equal(sounds.length, 3);
  });
});

describe('the capture between two boards', () => {
  it('finds the taker, the piece that fell, and the squares', () => {
    const { before, after } = exchange('Rock', 'Scissors');
    assert.deepEqual(captureBetweenGrids(before, after), {
      from: { x: 0, y: 0 },
      to: { x: 1, y: 0 },
      attacker: { piece: 'Rock', color: 'Blue' },
      victim: { piece: 'Scissors', color: 'Red' },
    });
  });

  // The sound hook used to find the taker's square and look its piece up in a
  // table keyed by the victim, so every capture played the next clip round the
  // cycle: rock taking scissors sounded like paper taking rock.
  it('names every capture by its taker, the reading the capture sound plays', () => {
    const played = (
      [
        ['Rock', 'Scissors'],
        ['Scissors', 'Paper'],
        ['Paper', 'Rock'],
      ] as const
    ).map(([taker, victim]) => {
      const { before, after } = exchange(taker, victim);
      const capture = captureBetweenGrids(before, after);
      return capture ? captureMatchup(capture.attacker.piece, capture.victim.piece) : null;
    });
    assert.deepEqual(played, ['rockTakesScissors', 'scissorsTakesPaper', 'paperTakesRock']);
  });

  it('is nothing for a quiet move', () => {
    const before = position([{ color: 'Blue', piece: 'Rock', x: 0, y: 0 }]);
    const after = position([{ color: 'Blue', piece: 'Rock', x: 1, y: 1 }]);
    assert.equal(captureBetweenGrids(before, after), null);
  });

  it('is nothing for the same capture played backwards', () => {
    const { before, after } = exchange('Paper', 'Rock');
    assert.equal(captureBetweenGrids(after, before), null);
  });

  it('is nothing for two moves at once', () => {
    const { before } = exchange('Rock', 'Scissors');
    const twoLater = position([
      { color: 'Blue', piece: 'Rock', x: 1, y: 0 },
      { color: 'Red', piece: 'Rock', x: 2, y: 1 },
    ]);
    assert.equal(captureBetweenGrids(before, twoLater), null);
  });

  it('is nothing for a piece landing on its own side', () => {
    const before = position([
      { color: 'Blue', piece: 'Rock', x: 0, y: 0 },
      { color: 'Blue', piece: 'Scissors', x: 1, y: 0 },
    ]);
    const after = position([{ color: 'Blue', piece: 'Rock', x: 1, y: 0 }]);
    assert.equal(captureBetweenGrids(before, after), null);
  });

  it('is nothing for boards of different shapes, or no board at all', () => {
    const { before } = exchange('Rock', 'Scissors');
    assert.equal(captureBetweenGrids(before, before.slice(0, 2)), null);
    assert.equal(captureBetweenGrids(null, before), null);
    assert.equal(captureBetweenGrids(before, before), null);
  });
});
