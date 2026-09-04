import { useEffect, useMemo, useRef, useState } from 'react';

import {
  createGameAnalysis,
  type AnalysisSnapshot,
  type GameLine,
} from '@/engine/gameAnalysis';
import {
  summarizeReview,
  type GradableMove,
  type RecordedMove,
  type ReviewReport,
} from '@/engine/gameReview';
import type { PositionLike } from '@/engine/analysisGame';
import { engineUnavailableMessage } from '@/engine/rpsfish/client';
import type { ReviewEntry } from '@/engine/rpsfish/protocol';
import type { ModeDefinition } from '@/types/game';

const EMPTY: AnalysisSnapshot = Object.freeze({ entries: [], error: null, status: 'idle' });

export interface GameAnalysisOptions<TMove extends GradableMove = RecordedMove> {
  /** Opening moves that were dealt rather than chosen, and so are not graded. */
  bookPlies?: number;
  enabled?: boolean;
  mode: ModeDefinition | null | undefined;
  moves: TMove[];
  positions: PositionLike[];
  /** A key of the review presets. */
  preset?: string;
  /** Whether more positions are still expected. */
  streaming?: boolean;
}

export interface GameAnalysisResult<TMove extends GradableMove = RecordedMove> {
  /** How many positions have been graded. */
  analyzed: number;
  /** How many moves the walk is behind the line. */
  behind: number;
  entries: ReviewEntry[];
  error: string | null;
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
 * Returns the report `summarizeReview` produces plus how far the walk has got.
 * `analyzed` counts positions, so `analyzed - 1` is the last move that has a
 * grade and `positions.length - analyzed` is how far the analysis is behind.
 */
export function useGameAnalysis<TMove extends GradableMove = RecordedMove>({
  bookPlies = 0,
  enabled = true,
  mode,
  moves,
  positions,
  preset,
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
      setState(
        unavailable
          ? { entries: [], error: unavailable, status: 'error' }
          : EMPTY,
      );
      return undefined;
    }
    // A preset change regrades from the start: a report whose moves were
    // graded at different depths compares numbers that were never comparable.
    setState(EMPTY);
    const session = createGameAnalysis({ onChange: setState, preset });
    sessionRef.current = session;
    if (lineRef.current) session.submit(lineRef.current);
    return () => {
      session.stop();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [active, mode?.id, preset, unavailable]);

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
    // The raw walk, for the screens that show the engine's lines for a
    // position rather than its verdict on a move.
    entries: state.entries,
    error: state.error,
    report,
    status: state.status,
  };
}

export default useGameAnalysis;
