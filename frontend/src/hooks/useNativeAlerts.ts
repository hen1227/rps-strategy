import { useEffect } from 'react';
import { AppState } from 'react-native';

import { activePushTransport } from '@/store/push';

/**
 * The native half of what the service worker does for a browser: keep a summons
 * from shouting at somebody who is already looking at the answer.
 *
 * Two rules, both of them the web build's rules restated for a phone.
 *
 * A summons that arrives while the app is open is recorded and not banner-ed.
 * The board is already on screen and the chime has already played, so a banner
 * over the top of it is the notification that teaches people to mute an app —
 * which is fatal here, because a muted app cannot be called back at all. On the
 * web the same judgement is made by `sw.js` telling every open tab, and a
 * visible one closing the notification itself.
 *
 * And coming back to the app takes down any summons still waiting in
 * Notification Center, for the same reason.
 *
 * What is deliberately *not* here is a tap handler. Tapping a summons brings the
 * app to the front, the socket reconnects, and the server names the live game in
 * `connection_ready` — at which point the effect in `_layout` that watches
 * `gameId` navigates to the board. A second route push here would race that one
 * to the same destination.
 *
 * Nothing runs during the static export: the import is reached inside the
 * effect, which the build never executes.
 */
export const useNativeAlerts = (): void => {
  useEffect(() => {
    if (activePushTransport() !== 'apns') return;

    let cancelled = false;
    void import('@/store/pushApns').then((apns) => {
      if (cancelled) return;
      apns.presentQuietlyInForeground();
      if (AppState.currentState === 'active') void apns.dismissDeliveredSummons();
    });

    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void import('@/store/pushApns').then((apns) => apns.dismissDeliveredSummons());
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);
};
