// Every knob the reach tool has, in one place.
//
// One type and one default, so a new setting is declared here and nowhere else:
// the store slice spreads it, the panel renders it, and `buildReachOverlay`
// reads it. A screen never invents its own.

import type { ObstacleModel, SafetyRule } from '@/engine/reach';
import type { PlayablePiece, Position, SideColor } from '@/types/game';

/** What the board is being asked to show. */
export type ReachView =
  /** One piece: how far it gets, move by move. */
  | 'piece'
  /** One side: the first of its pieces to arrive at each square. */
  | 'side'
  /** Both sides at once, each square coloured by whoever stands on it first. */
  | 'contest'
  /** The focused piece against the pieces that capture it. */
  | 'threat'
  /** The run to the goal, and the square that would cut it off. */
  | 'run';

export const REACH_VIEWS: readonly ReachView[] = ['piece', 'side', 'contest', 'threat', 'run'];

export const REACH_VIEW_LABELS: Record<ReachView, string> = {
  piece: 'PIECE',
  side: 'SIDE',
  contest: 'CONTEST',
  threat: 'THREAT',
  run: 'RUN',
};

export const REACH_VIEW_BLURBS: Record<ReachView, string> = {
  piece: 'Every square one piece can stand on, and how many moves it takes.',
  side: 'The whole side at once, kind by kind — R3 P4 S5, not one merged number.',
  contest: 'Both sides together. One line each: whose kind gets here, and in how many.',
  threat: 'The focused piece against the kind that captures it, both numbers on every square.',
  run: 'The shortest route to the goal nothing can cut off.',
};

/** A piece that is not on the board, put somewhere to ask what it would do. */
export interface GhostPiece {
  at: Position;
  piece: PlayablePiece;
  owner: SideColor;
}

export interface ReachSettings {
  enabled: boolean;
  view: ReachView;
  /** Distances past this are dimmed or dropped. Zero means no limit. */
  maxMoves: number;
  obstacles: ObstacleModel;
  safety: SafetyRule;
  /** Whose move to count from. `position` follows the game. */
  tempo: 'position' | SideColor;
  goalEndsGame: boolean;
  showNumbers: boolean;
  /** Outline the squares at exactly `maxMoves`. */
  showFrontier: boolean;
  /**
   * Past `maxMoves`, fade rather than drop.
   *
   * Off by default: with four bands and a board this small, fading everything
   * else still covers all eighty-one squares, and a frontier you cannot see is
   * not a frontier.
   */
  dimBeyond: boolean;
  /**
   * Wash the squares the focused piece's predators reach first.
   *
   * Off by default, and the THREAT view turns it on regardless. On an opening
   * board the enemy's papers cover most of the middle, so leaving this on made
   * every view look like the threat view and buried the distances it was drawn
   * over. One view, one claim.
   */
  showDanger: boolean;
  /** Draw the focused piece's safe run, whichever view is on. */
  showPath: boolean;
  side: SideColor;
  /** Which kinds the side and contest views count. */
  kind: PlayablePiece | 'all';
  /** The piece the piece, threat and run views follow. */
  focus: Position | null;
  /** Stop the focus following taps on the board. */
  pinned: boolean;
  ghost: GhostPiece | null;
  /** The next tap places the ghost instead of selecting. */
  placingGhost: boolean;
}

export const DEFAULT_REACH_SETTINGS: ReachSettings = {
  enabled: false,
  view: 'piece',
  maxMoves: 4,
  obstacles: 'static',
  safety: 'perStep',
  tempo: 'position',
  goalEndsGame: true,
  showNumbers: true,
  showFrontier: true,
  dimBeyond: false,
  showDanger: false,
  showPath: true,
  side: 'Red',
  kind: 'all',
  focus: null,
  pinned: false,
  ghost: null,
  placingGhost: false,
};

export const OBSTACLE_LABELS: Record<ObstacleModel, string> = {
  open: 'EMPTY BOARD',
  static: 'AS IT STANDS',
  friendlyVacates: 'FRIENDS MOVE',
};

export const OBSTACLE_BLURBS: Record<ObstacleModel, string> = {
  open: 'Ignore every piece. Pure geometry, and the floor under every other reading.',
  static: 'Believe the board: friends block, and so does any enemy this kind cannot take.',
  friendlyVacates: 'Assume your own pieces step out of the way. Enemies still block.',
};

export const SAFETY_LABELS: Record<SafetyRule, string> = {
  perStep: 'PER MOVE',
  wholeRun: 'WHOLE RUN',
  off: 'OFF',
};

export const SAFETY_BLURBS: Record<SafetyRule, string> = {
  perStep:
    'A square is safe while no predator can be standing on it by the move you arrive.',
  wholeRun:
    'Stricter: no square of the run may be reachable inside the run’s whole length.',
  off: 'Ignore predators. The shortest route, whatever is waiting on it.',
};
