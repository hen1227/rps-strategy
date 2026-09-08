import { useEffect, useState } from 'react';

import { identityPolicy, type IdentityPolicy } from '@/store/api/bots';

// Which names are spoken for, asked rather than assumed.
//
// The list used to be written out in three places — the server, the account
// screen, and the tournament signup form — and a rule kept in three copies is
// one that eventually differs in two. The server publishes it now, and this is
// how the app reads it.
//
// The built-in list is a fallback for the moment before the request lands and
// for a client that cannot reach the server. It is deliberately allowed to be
// stale: the server refuses a reserved name regardless, so the worst a stale
// copy does is fail to grey out a field early.
const FALLBACK: IdentityPolicy = Object.freeze({
  minLength: 3,
  maxLength: 32,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$',
  reservedNames: ['Henhen1227', 'webgoatguy'],
  botMinLength: 2,
  botPattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{1,31}$',
});

let cached: IdentityPolicy | null = null;
let inFlight: Promise<IdentityPolicy> | null = null;

/** Fetch once per page load; every caller shares the result. */
const load = (): Promise<IdentityPolicy> => {
  if (cached) return Promise.resolve(cached);
  inFlight ??= identityPolicy()
    .then((policy) => {
      cached = { ...FALLBACK, ...policy };
      return cached;
    })
    .catch(() => FALLBACK)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
};

/** True when the value is a handle the organisers hold. */
export const isReservedIn = (
  policy: IdentityPolicy | null | undefined,
  value: string | null | undefined,
) => {
  const normalized = String(value ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!normalized) return false;
  return (policy?.reservedNames ?? FALLBACK.reservedNames).some(
    (name) => name.toLowerCase() === normalized,
  );
};

export function useIdentityPolicy(): IdentityPolicy {
  const [policy, setPolicy] = useState(cached ?? FALLBACK);
  useEffect(() => {
    let cancelled = false;
    load().then((next) => {
      if (!cancelled) setPolicy(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return policy;
}
