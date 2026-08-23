import { useMemo } from 'react';

import type { RequestIdentity } from '@/store/api/identity';
import { useGameStore } from '@/store/gameStore';

// Who this browser is, for the routes that take either answer.
//
// The store already holds all three parts — it needs them to authenticate its
// socket — so a screen that reaches for them one at a time gets a new object on
// every render and restarts every effect that depends on it. This memoises them
// into the one shape `identity.ts` and the server's `requireAnyIdentity` agree
// on.
export const useRequestIdentity = (): RequestIdentity => {
  const userId = useGameStore((state) => state.accountId);
  const profileKey = useGameStore((state) => state.profileKey);
  const sessionToken = useGameStore((state) => state.sessionToken);
  return useMemo(
    () => ({ userId, profileKey, sessionToken: sessionToken ?? null }),
    [profileKey, sessionToken, userId],
  );
};
