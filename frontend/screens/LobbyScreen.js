import { useEffect } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import ModePreview from '../components/ModePreview';
import { useGameStore } from '../store/gameStore';

const formatSearchTime = (milliseconds) => `${Math.floor(milliseconds / 1000)}s`;

export default function LobbyScreen({ navigation }) {
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const connect = useGameStore((state) => state.connect);
  const modes = useGameStore((state) => state.modes);
  const modePlayerCounts = useGameStore((state) => state.modePlayerCounts);
  const queue = useGameStore((state) => state.queue);
  const joinQueue = useGameStore((state) => state.joinQueue);
  const leaveQueue = useGameStore((state) => state.leaveQueue);
  const gameState = useGameStore((state) => state.gameState);
  const error = useGameStore((state) => state.error);
  const clearError = useGameStore((state) => state.clearError);

  useEffect(() => {
    connect();
  }, [connect]);

  useEffect(() => {
    if (gameState) navigation.navigate('Game');
  }, [gameState, navigation]);

  const isConnected = connectionStatus === 'connected';

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.screen}>
          <View style={styles.header}>
            <View style={styles.brandRow}>
              <View style={styles.brandMark}>
                <Text style={styles.brandMarkText}>R</Text>
                <Text style={styles.brandMarkSlash}>/</Text>
                <Text style={styles.brandMarkText}>P</Text>
                <Text style={styles.brandMarkSlash}>/</Text>
                <Text style={styles.brandMarkText}>S</Text>
              </View>
              <View
                style={[
                  styles.connectionDot,
                  isConnected ? styles.connectionDotOnline : styles.connectionDotOffline,
                ]}
              />
            </View>
            <Text style={styles.title}>Choose your battle</Text>
            <Text style={styles.subtitle}>
              {isConnected ? 'Tap a game mode to find an opponent.' : 'Connecting to the arena…'}
            </Text>
          </View>

          <View style={styles.modeList}>
            {modes.map((mode) => {
              const playerCount = modePlayerCounts[mode.id] ?? 0;
              const isSelected = queue.isSearching && queue.modeId === mode.id;
              const isMuted = queue.isSearching && !isSelected;
              const cardStyle = [
                styles.modeCard,
                isSelected && styles.modeCardSearching,
                isMuted && styles.modeCardMuted,
              ];
              const cardContent = (
                <>
                  <ModePreview mode={mode} />

                  <View style={styles.modeContent}>
                    <View style={styles.modeTopRow}>
                      <View style={styles.versionBadge}>
                        <Text style={styles.versionText}>{mode.shortCode}</Text>
                      </View>
                      <View style={styles.playerCountBadge}>
                        <View style={styles.playerCountDot} />
                        <Text style={styles.playerCountText}>{playerCount} PLAYING</Text>
                      </View>
                    </View>

                    <Text style={styles.modeTitle}>{mode.name}</Text>
                    <Text style={styles.modeObjective} numberOfLines={2}>
                      {mode.objective}
                    </Text>

                    <View style={styles.modeFooter}>
                      {isSelected ? (
                        <>
                          <View style={styles.searchStatus}>
                            <ActivityIndicator color="#a3d160" size="small" />
                            <View>
                              <Text style={styles.searchTitle}>Finding opponent</Text>
                              <Text style={styles.searchTime}>
                                Searching · {formatSearchTime(queue.queuedForMs)}
                              </Text>
                            </View>
                          </View>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Cancel matchmaking search"
                            hitSlop={8}
                            onPress={leaveQueue}
                            style={({ pressed }) => [
                              styles.cancelButton,
                              pressed && styles.cancelButtonPressed,
                            ]}
                          >
                            <Text style={styles.cancelText}>Cancel</Text>
                          </Pressable>
                        </>
                      ) : (
                        <View style={styles.modeButtons}>
                          <Pressable
                            accessibilityLabel={`Analyze ${mode.name} with RPSFish`}
                            accessibilityRole="button"
                            disabled={isMuted}
                            onPress={() => navigation.navigate('Analysis', { mode })}
                            style={({ pressed }) => [
                              styles.analysisButton,
                              isMuted && styles.modeButtonDisabled,
                              pressed && styles.modeButtonPressed,
                            ]}
                          >
                            <Text style={styles.analysisButtonText}>ANALYZE</Text>
                          </Pressable>
                          <Pressable
                            accessibilityLabel={`Play ${mode.name} online`}
                            accessibilityRole="button"
                            disabled={!isConnected || isMuted}
                            onPress={() => joinQueue(mode.id)}
                            style={({ pressed }) => [
                              styles.playButton,
                              (!isConnected || isMuted) && styles.modeButtonDisabled,
                              pressed && styles.modeButtonPressed,
                            ]}
                          >
                            <Text style={styles.playButtonText}>
                              {isConnected ? 'PLAY' : 'CONNECTING'}
                            </Text>
                            <Text style={styles.playButtonIcon}>▶</Text>
                          </Pressable>
                        </View>
                      )}
                    </View>
                  </View>
                </>
              );

              return (
                <View key={mode.id} style={cardStyle}>
                  {cardContent}
                </View>
              );
            })}
          </View>

          {error && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss error"
              onPress={clearError}
              style={styles.errorBanner}
            >
              <Text style={styles.errorText}>{error}</Text>
              <Text style={styles.dismiss}>×</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#312e2b' },
  scrollContent: { flexGrow: 1 },
  screen: {
    width: '100%',
    maxWidth: 620,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 24,
  },
  header: { marginBottom: 22 },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  brandMark: { flexDirection: 'row', alignItems: 'center' },
  brandMarkText: { color: '#a3d160', fontSize: 13, fontWeight: '900', letterSpacing: 0.5 },
  brandMarkSlash: { color: '#77736d', fontSize: 11, fontWeight: '700', marginHorizontal: 3 },
  connectionDot: { width: 8, height: 8, borderRadius: 4 },
  connectionDotOnline: { backgroundColor: '#81b64c' },
  connectionDotOffline: { backgroundColor: '#77736d' },
  title: { color: '#f5f5f5', fontSize: 30, fontWeight: '900', letterSpacing: -0.7 },
  subtitle: { color: '#aaa7a2', fontSize: 14, lineHeight: 20, marginTop: 5 },
  modeList: { gap: 13 },
  modeCard: {
    minHeight: 154,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 13,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#4a4742',
    backgroundColor: '#262522',
    boxShadow: [
      { offsetX: 0, offsetY: 4, blurRadius: 7, color: 'rgba(23, 22, 19, 0.34)' },
    ],
    elevation: 5,
  },
  modeCardSearching: {
    borderColor: '#81b64c',
    backgroundColor: '#2b2c25',
  },
  modeCardMuted: { opacity: 0.28 },
  modeContent: { flex: 1, alignSelf: 'stretch', paddingLeft: 15 },
  modeTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  versionBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#3b3935',
  },
  versionText: { color: '#bbb8b2', fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  playerCountBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#343a2f',
  },
  playerCountDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#81b64c' },
  playerCountText: { color: '#b8d993', fontSize: 8, fontWeight: '900', letterSpacing: 0.65 },
  modeButtons: { width: '100%', flexDirection: 'row', gap: 7 },
  analysisButton: {
    flex: 1,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#5a7d78',
    backgroundColor: '#293a37',
  },
  analysisButtonText: { color: '#9be6d5', fontSize: 8, fontWeight: '900', letterSpacing: 0.9 },
  playButton: {
    flex: 1,
    height: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 7,
    backgroundColor: '#81b64c',
  },
  playButtonText: { color: '#ffffff', fontSize: 8, fontWeight: '900', letterSpacing: 0.9 },
  playButtonIcon: { color: '#ffffff', fontSize: 8 },
  modeButtonDisabled: { opacity: 0.35 },
  modeButtonPressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
  modeTitle: { color: '#ffffff', fontSize: 20, fontWeight: '900', marginTop: 8 },
  modeObjective: { color: '#aaa7a2', fontSize: 12, lineHeight: 17, marginTop: 4 },
  modeFooter: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 'auto',
    paddingTop: 7,
  },
  searchStatus: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchTitle: { color: '#f5f5f5', fontSize: 11, fontWeight: '800' },
  searchTime: { color: '#9c9993', fontSize: 9, marginTop: 1 },
  cancelButton: {
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 7,
    backgroundColor: '#46433e',
  },
  cancelButtonPressed: { opacity: 0.7 },
  cancelText: { color: '#deddd9', fontSize: 10, fontWeight: '800' },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    paddingHorizontal: 13,
    paddingVertical: 11,
    borderRadius: 9,
    backgroundColor: '#5a302d',
  },
  errorText: { flex: 1, color: '#ffd2ce', fontSize: 12 },
  dismiss: { color: '#ffd2ce', fontSize: 19, paddingHorizontal: 5 },
});
