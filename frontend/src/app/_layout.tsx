import {
  DarkTheme,
  Stack,
  ThemeProvider,
  usePathname,
} from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';

import { GameSoundEffects } from '@/hooks/useGameSounds';
import CalloutLayer from '@/features/shell/CalloutLayer';
import { useNativeAlerts } from '@/hooks/useNativeAlerts';
import { useQueuePresence } from '@/hooks/useQueuePresence';
import { ACCOUNT_CALLBACK_PATH } from '@/store/discordAuth.types';
import { usePushStore } from '@/store/push';
import { links } from '@/navigation/links';
import { useGoTo } from '@/navigation/stack';
import { useGameStore } from '@/store/gameStore';
import { activeScheme, colors } from '@/theme';
import { bootstrapAppearance, useAppearanceBootstrap } from '@/appearance/bootstrap';
import { useAppearanceGeneration } from '@/appearance/store';
import { useAccountAppearanceSync } from '@/appearance/useAccountAppearance';

// On a phone the stored look goes on here, at module scope, before anything has
// rendered — which is why a phone never flashes the default theme. In a browser
// this does nothing and `useAppearanceBootstrap` below does the work instead,
// because every page is pre-rendered in Node with the default and the first
// client render has to match it. See `appearance/bootstrap.ts`.
bootstrapAppearance();

// The one layout every page sits inside.
//
// Everything here is app-wide by nature and would otherwise be repeated on
// every page: the palette the navigator draws with, the socket, the sound
// effects, and the tournament call-out that has to be reachable from wherever
// the player happens to be standing.

/**
 * The palette the navigator itself draws with.
 *
 * Built per render rather than once at import: held as a module constant it
 * would keep the colours of whichever theme happened to be showing when this
 * file first loaded, and the navigator paints the background behind every screen
 * transition. `DarkTheme` stays the base on both schemes — what this overrides
 * is every colour react-navigation actually uses here.
 */
const navigationTheme = () => ({
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.surface,
    primary: colors.accent,
    text: colors.text,
    border: colors.border,
  },
});

/**
 * The app-level connections, so no page has to own them: one socket, one
 * tournament board, and one rule for when a live game takes over the screen.
 */
