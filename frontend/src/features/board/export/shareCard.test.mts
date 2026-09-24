// What the exported picture is made of.
//
// Geometry is the part of a drawing that goes wrong silently — a band drawn
// with nothing in it, a tray that runs under the clock, a switch that turns
// something off everywhere except the space it was taking up. None of that is
// visible in a screenshot until somebody looks closely at the right one, and
// all of it is decided here rather than in the canvas, which is the whole
// reason the card is planned before it is painted.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAnalysisGame } from '@/engine/analysisGame';
import { testMode } from '@/testing/modes';

import {
  buildShareCard,
  type CardShape,
  type ShareCardDetail,
  type ShareCardInput,
} from './shareCard';

const V5 = testMode('V5');
const opening = createAnalysisGame(V5);

const board = (overrides: Partial<ShareCardInput>) =>
  buildShareCard({
    grid: opening.grid,
    currentTurn: opening.currentTurn,
    mode: V5,
    ...overrides,
  });

const PLAYERS: ShareCardDetail = {
  players: { Red: { name: 'Alice', detail: '1200' }, Blue: { name: 'Bob', detail: '1240' } },
  clock: { Red: 300_000, Blue: 292_000 },
  captured: {
    Red: { Rock: 1, Paper: 0, Scissors: 2 },
    Blue: { Rock: 0, Paper: 0, Scissors: 0 },
  },
  caption: 'Move 14 · Blue to move',
  site: 'rps.example',
};

const texts = (shapes: CardShape[]) =>
  shapes.flatMap((shape) => (shape.kind === 'text' ? [shape.text] : []));

const pieces = (shapes: CardShape[]) => shapes.filter((shape) => shape.kind === 'piece');

test('every switch off leaves the board and nothing else', () => {
  const bare = board({
    detail: PLAYERS,
    options: {
      names: false,
      clocks: false,
      captures: false,
      coordinates: false,
      lastMove: false,
      labels: false,
    },
  });
  assert.deepEqual(texts(bare.shapes), [], 'nothing is written on a bare board');
  // Eighteen pieces and no tray, so the picture is the position alone. The
  // card is then the board plus its padding, which is the claim that the bands
  // and the labels cost nothing when they are off rather than leaving a gap.
  assert.equal(pieces(bare.shapes).length, 18);
  assert.equal(bare.height, bare.width, 'a square board makes a square card');
});

test('a band appears for what it would carry, and not otherwise', () => {
  const withNames = board({ detail: PLAYERS, options: { labels: false } });
  assert.ok(texts(withNames.shapes).includes('Alice'));
  assert.ok(texts(withNames.shapes).includes('Bob'));
  assert.ok(withNames.height > withNames.width, 'the bands make the card taller than the board');

  // The names switched off but the clocks left on is still two bands, because
  // a clock is something to carry. Everything off is no bands at all.
  const clocksOnly = board({
    detail: PLAYERS,
    options: { names: false, captures: false, labels: false },
  });
  assert.ok(!texts(clocksOnly.shapes).includes('Alice'));
  assert.equal(clocksOnly.height, withNames.height, 'a band is a band whatever is in it');

  const nothing = board({
    detail: PLAYERS,
    options: { names: false, clocks: false, captures: false, labels: false },
  });
  assert.equal(nothing.height, nothing.width, 'and with nothing to carry it is gone');
});

test('a board with no players is offered no band to put them in', () => {
  const analysis = board({ detail: { caption: 'Blue to move' }, options: { labels: false } });
  assert.equal(analysis.height, analysis.width);
});

test('the clock is drawn the way the player bar spells it', () => {
  const written = texts(board({ detail: PLAYERS, options: { labels: false } }).shapes);
  assert.ok(written.includes('5:00'), 'five minutes');
  assert.ok(written.includes('4:52'), 'and the other side, to the second');

  // Under twenty seconds a tenth is the difference between two games, so it is
  // written down — the same threshold `PlayerBar` uses on the live clock.
  const low = texts(
    board({
      detail: { ...PLAYERS, clock: { Red: 8_400, Blue: 19_999 } },
      options: { labels: false },
    }).shapes,
  );
  assert.ok(low.includes('0:08.4'));
  assert.ok(low.includes('0:19.9'));
});

test('the tray holds what a side has taken, in the other side’s colour', () => {
  const plan = board({ detail: PLAYERS, options: { labels: false } });
  // Red has taken one rock and two scissors; the pieces are Blue's, because
  // they are the ones that came off the board. Eighteen are on the board.
  const tray = pieces(plan.shapes).filter((piece) => piece.size < 30);
  assert.equal(tray.length, 3);
  assert.ok(tray.every((piece) => piece.color === 'Blue'));

  const bare = board({
    detail: { ...PLAYERS, captured: undefined },
    options: { labels: false },
  });
  assert.equal(pieces(bare.shapes).filter((piece) => piece.size < 30).length, 0);
});

test('the labels say which mode this is, and sign the picture', () => {
  const written = texts(board({ detail: PLAYERS }).shapes);
  assert.ok(written.includes('TOTAL WAR'), 'the mode leads, upper case');
  assert.ok(written.includes('RPS STRATEGY'));
  assert.ok(written.includes('Move 14 · Blue to move'));
  assert.ok(written.includes('rps.example'));
});

test('turning the board round moves the bands, not the pieces', () => {
  const straight = board({ detail: PLAYERS, options: { labels: false } });
  const turned = board({ detail: PLAYERS, flipped: true, options: { labels: false } });
  assert.equal(straight.width, turned.width);
  assert.equal(straight.height, turned.height);

  // Red is drawn away from the viewer, so turning the board puts Blue on top.
  const firstName = (plan: typeof straight) =>
    texts(plan.shapes).find((text) => text === 'Alice' || text === 'Bob');
  assert.equal(firstName(straight), 'Alice', 'Red opposite an unturned board');
  assert.equal(firstName(turned), 'Bob');

  // a1 is drawn bottom-left unturned and top-right turned, which is the half
  // turn a chessboard makes: the files mirror and the ranks do not.
  const corner = (plan: typeof straight) => {
    const tiles = plan.shapes.filter(
      (shape): shape is Extract<CardShape, { kind: 'rect' }> =>
        shape.kind === 'rect' && shape.width === shape.height && shape.width > 40,
    );
    const left = Math.min(...tiles.map((tile) => tile.x));
    const top = Math.min(...tiles.map((tile) => tile.y));
    return { left, top };
  };
  assert.deepEqual(corner(straight), corner(turned), 'the board itself does not move');
});

test('a board wider than it is tall keeps its shape', () => {
  const wide = testMode('V5', {
    startingPosition: { rows: ['RRRRRRRRRRR', '...........', '...........', 'rrrrrrrrrrr'] },
  });
  const game = createAnalysisGame(wide);
  const plan = buildShareCard({
    grid: game.grid,
    currentTurn: game.currentTurn,
    mode: wide,
    options: { labels: false },
  });
  assert.ok(plan.width > plan.height, 'eleven by four is a landscape card');
});
