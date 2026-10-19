// A capture drawn as the throw that won it: rock smashes scissors, scissors
// snip paper, paper wraps rock.
//
// Each is a few hundred milliseconds laid over the square the capture happened
// on, and each follows its own sound (`tools/generate-game-sounds.py`): a blunt
// impact with a fragment thrown off it, two quick closes with a cut between
// them, a muffled landing with a sweep closing over it. Every clip strikes as
// the move begins, so the picture strikes as early as it honestly can: when
// the taker reaches its victim, a few frames into its slide rather than at the
// end of it.
//
// This file is the part that can be reasoned about without a screen: *whether*
// a change of position gets an effect, and *what* the effect does, as data.
// `CaptureEffectLayer.tsx` draws it.
//
// It is decoration, and three rules keep it that way. It never holds anything
// up: the board's move animation, the drag lock that comes with it, the clock
// and the next move all run exactly as they did without it, and an effect still
// playing when the next position arrives is either left to finish or dropped.
// It never moves the page: everything it draws is a transform inside the
// board's own clipped surface. And it gives way to Reduce Motion, which gets
// the capture the board has always drawn: the taker slides in and the piece it
// took is gone when it lands.

import {
  captureBetweenGrids,
  captureMatchup,
  type Capture,
  type CaptureMatchup,
} from '@/engine/captureMatchup';
import type { Grid, Piece, Position } from '@/types/game';
import type { PieceLook } from './pieceLook';

/** How long an effect lasts, counted from the start of the move that made it. */
export const CAPTURE_EFFECT_DURATION = 300;

/**
 * How soon after the previous change of position a step through a record counts
 * as skimming.
 *
 * Somebody reading a game one move at a time is a second or more apart;
 * somebody tapping their way to move forty, or holding an arrow key, is far
 * under this. A step that arrives while the last effect would still be playing
 * is not a step anybody stopped to look at.
 */
export const SKIMMING_STEP_MS = 400;

/** Why a capture is drawn the plain way. Said for the tests, never on screen. */
export type CaptureEffectSkip =
  /** The change of position was not one capture played forwards. */
  | 'no-capture'
  /** Kinds that are not drawn as rock, paper and scissors. */
  | 'not-a-throw'
  | 'reduced-motion'
  /** Stepping through a record faster than an effect lasts. */
  | 'skimming';

export interface CaptureEffectInput {
  before: Grid;
  after: Grid;
  /**
   * Where along a line of positions the board moved, when it stands on one: a
   * live game's history, a review, a watched bot battle. Absent on a board that
   * is only ever handed a position, such as the analysis board.
   */
  step: { from: number; to: number } | null;
  /** The last index of that line now. */
  lineEnd: number | null;
  /** The last index of that line the previous time the board moved. */
  lineEndBefore: number | null;
  /** Milliseconds since the board's previous change of position. */
  sinceLastChange: number;
  reducedMotion: boolean;
  /** How a mode's own kinds are drawn. Absent for the built-in modes. */
  looks?: Record<string, PieceLook>;
}

export type CaptureEffectDecision =
  | { play: true; capture: Capture; matchup: CaptureMatchup; live: boolean }
  | { play: false; reason: CaptureEffectSkip };

const THROWS = new Set(['rock', 'paper', 'scissors']);

/**
 * The throw a kind is drawn as: the artwork its mode lends it, then its own id.
 * The same order `PieceIcon` looks for a picture in, so a mode's Boulder that
 * is drawn as a rock smashes like one.
 */
const drawnAs = (piece: Piece, looks: Record<string, PieceLook> | undefined) => {
  const art = looks?.[piece]?.art?.toLowerCase();
  return art && THROWS.has(art) ? art : piece;
};

/**
 * Whether the board was standing at the newest position of a game and was
 * carried on to the next one as it was played.
 *
 * That is what tells a move happening now from a step through the record,
 * which look the same from here: one position forward. A live board is moved
 * to the new position a render after the line grows, so the line's end is
 * compared as it stood when the board last moved, not as it stood last render.
 */
const followsTheGame = ({ step, lineEnd, lineEndBefore }: CaptureEffectInput) =>
  step !== null && lineEnd !== null && step.from === lineEndBefore && step.to === lineEnd;

const skip = (reason: CaptureEffectSkip): CaptureEffectDecision => ({ play: false, reason });

/**
 * Whether this change of position gets a capture effect, and which.
 *
 * One move forward onto a capture plays it: a move made now, by either side, in
 * a game being played or watched, and a step forward through a record. A step
 * back never does — taking a capture back is not a capture — and nor does a
 * jump of several moves.
 *
 * Stepping through a record plays it only when the step was taken on its own.
 * Skimming gets the plain capture, because a flourish on every capture of a game
 * flicked through at speed is noise, and it would land on positions the reader
 * has already left. A game that is being followed as it is played is exempt:
 * a watched bot battle moves every quarter of a second, and every capture in
 * it is still a capture happening now.
 */
