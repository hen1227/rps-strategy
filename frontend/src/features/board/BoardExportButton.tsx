import { useState } from 'react';

import { GhostButton } from '@/ui/primitives';

import BoardExportModal from './export/BoardExportModal';
import type { ShareCardInput } from './export/shareCard';

// The way off the screen, next to every board in the app.
//
// One button rather than one per format: what somebody wants from a board they
// are looking at is "this, somewhere else", and which of a FEN, a record and a
// picture that turns out to mean is a question the dialog asks. See
// `./export/BoardExportModal`.
//
// The dialog is not mounted until it has been opened once. It lays the whole
// picture out — a few hundred rectangles for a nine by nine board — and a live
// game re-renders this row after every move, so an always-mounted copy would
// redraw a card nobody has asked for, all game. Once opened it stays mounted,
// so closing it still fades.

export interface BoardExportButtonProps {
  /** The board on screen, and everything the picture may say about it. */
  board: ShareCardInput;
  /** Defaults to EXPORT, which is right unless the row is tight. */
  label?: string;
  compact?: boolean;
}

export default function BoardExportButton({
  board,
  label = 'EXPORT',
  compact = true,
}: BoardExportButtonProps) {
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);

  return (
    <>
      <GhostButton
        accessibilityLabel={`Export this ${board.mode.name} board`}
        compact={compact}
        label={label}
        onPress={() => {
          setUsed(true);
          setOpen(true);
        }}
      />
      {used ? (
        <BoardExportModal board={board} onClose={() => setOpen(false)} visible={open} />
      ) : null}
    </>
  );
}
