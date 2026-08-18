import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';

import { GameSoundEffects } from './hooks/useGameSounds';
import GameScreen from './screens/GameScreen';
import LobbyScreen from './screens/LobbyScreen';

const Stack = createNativeStackNavigator();

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: '#312e2b',
    card: '#262522',
    primary: '#81b64c',
    text: '#f5f5f5',
    border: '#45423e',
  },
};

export default function App() {
  return (
    <>
      <GameSoundEffects />
      <NavigationContainer theme={theme}>
        <StatusBar style="light" />
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: '#262522' },
            headerTintColor: '#f5f5f5',
            headerShadowVisible: false,
            contentStyle: { backgroundColor: '#312e2b' },
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
        </Stack.Navigator>
      </NavigationContainer>
    </>
  );
}
