import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, themedSheet } from '@/theme';
import { useGameStore } from '@/store/gameStore';
import { CALL_TO_ACTION_COPY, type TournamentCall } from '@/store/tournamentSelectors';
import { GhostButton, PrimaryButton } from '@/ui/primitives';

// A floating call to play. It follows the player while they browse the lobby or
// spectate someone else's board, and gets out of the way as soon as they are
// sitting at their own game.
//
// The call arrives as a prop, and the absolutely positioned layer it sits in
// lives in `shell/CalloutLayer`: the queue bar wants the same strip of screen,
// so something above both of them has to decide which one is showing.
export default function TournamentCallout({ call }: { call: TournamentCall }) {
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const readyForTournamentMatch = useGameStore((state) => state.readyForTournamentMatch);
  const withdrawFromTournamentMatch = useGameStore(
    (state) => state.withdrawFromTournamentMatch,
  );

  const copy = CALL_TO_ACTION_COPY[call.kind];
  const isWaiting = call.kind === 'waiting';
  const isUrgent = call.kind === 'play' || call.kind === 'ready';

  return (
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
  );
}

const styles = themedSheet(() => ({
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
    backgroundColor: colors.accentSurfaceQuiet,
    // Keeps the bar readable over the board on web and native alike.
    shadowColor: colors.surfaceDeep,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  cardUrgent: { borderColor: colors.accentBright, backgroundColor: colors.accentSurfaceRaised },
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
}));
