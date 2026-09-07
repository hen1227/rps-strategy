import { useEffect, useMemo, useRef, useState } from 'react';

import {
  ANALYSIS_SETTLE_MS,
  analysisBudgetMs,
  analysisLadder,
  DEFAULT_ANALYSIS_EFFORT,
  type AnalysisEffort,
} from '@/engine/analysisBudget';
import {
  createGameAnalysis,
  type AnalysisSnapshot,
  type GameLine,
  type RefinePass,
} from '@/engine/gameAnalysis';
import {
  summarizeReview,
  type GradableMove,
  type RecordedMove,
  type ReviewReport,
} from '@/engine/gameReview';
import type { PositionLike } from '@/engine/analysisGame';
import { engineUnavailableMessage } from '@/engine/rpsfish/client';
import type { ReviewEntry, SearchLimits } from '@/engine/rpsfish/protocol';
import type { ModeDefinition } from '@/types/game';

const IDLE_LIMITS = analysisLadder()[0] as SearchLimits;

const EMPTY: AnalysisSnapshot = Object.freeze({
  deeperToCome: false,
  entries: [],
  error: null,
  limits: IDLE_LIMITS,
  pass: 0,
  refining: null,
  status: 'idle',
});

export interface GameAnalysisOptions<TMove extends GradableMove = RecordedMove> {
  /** Opening moves that were dealt rather than chosen, and so are not graded. */
  bookPlies?: number;
  /**
   * How much of the device the reviewer is willing to spend.
   *
   * Not a depth. `full` means "as deep as this machine manages in a sensible
   * wait", which is worked out from the device and then from how long the first
   * pass actually took; `quick` means one shallow pass and no deepening. See
   * `engine/analysisBudget.ts`.
   */
  effort?: AnalysisEffort;
  enabled?: boolean;
  /**
   * Whether the game is still being played by something that is searching.
   *
   * Raises the floor: a live game's moves are chosen by searches of their own,
   * and grading one against a weaker search than the one that chose it measures
   * nothing.
   */
  live?: boolean;
  mode: ModeDefinition | null | undefined;
  moves: TMove[];
  positions: PositionLike[];
  /** Whether more positions are still expected. */
  streaming?: boolean;
}

export interface GameAnalysisResult<TMove extends GradableMove = RecordedMove> {
  /** How many positions have been graded. */
  analyzed: number;
  /** How many moves the walk is behind the line. */
  behind: number;
  /** Whether a deeper pass may still replace these numbers. */
  deeperToCome: boolean;
  /** The depth every grade in the report was measured at. */
  depth: number;
  entries: ReviewEntry[];
  error: string | null;
  /** The budget the whole report was graded at. */
  limits: SearchLimits;
  /** Which rung of the ladder that is, counted from the shallowest. */
  pass: number;
  /** A deeper pass in flight, and how far through the line it is. */
  refining: RefinePass | null;
  report: ReviewReport<TMove> | null;
  status: AnalysisSnapshot['status'];
}

/**
 * Grade a line of play with RPSFish and keep the report up to date.
 *
 * `positions` and `moves` are the line as it currently stands. They may grow
 * between renders (a game being watched), shrink (a move taken back), or
 * diverge (a different move played from the same point); the session behind
 * this hook works out how much of its report survives each time and re-grades
 * only the rest.
 *
 * `streaming` says more positions are still coming, which is what separates
 * "the analysis has caught up with the game" from "the analysis is finished".
 *
 * Nothing here asks how deep to search. The walk starts at the shallowest
 * budget the device's ladder offers, so grades appear almost at once, and then
 * regrades the whole line at each deeper rung it can afford — replacing the
 * report each time it gets there. `refining` and `deeperToCome` are how a
 * screen says so; `depth` is what the numbers on screen currently mean.
 *
 * Returns the report `summarizeReview` produces plus how far the walk has got.
 * `analyzed` counts positions, so `analyzed - 1` is the last move that has a
 * grade and `positions.length - analyzed` is how far the analysis is behind.
 */
export function useGameAnalysis<TMove extends GradableMove = RecordedMove>({
  bookPlies = 0,
  effort = DEFAULT_ANALYSIS_EFFORT,
  enabled = true,
  live = false,
  mode,
  moves,
  positions,
  streaming = false,
}: GameAnalysisOptions<TMove>): GameAnalysisResult<TMove> {
  const [state, setState] = useState<AnalysisSnapshot>(EMPTY);
  const sessionRef = useRef<ReturnType<typeof createGameAnalysis> | null>(null);
  // The line as last submitted, so a session started part way through a game
  // is handed the game rather than waiting for the next move to arrive.
  const lineRef = useRef<GameLine | null>(null);

  const unavailable = engineUnavailableMessage(mode?.id);
  const active = enabled && Boolean(mode) && !unavailable;

  useEffect(() => {
    if (!active) {
      sessionRef.current = null;
      setState(unavailable ? { ...EMPTY, error: unavailable, status: 'error' } : EMPTY);
      return undefined;
    }
    // An effort change regrades from the start: it changes the whole ladder,
    // and a report whose moves were graded at different depths compares
    // numbers that were never comparable.
    setState(EMPTY);
    const session = createGameAnalysis({
      budgetMs: analysisBudgetMs({ effort }),
      ladder: analysisLadder({ effort, live }),
      onChange: setState,
      settleMs: ANALYSIS_SETTLE_MS,
    });
    sessionRef.current = session;
    if (lineRef.current) session.submit(lineRef.current);
    return () => {
      session.stop();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [active, effort, live, mode?.id, unavailable]);

  useEffect(() => {
    lineRef.current = { moves, positions, streaming };
    sessionRef.current?.submit(lineRef.current);
  }, [moves, positions, streaming]);

  const report = useMemo(
    () =>
      mode
        ? summarizeReview({
            bookPlies,
            entries: state.entries,
            source: { mode, moves, positions },
          })
        : null,
    [bookPlies, mode, moves, positions, state.entries],
  );

  return {
    analyzed: state.entries.length,
    // Counted in moves, not positions: the position a game currently sits at
    // has no move out of it to grade, so a walk that has graded every move
    // played so far is level with the game even though a position is to come.
    behind: Math.max(0, moves.length - state.entries.length),
    deeperToCome: state.deeperToCome,
    depth: state.limits.maxDepth,
    // The raw walk, for the screens that show the engine's lines for a
    // position rather than its verdict on a move.
    entries: state.entries,
    error: state.error,
    limits: state.limits,
    pass: state.pass,
    refining: state.refining,
    report,
    status: state.status,
  };
}

export default useGameAnalysis;
