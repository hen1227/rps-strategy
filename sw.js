// The service worker exists for exactly one thing: to be awake when the tab is
// not, so a game that starts while you are away can still reach you.
//
// WHAT IT DELIBERATELY DOES NOT DO: cache anything. There is no `fetch`
// handler, no precache, no offline shell, and adding one would be a serious
// mistake. Expo's static export fingerprints its bundles and rewrites every
// HTML file on each deploy; a cache-first `fetch` handler would go on serving
// last week's HTML pointing at chunk hashes that no longer exist on the server,
// and the only cure would be every user hard-reloading — the exact failure a
// service worker is supposed to prevent.
//
// To retire this worker, ship an sw.js whose body is
// `self.registration.unregister()`. Browsers re-fetch this file on navigation,
// so that is enough to remove it from everybody.

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    payload = {};
  }

  event.waitUntil(
    self.registration
      .showNotification(payload.title || 'Your game has started', {
        body:
          payload.body ||
          'The board is open and no clock is running yet. Play a move within 30s or it is called off.',
        // One tag, so a re-send replaces the banner rather than stacking a
        // second one for the same game.
        tag: payload.tag || 'rps-match',
        renotify: true,
        // A thirty-second window and a banner that dismisses itself do not mix.
        requireInteraction: true,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { gameId: payload.gameId || '' },
      })
      .then(function () {
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      })
      .then(function (clients) {
        // A tab that is open and visible does not need a system banner over
        // the top of it — it has the board and the chime. Telling every client
        // lets a visible one dismiss the notification itself, which keeps the
        // userVisibleOnly promise without shouting at somebody who is looking
        // straight at the answer.
        clients.forEach(function (client) {
          client.postMessage({ type: 'rps-match-summons' });
        });
      }),
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      for (var index = 0; index < clients.length; index += 1) {
        var client = clients[index];
        if (new URL(client.url).origin !== self.location.origin) continue;
        client.postMessage({ type: 'rps-match-summons' });
        return client.focus();
      }
      // The lobby rather than /play: the board route renders nothing until the
      // socket has come up and been handed the game, and the app navigates
      // there by itself the moment it has been. Opening /play directly would
      // show an empty page for the length of a connection.
      return self.clients.openWindow('/');
    }),
  );
});