function SessionBridge() {
  const go = useGoTo();
  const pathname = usePathname();
  const connect = useGameStore((state) => state.connect);
  const loadTournaments = useGameStore((state) => state.loadTournaments);
  // A game of *our own*, which is the only kind that takes over the screen.
  // A spectated game is also a `gameState`, and reading this as "any board in
  // the store" is what sent every watcher of a live game to `/play`: the one
  // page the watch screen is not.
  const gameId = useGameStore((state) =>
    state.isSpectating ? null : (state.gameState?.gameId ?? null),
  );
  const gameFinished = useGameStore((state) => state.gameState?.status === 'Finished');
  // Somebody else's game, which is the mirror image: watching does not follow a
  // person around the site, it belongs to the page it is done on. A board asked
  // for and not yet arrived counts as watching — turning back before the answer
  // comes is still turning back.
  const watching = useGameStore(
    (state) => state.isSpectating || Boolean(state.spectatedGameId),
  );
  const stopSpectating = useGameStore((state) => state.stopSpectating);
  const sessionToken = useGameStore((state) => state.sessionToken);
  const detectPush = usePushStore((state) => state.detect);

  useQueuePresence();
  useNativeAlerts();
  useAccountAppearanceSync();

  useEffect(() => {
    connect();
    loadTournaments();
  }, [connect, loadTournaments]);

  // Settle what this device can do and whether it is already set up, once.
  // This asks the browser what it already knows; it never prompts, because a
  // permission dialog nobody pressed a button for is the thing people block
  // sites over.
  useEffect(() => {
    void detectPush(sessionToken ?? null);
  }, [detectPush, sessionToken]);

  // On the web a notification is delivered to the service worker, which cannot
  // reach the store. It messages every open tab instead, and a visible one takes
  // the banner down itself: shouting at somebody who is looking straight at the
  // answer is how a useful alert becomes an annoying one. `useNativeAlerts`
  // keeps the same promise on a phone, where there is no worker to message.
  useEffect(() => {
    const container = globalThis.navigator?.serviceWorker;
    if (!container) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'rps-match-summons') return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void container.getRegistration('/').then((registration) =>
        registration?.getNotifications({ tag: 'rps-match' }).then((notifications) => {
          for (const notification of notifications) notification.close();
        }),
      );
    };
    container.addEventListener('message', onMessage);
    return () => container.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!gameId) return;
    // The review page keeps the finished game in the store on purpose, so that
    // its chat room stays open. Sending the reviewer back to the board would
    // close the very thing they opened.
    if (pathname === '/play' || pathname === '/review') return;
    // The Discord callback, whose only job is to finish a sign-in. Unconditional,
    // unlike the opening-book clause below: a game in progress is rejoined on
    // every fresh page load, and the return from Discord *is* a fresh page load,
    // so gating this on the game being over would bounce exactly the common
    // case. The ticket in the address is spent on arrival and cannot be
    // re-read, so being bounced does not cost a redirect — it costs the sign-in.
    if (pathname === ACCOUNT_CALLBACK_PATH) return;
    // The opening book, once the game is over, for the same reason: the card
    // at the end of a game invites both players to name the line they just
    // played, and a rule meant to hold people at a *live* board would bounce
    // them off the page it sent them to. A game still being played is still a
    // game to be got back to.
    if (gameFinished && pathname === '/openings') return;
    // A player's page, on the same terms and for the same reason. Once a game
    // is over both names on it are links — on the review, in the room's chat —
    // and this rule is what silently undid them: the click navigated, this
    // effect ran, and the player arrived back at the board they had just left
    // with no sign that anything had been pressed. A game still in progress is
    // still a game to be got back to, so a live board keeps its hold and does
    // not draw those names as links in the first place.
    if (gameFinished && pathname === '/player') return;
    // `go` rather than a `replace` of its own, which is the difference
    // between the board being laid *over* the lobby and the board being put
    // *in its place*. This is the way onto your own board — the only other one
    // is the watch screen handing a game over — so a `replace` here meant the
    // lobby was never on the stack underneath a game, and every rule written on
    // the assumption that it was had nothing to pop back to: `BackLink`'s
    // `dismissTo` found no `(shell)` below, fell back to its replace, and built
    // a *fresh* lobby in the board's place. That reads on a phone as a new
    // screen arriving on top rather than the game being put down, and it threw
    // the lobby away and remounted it every time somebody left a game.
    //
    // `useGoTo` is already both answers, because it decides from the page being
    // left: from a section of the lobby shell — which is where a game starts —
    // it navigates, so the shell stays underneath; from a full-screen page it
    // unwinds, so being held at a live board from one of those still cannot
    // stack anything up. Firing twice is harmless either way: the second action
    // is resolved once the first has landed, and navigating to the page already
    // showing is a no-op.
    go(links.play());
  }, [gameFinished, gameId, pathname, go]);

  // Leaving `/watch` stops the watching.
  //
  // The rule above holds a player at their own board; this is its mirror, and
  // it is a rule about the address for the same reason. The watch screen asks
  // to spectate and nothing else does, but it cannot see its own exit: the back
  // button, a swipe on a phone, and a link out of the board all unmount it, and
  // its own back button is the only way out that was telling anybody. So the
  // audience kept the person who left in it — the game went on reporting them
  // as watching, and delivering them its chat — and, because a board was still
  // in the store, every WATCH button in the lobby stayed disabled until the
  // page was refreshed. That is the bug.
  //
  // Deliberately the address rather than the screen unmounting, which is not
  // the same question: switching boards from the rail over a game replaces one
  // watch page with another, and going by the screen would put the board down
  // and pick it straight back up, emptying the screen between two games it is
  // meant to switch smoothly between.
  useEffect(() => {
    if (!watching) return;
    if (pathname === '/watch') return;
    // The record of the game just watched. A spectator who follows a finished
    // game to its review is still in that game's chat room, and closing it is
    // exactly what leaving would do — the same courtesy the rule above pays
    // the two players going over the board.
    if (pathname === '/review') return;
    stopSpectating();
  }, [pathname, stopSpectating, watching]);

  return null;
}

export default function RootLayout() {
  // Everything outside a page that has to follow the look: the navigator's own
  // palette, the status bar, and the call-out layer hung beside the stack.
  useAppearanceGeneration();
  // In a browser this changes once, when a look that is not the default goes on
  // and the markup pre-rendered in the default one has to be discarded rather
  // than hydrated into. A constant on a phone, which pre-renders nothing. See
  // `appearance/bootstrap.web.ts`.
  const treeKey = useAppearanceBootstrap();
  return (
    <ThemeProvider value={navigationTheme()}>
      <GameSoundEffects />
      {/* The one place the app has to say out loud which way round it is. */}
      <StatusBar style={activeScheme() === 'dark' ? 'light' : 'dark'} />
      <SessionBridge />
      {/*
        Only the routed tree is keyed. `SessionBridge` and `GameSoundEffects`
        sit outside it deliberately: the socket, the tournament board and the
        sound player must survive the rebuild above, and a second `connect()`
        on a socket already open would be a wasted round trip at launch.
      */}
      <View key={treeKey} style={{ flex: 1 }}>
        {/*
          No `Stack.Screen` children: every option here applies to every page,
          and page titles live in the route files, which is where the page is.
        */}
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
            // No edge swipe, anywhere.
            //
            // It was off on the board and on a battle already, for the obvious
            // reason: a game is played by dragging pieces, and the drag that
            // starts nearest the left edge of the board was being taken by iOS
            // as "go back" instead. That reason turns out not to be special to
            // those two pages. Every full-screen page here is something you
            // dragged, panned or scrolled to read, and none of them wants the
            // first inch of the screen spent on navigation — least of all when
            // what "back" reaches for is the pile of screens `navigation/stack`
            // exists to stop the app from building.
            //
            // The way out is drawn instead, in one place on every page: see
            // `ui/BackLink`, and `navigation/upFrom` for where it points.
            gestureEnabled: false,
          }}
        />
        <CalloutLayer />
      </View>
    </ThemeProvider>
  );
}
