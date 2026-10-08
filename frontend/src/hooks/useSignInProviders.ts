import { useEffect, useState } from 'react';

import { signInProviders, type SignInProviders } from '@/store/api/bots';
import { APPLE_PROVIDER } from '@/store/appleAuth';
import { useGameStore } from '@/store/gameStore';

// Which ways in this server can actually complete, asked before Apple's button
// is offered.
//
// Apple's is the one that needs asking. On the phone it is Apple's own button,
// and on the website it is the size of the front door; neither is a button to
// show and then fail with "not configured". Discord's button keeps its old
// behaviour, and says so when pressed on a server without it.
//
// Fetched once per page load and shared, like the identity policy. A server too
// old to have the route answers 404, which is the same as answering no: it
// cannot sign anybody in with Apple. So does a request that fails, for this
// screen — but a failure is not remembered, so the next screen to ask tries
// again.

/** What a server that could not be asked offers beyond Discord: nothing. Discord
 *  is listed as offered because its button never asks; see above. */
const UNANSWERED: SignInProviders = Object.freeze({ discord: true, apple: false, appleWeb: false });

let cached: SignInProviders | null = null;
let inFlight: Promise<SignInProviders> | null = null;

const load = (): Promise<SignInProviders> => {
  if (cached) return Promise.resolve(cached);
  inFlight ??= signInProviders()
    .then((providers) => {
      cached = providers;
      return providers;
    })
    .catch(() => UNANSWERED)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
};

/** Null only while the question is out; an answer of no is an answer. */
export function useSignInProviders(): SignInProviders | null {
  const [providers, setProviders] = useState(cached);
  useEffect(() => {
    let cancelled = false;
    load().then((next) => {
      if (!cancelled) setProviders(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return providers;
}

/**
 * Whether Apple can be offered here and now: this build has it, and the server
 * has said it can finish it — Apple's sheet on the phone, its website in a
 * browser. Null while the server's answer is still coming, so a caller can hold
 * a place rather than decide either way.
 */
export function useAppleOffered(): boolean | null {
  const available = useGameStore((state) => state.appleSignInAvailable);
  const providers = useSignInProviders();
  if (!available) return false;
  if (!providers) return null;
  return Boolean(providers[APPLE_PROVIDER]);
}
