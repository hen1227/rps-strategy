import * as Clipboard from 'expo-clipboard';
import { useMemo, useState } from 'react';

import { encodePositionFEN, type PositionRecord } from '@/engine/pgn';
import { haptic } from '@/haptics/haptics';
import { GhostButton } from '@/ui/primitives';

// The board on screen as a FEN, in one press.
//
// The export dialog already copies it, but behind EXPORT, and a FEN is the one
// thing in there people ask for by name: they want to paste the position into
// something else, not pick between a record and a picture first. So it sits
// beside EXPORT rather than replacing it.
//
// COPIED is kept for the board that was copied, not for the button. On a
// review the board moves under it, and a button still saying COPIED one move
// later would be claiming the clipboard holds a position it does not. Stepping
// back to the copied board says COPIED again, which is true.

export interface CopyFENButtonProps {
  /** The board on screen. An export board is one of these already. */
  board: PositionRecord;
}

export default function CopyFENButton({ board }: CopyFENButtonProps) {
  const { currentTurn, grid, mode } = board;
  const fen = useMemo(
    () => encodePositionFEN({ currentTurn, grid, mode }),
    [currentTurn, grid, mode],
  );
  const [copied, setCopied] = useState<{ fen: string; ok: boolean } | null>(null);
  const shown = copied?.fen === fen ? copied : null;

  return (
    <GhostButton
      accessibilityLabel="Copy this position as FEN"
      compact
      label={!shown ? 'COPY FEN' : shown.ok ? 'COPIED ✓' : 'NO CLIPBOARD'}
      onPress={async () => {
        try {
          const ok = await Clipboard.setStringAsync(fen);
          if (ok) haptic('copied');
          setCopied({ fen, ok });
        } catch {
          setCopied({ fen, ok: false });
        }
      }}
    />
  );
}
