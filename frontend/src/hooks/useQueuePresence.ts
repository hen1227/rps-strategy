import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';

import { useGameStore } from '@/store/gameStore';

/**
 * Whether a person is actually behind this tab, reported so the queue knows
 * whether to drop them into a game or summon them to one.
 *
 * Present means the tab is visible *and* a human has done something in the last
 * ninety seconds. Visibility alone is not enough: a tab left open on a second
 * monitor is visible and has nobody behind it, and pairing against that chair
 * is how somebody loses a game they never saw. The client decides because the
 * client is the only thing that can see a mouse move; the server overrules it
 * in the one direction it knows better, by treating a closed socket as away.
 *
 * Nothing here runs during the static export: every browser API is touched
 * inside the effect, which the build never executes.
 */

/** How long after the last click or keystroke somebody still counts as here. */
const ACTIVITY_WINDOW_MS = 90_000;
/** How often the idle clock is checked. */
const EVALUATE_EVERY_MS = 15_000;
/** A hard floor between two reports, so an alt-tabber cannot flood the socket. */
const MIN_REPORT_INTERVAL_MS = 2_000;

export const useQueuePresence = (): void => {
  const reportPresence = useGameStore((state) => state.reportPresence);
  const connect = useGameStore((state) => state.connect);
  const lastActivityAt = useRef(0);
  const lastReported = useRef<boolean | null>(null);
  const lastReportAt = useRef(0);
  const pendingReport = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    lastActivityAt.current = Date.now();

    // Reported only when the answer *changes*, and never more than once every
    // couple of seconds. A quiet session therefore produces a handful of
    // messages in total, and an idle browsing one produces none at all —
    // reportPresence itself returns early when nothing is waiting on us.
    const report = (present: boolean) => {
      if (lastReported.current === present) return;
      const now = Date.now();
      const since = now - lastReportAt.current;
      if (since < MIN_REPORT_INTERVAL_MS) {
        if (pendingReport.current) return;
        pendingReport.current = setTimeout(() => {
          pendingReport.current = null;
          report(present);
        }, MIN_REPORT_INTERVAL_MS - since);
        return;
      }
      lastReported.current = present;
      lastReportAt.current = now;
      reportPresence(present);
    };

    if (Platform.OS !== 'web') {
      // A foregrounded native app has no other tab for its owner to be looking
      // at, so "visible" and "present" are the same fact and the idle rule
      // would only ever be wrong.
      const subscription = AppState.addEventListener('change', (state) => {
        const active = state === 'active';
        if (active) connect();
        report(active);
      });
      report(AppState.currentState === 'active');
      return () => subscription.remove();
    }

    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    const noteActivity = () => {
      lastActivityAt.current = Date.now();
    };
    const evaluate = () => {
      const visible = document.visibilityState === 'visible';
      report(visible && Date.now() - lastActivityAt.current < ACTIVITY_WINDOW_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Coming back counts as activity, and is also the best moment to revive
        // a socket that died while the tab was in the background — otherwise a
        // returning player sits out the reconnect backoff for no reason.
        noteActivity();
        connect();
      }
      evaluate();
    };

    // Written to a ref rather than to state: pointermove is a firehose, and a
    // re-render per mouse movement would be far more expensive than the thing
    // being measured.
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    for (const event of events) {
      window.addEventListener(event, noteActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    const interval = setInterval(evaluate, EVALUATE_EVERY_MS);
    evaluate();

    return () => {
      for (const event of events) window.removeEventListener(event, noteActivity);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clearInterval(interval);
      if (pendingReport.current) clearTimeout(pendingReport.current);
      pendingReport.current = null;
    };
  }, [connect, reportPresence]);
};
