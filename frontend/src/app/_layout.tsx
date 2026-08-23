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
import { useQueuePresence } from '@/hooks/useQueuePresence';
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
  const sessionToken = useGameStore((state) => state.sessionToken);
  const detectPush = usePushStore((state) => state.detect);

  useQueuePresence();

  useEffect(() => {
    connect();
    loadTournaments();
  }, [connect, loadTournaments]);

  // Settle what this browser can do and whether it is already set up, once.
  // This asks the browser what it already knows; it never prompts, because a
  // permission dialog nobody pressed a button for is the thing people block
  // sites over.
  useEffect(() => {
    void detectPush(sessionToken ?? null);
  }, [detectPush, sessionToken]);

  // A notification is delivered to the service worker, which cannot reach the
  // store. It messages every open tab instead, and a visible one takes the
  // banner down itself: shouting at somebody who is looking straight at the
  // answer is how a useful alert becomes an annoying one.
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
    router.replace(links.play());
  }, [gameId, pathname, router]);

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
