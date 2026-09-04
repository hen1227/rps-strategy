import { useEffect, useState } from 'react';

import { useSettled } from '@/hooks/useSettled';

/**
 * The current time, or null until the browser has one.
 *
 * Null on the first render for exactly the reason `useSettled` gives: every
 * page here is pre-rendered in Node at build time, and a clock read during that
 * render would put a stale minute into the HTML that the first browser render
 * then disagrees with — which React answers by throwing the pre-rendered page
 * away. So anything that depends on what time it is renders nothing at first
 * and appears a render later.
 *
 * That is also why callers treat null as "say nothing" rather than as "not
 * yet": a banner about an event this afternoon simply is not in the static HTML,
 * and should not be.
 *
 * @param intervalMs how often to re-read the clock. The default is a minute,
 *   which is as fine as anything on this site needs — see `untilLabel`, which
 *   rounds to minutes, then hours.
 */
export const useNow = (intervalMs = 60_000): number | null => {
  const settled = useSettled();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Read once on mount as well as on the interval, so a page opened at 11:29
    // does not spend most of a minute claiming the engines are still up.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return settled ? now : null;
};
