import { StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '../theme';
import {
  matchResultLabel,
  matchStateFor,
  seatsFor,
} from '../store/tournamentSelectors';
import { Badge, GhostButton, PrimaryButton } from './ui';

// One scheduled match, with whichever action the viewer can take on it. The
// home screen and the tournament board both render this, so a match always
// looks and behaves the same wherever it appears.
export default function TournamentMatchRow({
  accountId,
  emphasise,
  match,
  onPlay,
  onWatch,
  onWithdraw,
  spectateDisabled,
  tournament,
}) {
  const state = matchStateFor(tournament, match.matchId);
  const seats = seatsFor(match, accountId);
  const readyUserIds = state.readyUserIds ?? [];
  const iAmReady = readyUserIds.includes(accountId);
  const opponentReady = Boolean(seats) && readyUserIds.includes(seats.opponent?.userId);
  const isDecided = match.result !== 'pending';
  const isMine = Boolean(seats);

  return (
    <View
      style={[
        styles.row,
        emphasise && styles.rowEmphasised,
        isMine && !emphasise && styles.rowMine,
      ]}
    >
      <View style={styles.copy}>
        <View style={styles.metaRow}>
          <Text style={styles.meta}>
            R{match.roundNumber} · MATCH {match.matchOrder}
          </Text>
          {state.live && <Badge label="LIVE" tone="live" />}
          {isMine && !isDecided && !state.live && <Badge label="YOUR MATCH" tone="accent" />}
        </View>
        <View style={styles.versusRow}>
          <Text
            style={[styles.player, seats?.me === match.player1 && styles.playerMine]}
            numberOfLines={1}
          >
            {match.player1?.ign ?? 'TBD'}
          </Text>
          <Text style={styles.versus}>VS</Text>
          <Text
            style={[
              styles.player,
              styles.playerRight,
              seats?.me === match.player2 && styles.playerMine,
            ]}
            numberOfLines={1}
          >
            {match.player2?.ign ?? 'TBD'}
          </Text>
        </View>
        <Text style={[styles.status, isDecided && styles.statusDecided]}>
          {isDecided
            ? matchResultLabel(match)
            : state.live
              ? 'Playing now'
              : readyUserIds.length === 1
                ? `${
                    readyUserIds.includes(match.player1?.userId)
                      ? match.player1?.ign
                      : match.player2?.ign
                  } is waiting to play`
                : 'Not played yet'}
        </Text>
      </View>

      <View style={styles.actions}>
        {isDecided ? null : isMine ? (
          <>
            {(state.live || opponentReady || !iAmReady) && (
              <PrimaryButton
                accessibilityLabel={`Play your match against ${seats.opponent?.ign}`}
                compact
                label={state.live || opponentReady ? 'PLAY NOW' : 'READY UP'}
                onPress={() => onPlay?.(match)}
              />
            )}
            {iAmReady && !state.live && (
              <GhostButton
                accessibilityLabel="Leave the match queue"
                compact
                label="WAITING · LEAVE"
                onPress={() => onWithdraw?.(match)}
              />
            )}
          </>
        ) : (
          state.live && (
            <GhostButton
              accessibilityLabel={`Watch ${match.player1?.ign} versus ${match.player2?.ign}`}
              compact
              disabled={spectateDisabled}
              label="◉ WATCH"
              onPress={() => onWatch?.(state.gameId)}
            />
          )
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: colors.surfaceRaised,
  },
  rowMine: { borderColor: '#4b5b3c' },
  rowEmphasised: { borderColor: colors.accent, backgroundColor: '#333a2c' },
  copy: { flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  meta: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 0.8 },
  versusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 7 },
  player: { flex: 1, color: colors.textStrong, fontSize: 13, fontWeight: '900' },
  playerRight: { textAlign: 'right' },
  playerMine: { color: colors.accentBright },
  versus: { color: '#69655f', fontSize: 8, fontWeight: '900', marginHorizontal: 9 },
  status: { color: colors.textMuted, fontSize: 10, marginTop: 5 },
  statusDecided: { color: colors.accentSoft, fontWeight: '800' },
  actions: { alignItems: 'flex-end', gap: 6 },
});
