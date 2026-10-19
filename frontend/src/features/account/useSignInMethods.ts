import { useEffect, useState } from 'react';

import { getSignInMethods, type SignInMethods } from '@/store/api/bots';
import { isSignedIn } from '@/store/accountSession';
import { useGameStore } from '@/store/gameStore';

// What this account signs in with, which only the server can answer, and only
// to its owner.
//
// It decides two things on the Account screen: whether to ask a password
// account to link Discord or Apple — a store review account is on a password
// too, and the prompt has to stay off it, since the link it offers is one the
// server refuses — and what the sign-in methods panel lists. The sign-in
// screen's last step lists the same thing.
//
// Asked again whenever the account changes, and a link changes it: the server
// stamps the account when it retires a password or adds a way in, so a panel
// that has just linked Apple stops offering Apple.

export interface SignInMethodsState {
  /** Null, and neither, until the server has said. */
  methods: SignInMethods | null;
  awaitingLink: boolean | null;
  /** Whether the server has answered, either way. */
  loaded: boolean;
}

const UNASKED: SignInMethodsState = { methods: null, awaitingLink: null, loaded: false };

export function useSignInMethods(): SignInMethodsState {
  const sessionToken = useGameStore((state) => state.sessionToken);
  const account = useGameStore((state) => state.account);
  const signedIn = isSignedIn(sessionToken, account);
  const [state, setState] = useState<SignInMethodsState>(UNASKED);
  const accountUserId = account?.userId;
  const accountStamp = account?.updatedAtUnixMs;

  useEffect(() => {
    if (!signedIn || !sessionToken) {
      setState(UNASKED);
      return;
    }
    let cancelled = false;
    getSignInMethods(sessionToken)
      .then((reply) => {
        if (!cancelled) setState({ methods: reply, awaitingLink: reply.awaitingLink, loaded: true });
      })
      .catch((caught) => {
        if (cancelled) return;
        // A server older than the route answers 404, and keeps the rule it was
        // built with: every unverified account is asked. Any other failure asks
        // nobody, rather than nag on a blip.
        setState({
          methods: null,
          awaitingLink: (caught as { status?: number } | null)?.status === 404,
          loaded: true,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, sessionToken, accountUserId, accountStamp]);

  return state;
}
