import { useCallback, useState } from 'react';

import { failureMessage } from '@/errors';
import { blockPlayer, unblockPlayer } from '@/store/api/moderation';
import { useGameStore } from '@/store/gameStore';

// Blocking, as the two surfaces that offer it both need it.
//
// A hook rather than a shared button, because the chat room and a player page
// want the same *behaviour* and nothing like the same chrome: one is an entry in
// a small sheet over a message, the other is a control in a profile header.
// Sharing the button would have meant one of them wearing the other's styling.
//
// What is genuinely shared is the awkward part: whether this person is already
// blocked, whether blocking is even available to this visitor, and what to do
// with the error when it is not.

export interface Blocking {
  /** Whether this account is on the signed-in player's list right now. */
  isBlocked: (userId: string | undefined) => boolean;
  /**
   * Whether blocking is available at all.
   *
   * False for a guest, and that is not an oversight: a block is a durable
   * preference, and a guest's list would be thrown away with the browser key it
   * hangs off. A protection that quietly evaporates is worse than one somebody
   * knows they have to sign in for. Reporting takes either — see ReportDialog.
   */
  canBlock: boolean;
  busy: boolean;
  error: string | null;
  clearError: () => void;
  /** Block by id, or by name when that is all the caller has. */
  block: (target: { userId?: string; username?: string }) => Promise<boolean>;
  unblock: (userId: string) => Promise<boolean>;
}

export function useBlocking(): Blocking {
  const sessionToken = useGameStore((state) => state.sessionToken);
  // The socket's copy, refreshed by the server on every change from any tab, so
  // a button labelled "BLOCK" does not stay labelled that after another tab
  // pressed it.
  const blockedUserIds = useGameStore((state) => state.blockedUserIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBlocked = useCallback(
    (userId: string | undefined) => Boolean(userId) && blockedUserIds.includes(userId as string),
    [blockedUserIds],
  );

  const run = useCallback(
    async (action: (token: string) => Promise<unknown>) => {
      if (!sessionToken) {
        setError('Sign in to block players.');
        return false;
      }
      setBusy(true);
      setError(null);
      try {
        await action(sessionToken);
        // Nothing is written to the store here. The server answers a block by
        // pushing the new list down every socket this account holds, and that
        // is the copy every screen reads — so a second, local update would be a
        // second source of truth that is right until it is not.
        return true;
      } catch (requestError) {
        setError(failureMessage(requestError));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [sessionToken],
  );

  return {
    isBlocked,
    canBlock: Boolean(sessionToken),
    busy,
    error,
    clearError: useCallback(() => setError(null), []),
    block: useCallback(
      (target) => run((token) => blockPlayer(token, target)),
      [run],
    ),
    unblock: useCallback((userId) => run((token) => unblockPlayer(token, userId)), [run]),
  };
}