export const decideCaptureEffect = (input: CaptureEffectInput): CaptureEffectDecision => {
  const { step } = input;
  if (step && step.to !== step.from + 1) return skip('no-capture');
  const capture = captureBetweenGrids(input.before, input.after);
  if (!capture) return skip('no-capture');
  const matchup = captureMatchup(
    drawnAs(capture.attacker.piece, input.looks),
    drawnAs(capture.victim.piece, input.looks),
  );
  if (!matchup) return skip('not-a-throw');
  if (input.reducedMotion) return skip('reduced-motion');
  const live = followsTheGame(input);
  if (!live && input.sinceLastChange < SKIMMING_STEP_MS) return skip('skimming');
  return { play: true, capture, matchup, live };
};

/**
 * Whether an effect still playing outlives the board moving on.
 *
 * Only a step forward that leaves its square alone. That is the common case in
 * a fast game — the reply arrives while a capture is still settling — and
 * cutting the effect short there would make every quick exchange stutter. A
 * step back takes the capture under it back, and a move onto or off its square
 * would draw the remains over a different exchange, so both end it.
 */
export const effectOutlivesStep = (
  square: Position,
  { step, before, after }: Pick<CaptureEffectInput, 'step' | 'before' | 'after'>,
) => {
  if (step && step.to !== step.from + 1) return false;
  const was = before[square.y]?.[square.x];
  const now = after[square.y]?.[square.x];
  return Boolean(
    was && now && was.occupant === now.occupant && was.occupantOwner === now.occupantOwner,
  );
};

// ---------------------------------------------------------------------------
// Choreography
//
// Everything below is milliseconds from the start of the move and the value
// there, in order, interpolated straight between: the board's own clock runs
// on the native thread, where an interpolation is a polyline and nothing more.
// Sizes are in squares, so one recipe serves a phone's board and a monitor's.
//
// A recipe is written for a taker that meets its victim at `IMPACT_MS`, and
// `retime` moves it to the moment this move's taker actually does: at once
// after a drop, later on a diagonal. The effect still ends when it ends.
// ---------------------------------------------------------------------------

/** `[milliseconds from the start of the move, value]`, in time order. */
export type Keyframes = readonly (readonly [number, number])[];

/** The meeting every recipe below is written for. */
export const IMPACT_MS = 40;

/**
 * How close the taker's middle has to come to its victim's before the two
 * count as meeting, in squares. A piece is three quarters of a square across,
 * so by this distance they overlap by a fifth of a square: close enough that
 * the hit and the touch look like the same moment.
 */
const MEETING_DISTANCE = 0.55;

/**
 * The latest a meeting may be, so the taker is always back to its own size
 * before the board's move animation ends; see `ATTACKER_SETTLED_BY_MS`.
 */
export const LATEST_IMPACT_MS = 75;

/**
 * When the taker meets its victim, for a taker that sets off `distance` squares
 * from it and slides there with the board's ease-out over `moveDuration`.
 *
 * An orthogonal step meets at about 40ms and a diagonal one at about 60ms. A
 * piece dropped on its victim's square has met it already. Every capture clip
 * strikes as the move begins, so these are as early as the picture can honestly
 * be.
 */
export const impactAfter = (distance: number, moveDuration: number) => {
  if (!(distance > MEETING_DISTANCE)) return 0;
  const progress = 1 - MEETING_DISTANCE / distance;
  const time = (1 - Math.cbrt(1 - progress)) * moveDuration;
  return Math.min(LATEST_IMPACT_MS, Math.round(time));
};

/**
 * A recipe's moment, moved from the meeting it was written for to this one.
 *
 * Two straight pieces: the approach is stretched or squeezed to end at the new
 * meeting, and everything after it to fit between the meeting and the end.
 */
export const retime = (ms: number, impact: number) =>
  ms <= IMPACT_MS
    ? (ms * impact) / IMPACT_MS
    : impact +
      ((ms - IMPACT_MS) * (CAPTURE_EFFECT_DURATION - impact)) /
        (CAPTURE_EFFECT_DURATION - IMPACT_MS);

/**
 * A recipe's keyframes for this meeting, ready to interpolate.
 *
 * A meeting at the very start squeezes the approach to nothing, and a native
 * interpolation cannot take two points at one time; the later one is nudged
 * along by half a millisecond, which keeps the jump and loses nothing visible.
 */
export const keyframesFor = (frames: Keyframes, impact: number) => {
  const times: number[] = [];
  const values: number[] = [];
  for (const [ms, value] of frames) {
    const previous = times[times.length - 1];
    const at = retime(ms, impact);
    times.push(previous === undefined ? at : Math.max(at, previous + 0.5));
    values.push(value);
  }
  return { times, values };
};

/**
 * When the taker has to be back to its own size.
 *
 * The board's move animation ends at 230ms and hands the piece over to the
 * settled board, which draws it at its ordinary size; anything still scaled
 * then would jump. Written for `IMPACT_MS`, and still inside 230ms after the
 * latest meeting `retime` can move it to.
 */
