import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { captureSoundFor, type GameSound } from '@/appearance/gameSound';
import { applyAnalysisMove, type AnalysisGame, type AppliedMove } from '@/engine/analysisGame';
import { judgeSolveMove, solveGame, type SolvePosition } from '@/engine/puzzleSolve';
import { useBoardSelection } from '@/hooks/useBoardSelection';
import { cueGameSound } from '@/store/soundCue';
import type { ModeDefinition, Move, Position } from '@/types/game';

// One position being solved on a real board.
//
// The board behaves the way every other board here does — tap a piece and then
// its square, or drag it — and a move is then one of three things. Illegal: it
// springs back, as anywhere. Wrong: it is played, so the player sees what they
// did, answered by the reply that punishes it when the position names one, and
// then taken back. Right: it stays, and the position is done.
//
// Nothing here says anything. What a lesson or a puzzle tells the player about
// a wrong move is the screen's to decide; this only reports which of the three
// happened and how many times the answer has been missed.

/** How long a wrong move stays on the board before it is taken back. */
const WRONG_MOVE_HOLD_MS = 900;

/** How long a wrong move stands before the reply to it, long enough to see it land. */
const REPLY_DELAY_MS = 450;

/**
 * How long the reply stays before both are taken back: the capture effect and
 * a moment to look at what it did.
 */
const REPLY_HOLD_MS = 1300;

export type SolveState = 'waiting' | 'wrong' | 'solved';

export interface SolveSession {
  game: AnalysisGame;
  lastMove: Move | null;
  state: SolveState;
  /** Wrong answers so far. */
  misses: number;
  selectedTile: Position | null;
  validMoves: Position[];
  onTilePress: (square: Position) => void;
  onPieceDrop: (from: Position, to: Position) => void;
}

/** A capture's sound names what was taken; anything else is a plain move. */
const captureOrMove = (before: AnalysisGame, applied: AppliedMove, to: Position): GameSound => {
  if (!applied.captured) return 'moveSelf';
  return captureSoundFor(before.grid[to.y]?.[to.x]?.occupant ?? 'Empty') ?? 'moveSelf';
};

/** What a move sounds like, through the same players a game uses. */
const soundOf = (before: AnalysisGame, applied: AppliedMove, to: Position): GameSound => {
  if (applied.game.status === 'Finished') return 'end';
  return captureOrMove(before, applied, to);
};

/**
 * A reply's sound. A capture says what was taken even when it ends the game:
 * the reply is there to show the snip, and it is taken back a moment later.
 */
const replySoundOf = (before: AnalysisGame, applied: AppliedMove, to: Position): GameSound =>
  applied.captured ? captureOrMove(before, applied, to) : soundOf(before, applied, to);

export const useSolveSession = ({
  mode,
  position,
  onSolved,
}: {
  mode: ModeDefinition;
  position: SolvePosition;
  onSolved?: () => void;
}): SolveSession => {
  // A caller hands a new position by remounting, keyed on it: everything here
  // belongs to one position, and starting over is exactly what a new one is.
  const start = useMemo(() => solveGame(mode, position), [mode, position]);
  const [game, setGame] = useState(start);
  const [lastMove, setLastMove] = useState<Move | null>(null);
  const [state, setState] = useState<SolveState>('waiting');
  const [misses, setMisses] = useState(0);

  const takeBack = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (takeBack.current) clearTimeout(takeBack.current);
    },
    [],
  );

  const onSolvedRef = useRef(onSolved);
  onSolvedRef.current = onSolved;

  const play = useCallback(
    (from: Position, to: Position) => {
      if (state !== 'waiting') return;
      const judged = judgeSolveMove(position, game, from, to);
      if (!judged) return;
      cueGameSound(soundOf(game, judged.applied, to));
      setGame(judged.applied.game);
      setLastMove({ from, to });
      if (judged.verdict === 'solved') {
        setState('solved');
        onSolvedRef.current?.();
        return;
      }
      setState('wrong');
      setMisses((count) => count + 1);
      const restore = () => {
        takeBack.current = null;
        setGame(start);
        setLastMove(null);
        setState('waiting');
      };
      const after = judged.applied.game;
      const reply = position.refute?.({ from, to }, after) ?? null;
      const answered = reply ? applyAnalysisMove(after, reply.from, reply.to) : null;
      if (!reply || !answered) {
        takeBack.current = setTimeout(restore, WRONG_MOVE_HOLD_MS);
        return;
      }
      takeBack.current = setTimeout(() => {
        cueGameSound(replySoundOf(after, answered, reply.to));
        setGame(answered.game);
        setLastMove(reply);
        takeBack.current = setTimeout(restore, REPLY_HOLD_MS);
      }, REPLY_DELAY_MS);
    },
    [game, position, start, state],
  );

  const selection = useBoardSelection({ game, onMove: play, disabled: state !== 'waiting' });

  return {
    game,
    lastMove,
    state,
    misses,
    selectedTile: selection.selectedTile,
    validMoves: selection.validMoves,
    onTilePress: selection.selectTile,
    onPieceDrop: selection.movePiece,
  };
};
