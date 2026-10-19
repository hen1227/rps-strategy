import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useEffect } from 'react';

import { useGameStore } from '@/store/gameStore';

import { ANALYTICS_AVAILABLE } from './config';
import { analyticsAllowed, useAnalyticsConsent } from './consent';
import { createGameObserver } from './gameEvents';
import { reportedPath } from './pagePath';
import { installTransport, setReportedLocation, track } from './track';
import { transport } from './transport';

// Analytics, switched on for the whole app from the one place every page sits
// under. Mounted once, by `SessionBridge` in the root layout.
//
// Three jobs: start or stop the transport as consent changes, send a page view
// whenever the reported page changes, and watch the game store for games
// starting and ending (`gameEvents.ts`). In a build with no measurement ID it
// does none of them.

const searchOf = (params: Record<string, string | string[] | undefined>) => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'string') search.set(name, value);
  }
  return search;
};

export function useAnalytics() {
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const allowed = useAnalyticsConsent(analyticsAllowed);
  const path = reportedPath(pathname, searchOf(params));

  // Declared first so that, when consent arrives, the transport is running
  // before the page view below asks it to send.
  useEffect(() => {
    if (!ANALYTICS_AVAILABLE) return;
    installTransport(transport);
    if (allowed) transport.start();
    else transport.stop();
  }, [allowed]);

  // Keyed on consent as well as the page, so the page somebody says yes on is
  // the first one counted.
  useEffect(() => {
    setReportedLocation(path);
    if (allowed) track('page_view');
  }, [allowed, path]);

  useEffect(() => {
    if (!ANALYTICS_AVAILABLE) return;
    const observe = createGameObserver();
    return useGameStore.subscribe((next, prev) => {
      for (const event of observe(next, prev)) {
        if (event.name === 'game_start') track('game_start', event.params);
        else track('game_end', event.params);
      }
    });
  }, []);
}
