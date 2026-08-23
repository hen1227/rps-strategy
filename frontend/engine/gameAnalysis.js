// One way to have RPSFish grade a game, for every screen that grades one.
//
// The review screen, the bot battle, and the analysis board all want the same
// thing: an evaluation for every position of a line, a grade for every move in
// it, and an accuracy per side. They differ only in where the line comes from.
// A finished record arrives whole. A battle arrives one move at a time while
// the analysis is still catching up. An analysis board grows *and* shrinks, as
// moves are played, taken back, and replaced.
//
// A session here absorbs all three. Hand it the line as it currently stands,
// as often as it changes; it keeps the engine walking the part it has not
// graded yet, and re-grades only from the point where the line stopped being
// the line it already knows.
//
// Two rules it exists to enforce, both from `docs/review.md`:
//
//   1. Every grade comes from the review walk, never from a search that was
//      run for some other purpose. A bot's own search is how that bot chose
//      its move — it is shallow on purpose, and it is a different search per
//      side — so grading a battle with it would measure the bots against
//      themselves and call the result an evaluation.
//   2. A move's loss is read off one search of one position. The walk does
//      that with a paired root-restricted search when it has to; nothing here
//      subtracts scores that came from different searches.

import { enginePosition } from './analysisGame';
import { REVIEW_PRESETS, reviewGame } from './rpsfishClient';

export const ANALYSIS_PRESET_LABELS = Object.freeze({
  fast: 'QUICK',
  standard: 'STANDARD',
  deep: 'DEEP',
});

export const DEFAULT_ANALYSIS_PRESET = 'standard';

/**
 * The preset a game being watched is graded at.
 *
 * Deep, deliberately, and it is the reason a battle's analysis runs behind the
 * battle: at depth 12 with an eight-second ceiling a graded position costs more
 * than every bot's own move except the top rung's. The alternative — grading at
 * a budget the bots can outrun — would mean the numbers on screen were produced
 * by a weaker search than the players being judged by them.
 */
export const WATCHED_GAME_PRESET = 'deep';

const SIGNATURE_PIECES = {
  Blue: { Rock: 'R', Paper: 'P', Scissors: 'S' },
  Red: { Rock: 'r', Paper: 'p', Scissors: 's' },
};
const SIGNATURE_TERRITORY = { Red: '+', Blue: '-' };

const signatureCache = new WeakMap();

/**
 * A string that differs whenever two positions do.
 *
 * This is how a session tells "the game gained a move" from "this is no longer
 * the game I was grading": an undo, a different branch, a new battle. Positions
 * are immutable once built, so each one is encoded at most once.
 */
export const positionSignature = (game) => {
  const cached = signatureCache.get(game);
  if (cached !== undefined) return cached;
  let signature = `${game.mode?.id}|${game.currentTurn}|${game.moveNumber}`;
  for (const row of game.grid) {
    for (const tile of row) {
      signature += SIGNATURE_PIECES[tile.occupantOwner]?.[tile.occupant] ?? '.';
      signature += SIGNATURE_TERRITORY[tile.ownerColor] ?? '';
    }
  }
  signatureCache.set(game, signature);
  return signature;
};

/**
 * The first index at which two lines of play stop agreeing.
 *
 * Equal to the shorter length when one line is a prefix of the other, which is
 * the append-only case a live game produces.
 */
export const firstDivergence = (left, right) => {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return shared;
};

/**
 * A running analysis of one line of play.
 *
 * `submit({ positions, moves, streaming })` states the line as it now stands
 * and returns immediately; the walk continues in the background and `onChange`
 * fires as entries arrive. `streaming` says whether more positions are still
 * expected, which is the difference between "caught up" and "finished".
 *
 * `review` and `presets` are injectable so this can be driven by the Node
 * worker shim in a test rather than by a browser worker.
 */
