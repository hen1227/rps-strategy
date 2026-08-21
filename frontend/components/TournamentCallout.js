import { StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '../theme';
import { useGameStore } from '../store/gameStore';
import { CALL_TO_ACTION_COPY } from '../store/tournamentSelectors';
import { useTournamentCall } from '../store/useTournamentCall';
import { GhostButton, PrimaryButton } from './ui';

// A floating call to play, pinned above every screen. It follows the player
// while they browse the lobby or spectate someone else's board, and gets out of
// the way as soon as they are sitting at their own game.
export default function TournamentCallout() {
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const readyForTournamentMatch = useGameStore((state) => state.readyForTournamentMatch);
  const withdrawFromTournamentMatch = useGameStore(
    (state) => state.withdrawFromTournamentMatch,
  );
  const call = useTournamentCall();

  if (!call) return null;

  const copy = CALL_TO_ACTION_COPY[call.kind];
  const isWaiting = call.kind === 'waiting';
  const isUrgent = call.kind === 'play' || call.kind === 'ready';

  return (
    <View pointerEvents="box-none" style={styles.layer}>
      <View style={[styles.card, isUrgent && styles.cardUrgent]}>
        <View style={[styles.pulse, isUrgent && styles.pulseUrgent]} />
        <View style={styles.copy}>
          <Text style={styles.title} numberOfLines={2}>
            {copy.title(call)}
          </Text>
          <Text style={styles.detail} numberOfLines={2}>
            {copy.detail(call)}
          </Text>
        </View>
        {isWaiting ? (
          <GhostButton
            accessibilityLabel="Leave the tournament match queue"
            compact
            label={copy.action}
            onPress={() => withdrawFromTournamentMatch(call.tournamentId, call.matchId)}
          />
        ) : (
          <PrimaryButton
            accessibilityLabel={`Play your tournament match against ${
              call.opponent?.ign ?? 'your opponent'
            }`}
            compact
            disabled={connectionStatus !== 'connected'}
            label={copy.action}
            onPress={() => readyForTournamentMatch(call.tournamentId, call.matchId)}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 14,
  },
  card: {
    width: '100%',
    maxWidth: 620,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: '#2b3026',
    // Keeps the bar readable over the board on web and native alike.
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  cardUrgent: { borderColor: colors.accentBright, backgroundColor: '#35402c' },
  pulse: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.textFaint,
  },
  pulseUrgent: { backgroundColor: colors.accentBright },
  copy: { flex: 1 },
  title: { color: colors.textStrong, fontSize: 13, fontWeight: '900' },
  detail: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
});
