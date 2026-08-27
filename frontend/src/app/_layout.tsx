import {
  DarkTheme,
  Stack,
  ThemeProvider,
  usePathname,
  useRouter,
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
import { useGameStore } from '@/store/gameStore';
import { colors } from '@/theme';

// The one layout every page sits inside.
//
// Everything here is app-wide by nature and would otherwise be repeated on
// every page: the palette the navigator draws with, the socket, the sound
// effects, and the tournament call-out that has to be reachable from wherever
// the player happens to be standing.

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.surface,
    primary: colors.accent,
    text: colors.text,
    border: colors.border,
  },
};

/**
 * The app-level connections, so no page has to own them: one socket, one
 * tournament board, and one rule for when a live game takes over the screen.
 */
function SessionBridge() {
  const router = useRouter();
  const pathname = usePathname();
  const connect = useGameStore((state) => state.connect);
  const loadTournaments = useGameStore((state) => state.loadTournaments);
  const gameId = useGameStore((state) => state.gameState?.gameId ?? null);
  const gameFinished = useGameStore((state) => state.gameState?.status === 'Finished');
  const sessionToken = useGameStore((state) => state.sessionToken);
  const detectPush = usePushStore((state) => state.detect);

  useQueuePresence();
  useNativeAlerts();

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
    router.replace(links.play());
  }, [gameFinished, gameId, pathname, router]);

  return null;
}

export default function RootLayout() {
  return (
    <ThemeProvider value={theme}>
      <GameSoundEffects />
      <StatusBar style="light" />
      <SessionBridge />
      <View style={{ flex: 1 }}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          {/*
            A swipe should not take somebody out of a live game or a running
            battle. Page titles live in the route files, which is where the
            page itself is.
          */}
          <Stack.Screen name="play" options={{ gestureEnabled: false }} />
          <Stack.Screen name="battle" options={{ gestureEnabled: false }} />
        </Stack>
        <CalloutLayer />
      </View>
    </ThemeProvider>
  );
}