export const createGameAnalysis = ({
  onChange,
  preset = DEFAULT_ANALYSIS_PRESET,
  presets = REVIEW_PRESETS,
  review = reviewGame,
} = {}) => {
  const limits = presets[preset] ?? presets[DEFAULT_ANALYSIS_PRESET];
  const controller = new AbortController();

  let entries = [];
  let signatures = [];
  let line = { positions: [], moves: [], streaming: false };
  let status = 'idle';
  let error = null;
  let busy = false;
  // Bumped whenever the line stops being the one an in-flight request was
  // asked about, so entries from that request can be recognised as stale
  // rather than dropped into the wrong place.
  let generation = 0;
  let stopped = false;

  // Only when something moved. A caller that rebuilds its `positions` array
  // every render submits an unchanged line often, and answering each of those
  // with a fresh snapshot would drive a render loop.
  let published = null;
  const publish = () => {
    if (
      published &&
      published.entries === entries &&
      published.error === error &&
      published.status === status
    ) {
      return;
    }
    published = { entries, error, status };
    onChange?.(published);
  };

  /**
   * How far into the line the walk can usefully get right now.
   *
   * One short of the end while more moves are still coming. The last position
   * of a game in progress has no move out of it yet, and a position graded
   * before its move exists yields an entry that carries an evaluation but can
   * never carry a grade — so the move eventually played from it would read as
   * ungraded for the rest of the game. It is graded when its move arrives, or
   * when the game ends and it is genuinely the last position.
   */
  const frontier = () =>
    line.streaming
      ? Math.min(line.positions.length, line.moves.length)
      : line.positions.length;

  const settle = () => {
    if (error) status = 'error';
    else if (entries.length < frontier()) status = 'running';
    else status = line.streaming ? 'waiting' : 'done';
  };

  const request = () => {
    const requestGeneration = generation;
    const analyzeFrom = entries.length;
    const end = frontier();
    const { moves, positions } = line;
    busy = true;
    // Cleared now rather than on success, so an entry arriving from this
    // attempt cannot be settled back into the failure that preceded it.
    error = null;
    status = 'running';
    publish();

    review(
      {
        analyzeFrom,
        moves: moves.slice(0, end).map(({ from, to }) => ({ from, to })),
        positions: positions.slice(0, end).map(enginePosition),
      },
      { ...limits, signal: controller.signal },
      (entry) => {
        // The walk grades in order from `analyzeFrom`, so an entry that is not
        // the next one belongs to a line this session has already moved off.
        if (stopped || requestGeneration !== generation || entry.index !== entries.length) return;
        entries = [...entries, entry];
        settle();
        publish();
      },
    )
      .then(() => {
        busy = false;
        advance();
      })
      .catch((failure) => {
        busy = false;
        if (stopped || failure?.name === 'AbortError') return;
        // A request abandoned because the line changed under it is not a
        // failure; the line it was asked about simply stopped mattering.
        if (requestGeneration !== generation) {
          advance();
          return;
        }
        // A real failure is reported rather than retried on the spot. The next
        // submission tries again, so a game still being played recovers on its
        // own next move instead of spinning here.
        error = failure.message ?? 'RPSFish could not grade this game.';
        status = 'error';
        publish();
      });
  };

  // Either keep walking or say where the walk has got to. Called after every
  // change to the line and after every request settles, so those are the only
  // two things that can move a session.
  const advance = () => {
    if (stopped) return;
    if (!busy && entries.length < frontier()) {
      request();
      return;
    }
    settle();
    publish();
  };

  return {
    submit({ moves = [], positions = [], streaming = false }) {
      if (stopped) return;
      const nextSignatures = positions.map(positionSignature);
      const divergence = firstDivergence(signatures, nextSignatures);
      signatures = nextSignatures;
      line = { moves, positions, streaming };
      // Everything from the first changed position onwards was graded for a
      // game that is no longer this one. Bumping the generation is what makes
      // a request that is already in flight for those positions stale rather
      // than wrong.
      if (divergence < entries.length) {
        entries = entries.slice(0, divergence);
        error = null;
        generation += 1;
      }
      advance();
    },
    stop() {
      stopped = true;
      controller.abort();
    },
    get limits() {
      return limits;
    },
    get preset() {
      return preset;
    },
    snapshot() {
      return { entries, error, status };
    },
  };
};
