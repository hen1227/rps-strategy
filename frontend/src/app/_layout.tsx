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
import TournamentCallout from '@/features/tournaments/TournamentCallout';
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

  useEffect(() => {
    connect();
    loadTournaments();
  }, [connect, loadTournaments]);

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
          <Stack.Screen name="bots/battle" options={{ gestureEnabled: false }} />
        </Stack>
        <TournamentCallout />
      </View>
    </ThemeProvider>
  );
}
