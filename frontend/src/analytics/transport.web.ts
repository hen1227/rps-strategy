import { IS_DEVELOPMENT } from '@/featureFlags';

import { MEASUREMENT_ID } from './config';
import type { AnalyticsParams } from './events';
import type { AnalyticsTransport } from './transport.types';

// The website's half: Google's own tag, loaded only once it may be.
//
// Not in the HTML shell. `+html.tsx` is rendered at build time for every
// visitor, and a tag written there would load before anybody had been asked.
// It is injected the first time consent is in hand, and never otherwise.
//
// Configured to be analytics and nothing else: no advertising consent, no
// Google signals, no ad personalisation, and its cookie kept to this host
// rather than every subdomain of henhen1227.com. Page views are sent by hand —
// the automatic one would report the full address, query string and all — and
// every event names the stripped page itself, since the tag would otherwise
// read `document.location`. The stream's "page changes based on browser history
// events" setting must be off for the same reason; see `docs/analytics.md`.

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

let installed = false;

// gtag.js reads the `arguments` object itself, so this has to be a plain
// function pushing exactly that, as Google's snippet does.
function gtag(..._args: unknown[]) {
  (window.dataLayer ??= []).push(arguments);
}

const absolute = (path: string) => `${window.location.origin}${path}`;

const disableFlag = `ga-disable-${MEASUREMENT_ID}`;

/** The tag's cookies, `_ga` and `_ga_<stream>`, on this host. */
const forgetCookies = () => {
  for (const entry of document.cookie.split(';')) {
    const name = entry.split('=')[0]?.trim();
    if (name && (name === '_ga' || name.startsWith('_ga_'))) {
      document.cookie = `${name}=; Max-Age=0; path=/`;
    }
  }
};

export const transport: AnalyticsTransport = {
  start() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    (window as unknown as Record<string, unknown>)[disableFlag] = false;
    if (installed) {
      gtag('consent', 'update', { analytics_storage: 'granted' });
      return;
    }
    installed = true;
    gtag('consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'granted',
    });
    gtag('js', new Date());
    gtag('config', MEASUREMENT_ID, {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      cookie_domain: 'none',
      // Shows this browser's events in the property's DebugView, for a
      // development server someone pointed at a real stream on purpose.
      ...(IS_DEVELOPMENT ? { debug_mode: true } : {}),
    });
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(MEASUREMENT_ID)}`;
    document.head.appendChild(script);
  },

  stop() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    (window as unknown as Record<string, unknown>)[disableFlag] = true;
    if (installed) gtag('consent', 'update', { analytics_storage: 'denied' });
    forgetCookies();
  },

  send(name: string, params: AnalyticsParams, location: string) {
    if (typeof window === 'undefined') return;
    const page = { page_location: absolute(location), page_title: location };
    if (name === 'page_view') {
      // For whatever the tag sends of its own accord after this, such as
      // scrolls and outbound clicks.
      gtag('set', page);
    }
    gtag('event', name, { ...params, ...page });
  },
};
