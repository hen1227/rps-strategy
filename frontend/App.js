import {
  NavigationContainer,
  DarkTheme,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';

import TournamentCallout from './components/TournamentCallout';
import { GameSoundEffects } from './hooks/useGameSounds';
import AccountScreen from './screens/AccountScreen';
import AnalysisScreen from './screens/AnalysisScreen';
import GameScreen from './screens/GameScreen';
import LobbyScreen from './screens/LobbyScreen';
import PolicyScreen from './screens/PolicyScreen';
import TournamentScreen from './screens/TournamentScreen';
import { useGameStore } from './store/gameStore';
import { colors } from './theme';

const Stack = createNativeStackNavigator();
const navigationRef = createNavigationContainerRef();

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

// Owns the app-level connections so no screen has to: one socket, one
// tournament board, and one rule for when a live game takes over the screen.
function SessionBridge() {
  const connect = useGameStore((state) => state.connect);
  const loadTournaments = useGameStore((state) => state.loadTournaments);
  const gameId = useGameStore((state) => state.gameState?.gameId ?? null);

  useEffect(() => {
    connect();
    loadTournaments();
  }, [connect, loadTournaments]);

  useEffect(() => {
    if (!gameId || !navigationRef.isReady()) return;
    if (navigationRef.getCurrentRoute()?.name !== 'Game') navigationRef.navigate('Game');
  }, [gameId]);

  return null;
}

export default function App() {
  return (
    <>
      <GameSoundEffects />
      <NavigationContainer ref={navigationRef} theme={theme}>
        <StatusBar style="light" />
        <SessionBridge />
        <View style={{ flex: 1 }}>
          <Stack.Navigator
            screenOptions={{
              headerStyle: { backgroundColor: colors.surface },
              headerTintColor: colors.text,
              headerShadowVisible: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Screen
              name="Lobby"
              component={LobbyScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Game"
              component={GameScreen}
              options={{ headerShown: false, gestureEnabled: false }}
            />
            <Stack.Screen
              name="Analysis"
              component={AnalysisScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Tournaments"
              component={TournamentScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Account"
              component={AccountScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Policy"
              component={PolicyScreen}
              options={{ headerShown: false }}
            />
          </Stack.Navigator>
          <TournamentCallout />
        </View>
      </NavigationContainer>
    </>
  );
}