export const ATTACKER_SETTLED_BY_MS = 200;

/** How the piece that fell comes apart. Drawn beneath the taker. */
export type VictimMotion =
  /** Four pieces thrown outwards along the diagonals, spinning as they go. */
  | {
      kind: 'shatter';
      /** How far each piece flies, in squares. */
      drift: number;
      /** How far each piece turns, in degrees. */
      spin: number;
      /** 0 to 1: how much of the drift and spin is done. */
      travel: Keyframes;
      scale: Keyframes;
      opacity: Keyframes;
    }
  /** Cut in two along the taker's path; the halves part and tip away. */
  | {
      kind: 'split';
      /** How far each half moves off the cut, in squares. */
      parting: number;
      /** How far each half tips, in degrees. */
      tilt: number;
      travel: Keyframes;
      opacity: Keyframes;
    }
  /** Shrinks away under the sheet that lands on it. */
  | { kind: 'swallow'; scale: Keyframes; opacity: Keyframes };

/** The mark drawn round the square with it. Scale is of a square. */
export type AccentMotion =
  /** Dust thrown out round the impact: a ring, beneath the pieces. */
  | { kind: 'ring'; scale: Keyframes; opacity: Keyframes }
  /** The cut, drawn along the taker's path, above the pieces. */
  | {
      kind: 'cut';
      /** The cut's length, in squares. */
      length: number;
      /** 0 to 1: how much of the length is drawn. */
      reach: Keyframes;
      opacity: Keyframes;
    }
  /** The air a landing sheet pushes out: a soft disc, beneath the pieces. */
  | { kind: 'puff'; scale: Keyframes; opacity: Keyframes };

export interface Choreography {
  /** The taker's size as it lands, on the board's own moving piece. */
  attackerScale: Keyframes | null;
  victim: VictimMotion;
  accent: AccentMotion;
}

export const CHOREOGRAPHY: Record<CaptureMatchup, Choreography> = {
  // Blunt: the rock bears down as it lands and the scissors come apart under
  // it, thrown out in four pieces with a ring of dust.
  rockTakesScissors: {
    attackerScale: [
      [0, 1],
      [IMPACT_MS, 1],
      [IMPACT_MS + 30, 0.9],
      [160, 1],
    ],
    victim: {
      kind: 'shatter',
      drift: 0.4,
      spin: 40,
      travel: [
        [IMPACT_MS, 0],
        [IMPACT_MS + 40, 0.55],
        [140, 0.82],
        [250, 1],
      ],
      scale: [
        [IMPACT_MS, 1],
        [250, 0.55],
      ],
      opacity: [
        [0, 1],
        [100, 1],
        [220, 0],
      ],
    },
    // A quick, sharp ring: it is gone before the paper's slower puff would
    // even have begun, which keeps the two from reading alike.
    accent: {
      kind: 'ring',
      scale: [
        [IMPACT_MS, 0.55],
        [120, 1.05],
        [220, 1.3],
      ],
      opacity: [
        [IMPACT_MS, 0],
        [IMPACT_MS + 20, 0.7],
        [220, 0],
      ],
    },
  },
  // Two quick closes: the cut is drawn along the scissors' path as the blades
  // reach the paper, and the paper falls apart either side of it.
  scissorsTakesPaper: {
    attackerScale: null,
    victim: {
      kind: 'split',
      parting: 0.18,
      tilt: 12,
      travel: [
        [IMPACT_MS + 10, 0],
        [100, 0.45],
        [160, 0.8],
        [280, 1],
      ],
      opacity: [
        [0, 1],
        [150, 1],
        [280, 0],
      ],
    },
    accent: {
      kind: 'cut',
      length: 0.95,
      reach: [
        [IMPACT_MS, 0],
        [IMPACT_MS + 25, 1],
      ],
      opacity: [
        [IMPACT_MS, 0],
        [IMPACT_MS + 8, 1],
        [140, 1],
        [210, 0],
      ],
    },
  },
  // Muffled: the paper rises as it reaches the rock and settles over it, the
  // rock shrinking away underneath, and the air it pushes out spreads round it.
  paperTakesRock: {
    attackerScale: [
      [0, 1],
      [IMPACT_MS, 1.1],
      [110, 1.2],
      [165, 0.96],
      [ATTACKER_SETTLED_BY_MS, 1],
    ],
    victim: {
      kind: 'swallow',
      scale: [
        [IMPACT_MS, 1],
        [160, 0.45],
      ],
      opacity: [
        [0, 1],
        [80, 1],
        [160, 0],
      ],
    },
    accent: {
      kind: 'puff',
      scale: [
        [120, 0.85],
        [280, 1.3],
      ],
      opacity: [
        [120, 0],
        [165, 0.42],
        [280, 0],
      ],
    },
  },
};
