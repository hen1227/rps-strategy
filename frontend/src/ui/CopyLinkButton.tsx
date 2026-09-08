import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';

import { GhostButton } from './primitives';

// Hand somebody the address of the thing in this row.
//
// A list is where you look when the game you want to send is not the one on
// screen, so every row that has an address offers it — a player's own history, a
// bot game in the feed, a run's card, and every game inside that run. This was
// written once inside the account history and then wanted in four more places,
// which is four chances for one of them to forget what a failed clipboard looks
// like.
//
// The address itself is never built here: it arrives from `links.ts`, which is
// the only thing that knows what a page is called. A button that assembled its
// own URL would be a second place for a route to go stale.

export interface CopyLinkButtonProps {
  /** The whole address, from `gameReviewURL`, `seriesURL` or `shareURL`. */
  url: string;
  /** What is being copied, for somebody who cannot see the row. */
  accessibilityLabel: string;
  /** Defaults to COPY LINK, which is right unless a row copies two things. */
  label?: string;
  compact?: boolean;
}

export default function CopyLinkButton({
  url,
  accessibilityLabel,
  label = 'COPY LINK',
  compact = true,
}: CopyLinkButtonProps) {
  // Left saying COPIED rather than reset on a timer: the button belongs to one
  // row and copies one address, so the only thing a reset would tell anybody is
  // that they took too long reading it.
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  return (
    <GhostButton
      accessibilityLabel={accessibilityLabel}
      compact={compact}
      label={state === 'copied' ? 'COPIED ✓' : state === 'error' ? 'NO CLIPBOARD' : label}
      onPress={async () => {
        try {
          await Clipboard.setStringAsync(url);
          setState('copied');
        } catch {
          setState('error');
        }
      }}
    />
  );
}
