import { useEffect, useState } from 'react';

import { signInProviders, type SignInProviders } from '@/store/api/bots';
import { ApiError } from '@/store/api/http';
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
// cannot sign anybody in with Apple. A failure of any kind is not remembered,
// so the next screen to ask tries again.

/** What a server that answered with a failure offers beyond Discord: nothing.
 *  Discord is listed as offered because its button never asks; see above. */
const UNANSWERED: SignInProviders = Object.freeze({ discord: true, apple: false, appleWeb: false });

/**
 * What a server that could not be reached is taken to offer: Apple too, on a
 * phone. Nothing is known about it, but the two buttons have to stand or fall
 * together. Discord's never asks, so it stays through a network blip, and an
 * Apple button that vanished beside it would be a sign-in offered without
 * Apple's (App Review guideline 4.8). Pressed, either one says the server could
 * not be reached. The website's Apple button is not a store rule, and stays
 * hidden until a server says it can finish it.
 */
const UNREACHED: SignInProviders = Object.freeze({ discord: true, apple: true, appleWeb: false });

let cached: SignInProviders | null = null;
let inFlight: Promise<SignInProviders> | null = null;

const load = (): Promise<SignInProviders> => {
  if (cached) return Promise.resolve(cached);
  inFlight ??= signInProviders()
    .then((providers) => {
      cached = providers;
      return providers;
    })
    .catch((error: unknown) =>
      error instanceof ApiError && error.status === null ? UNREACHED : UNANSWERED,
    )
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
