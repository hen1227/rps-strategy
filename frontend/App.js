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
import BotGuideScreen from './screens/BotGuideScreen';
import AdminScreen from './screens/AdminScreen';
import AnalysisScreen from './screens/AnalysisScreen';
import BotBattleScreen from './screens/BotBattleScreen';
import GameScreen from './screens/GameScreen';
import LobbyScreen from './screens/LobbyScreen';
import OpeningBookScreen from './screens/OpeningBookScreen';
import PolicyScreen from './screens/PolicyScreen';
import ReviewScreen from './screens/ReviewScreen';
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
    // The review screen keeps the finished game in the store on purpose, so
    // that its chat room stays open. Sending the reviewer back to the board
    // would close the very thing they opened.
    const route = navigationRef.getCurrentRoute()?.name;
    if (route !== 'Game' && route !== 'Review') navigationRef.navigate('Game');
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
              name="BotBattle"
              component={BotBattleScreen}
              options={{ headerShown: false, gestureEnabled: false }}
            />
            <Stack.Screen
              name="Review"
              component={ReviewScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Tournaments"
              component={TournamentScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Openings"
              component={OpeningBookScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Account"
              component={AccountScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="BotGuide"
              component={BotGuideScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Admin"
              component={AdminScreen}
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
