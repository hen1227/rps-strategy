import { useCallback, useState } from 'react';

import { validMovesFor, type AnalysisGame } from '@/engine/analysisGame';
import { samePosition, type Position } from '@/types/game';

// Tap a piece, then tap where it goes.
//
// Three boards need this and it is the same three steps every time: a tap on a
// legal destination plays the move, a second tap on the selected piece clears
// it, and any other tap selects whatever piece is there — but only if it has
// somewhere to go, so tapping a blocked piece does not leave a selection that
// cannot be used.

export interface BoardSelection {
  selectedTile: Position | null;
  validMoves: Position[];
  /** Handle a tap on a square. */
  selectTile: (position: Position) => void;
  /** Play a move directly, as a drag does. */
  movePiece: (from: Position, to: Position) => void;
  clearSelection: () => void;
}

export interface BoardSelectionOptions {
  game: AnalysisGame | null | undefined;
  /** Play the move. Return value is ignored; the selection clears either way. */
  onMove: (from: Position, to: Position) => void;
  /** Refuse every interaction, for a board somebody is only watching. */
  disabled?: boolean;
}

export const useBoardSelection = ({
  game,
  onMove,
  disabled = false,
}: BoardSelectionOptions): BoardSelection => {
  const [selectedTile, setSelectedTile] = useState<Position | null>(null);
  const [validMoves, setValidMoves] = useState<Position[]>([]);

  const clearSelection = useCallback(() => {
    setSelectedTile(null);
    setValidMoves([]);
  }, []);

  const playable = !disabled && game?.status === 'InProgress';

  const movePiece = useCallback(
    (from: Position, to: Position) => {
      if (!playable) return;
      clearSelection();
      onMove(from, to);
    },
    [clearSelection, onMove, playable],
  );

  const selectTile = useCallback(
    (position: Position) => {
      if (!playable || !game) return;

      if (selectedTile && validMoves.some((move) => samePosition(move, position))) {
        clearSelection();
        onMove(selectedTile, position);
        return;
      }
      if (selectedTile && samePosition(selectedTile, position)) {
        clearSelection();
        return;
      }

      const moves = validMovesFor(game, position);
      setSelectedTile(moves.length > 0 ? position : null);
      setValidMoves(moves);
    },
    [clearSelection, game, onMove, playable, selectedTile, validMoves],
  );

  return { selectedTile, validMoves, selectTile, movePiece, clearSelection };
};
