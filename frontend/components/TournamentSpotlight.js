import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';
import { useGameStore } from '../store/gameStore';
import {
  hiddenHomeTournamentCount,
  homeTournaments,
  liveMatchesOf,
  matchesOf,
  pendingMatchesFor,
  playedMatchCount,
  signupFor,
  statusOf,
} from '../store/tournamentSelectors';
import TournamentMatchRow from './TournamentMatchRow';
import TournamentSignupForm from './TournamentSignupForm';
import { Badge, EmptyState, Panel, PrimaryButton, SectionHeading } from './ui';

const playerCountLabel = (tournament) => {
  const count = tournament.players?.length ?? 0;
  return `${count} player${count === 1 ? '' : 's'}`;
};

// The home screen's tournament section: sign up while registration is open,
// then play your own matches or watch the rest without leaving the front page.
export default function TournamentSpotlight({ onOpenBoard }) {
  const accountId = useGameStore((state) => state.accountId);
  const tournaments = useGameStore((state) => state.tournaments);
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const queue = useGameStore((state) => state.queue);
  const spectatedGameId = useGameStore((state) => state.spectatedGameId);
  const outgoingChallenge = useGameStore((state) => state.outgoingChallenge);
  const spectateGame = useGameStore((state) => state.spectateGame);
  const readyForTournamentMatch = useGameStore((state) => state.readyForTournamentMatch);
  const withdrawFromTournamentMatch = useGameStore(
    (state) => state.withdrawFromTournamentMatch,
  );

  const featured = useMemo(
    () => homeTournaments(tournaments, accountId),
    [tournaments, accountId],
  );
  const hiddenCount = hiddenHomeTournamentCount(tournaments, accountId);

  const isConnected = connectionStatus === 'connected';
  const spectateDisabled =
    !isConnected ||
    queue.isSearching ||
    Boolean(spectatedGameId) ||
    Boolean(outgoingChallenge);

  if (featured.length === 0) return null;

  return (
    <View style={styles.stack}>
      {featured.map((tournament) => (
        <TournamentCard
          accountId={accountId}
          isConnected={isConnected}
          key={tournament.tournamentId}
          onOpenBoard={onOpenBoard}
          onPlay={(match) => readyForTournamentMatch(tournament.tournamentId, match.matchId)}
          onWatch={(gameId) => spectateGame(gameId)}
          onWithdraw={(match) =>
            withdrawFromTournamentMatch(tournament.tournamentId, match.matchId)
          }
          spectateDisabled={spectateDisabled}
          tournament={tournament}
        />
      ))}
      {hiddenCount > 0 && (
        <Pressable
          accessibilityLabel="Open the tournament board"
          accessibilityRole="link"
          onPress={onOpenBoard}
          style={({ pressed }) => [styles.moreLink, pressed && styles.pressed]}
        >
          <Text style={styles.moreLinkText}>
            {hiddenCount} more event{hiddenCount === 1 ? '' : 's'} on the tournament board ▸
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function TournamentCard({
  accountId,
  isConnected,
  onOpenBoard,
  onPlay,
  onWatch,
  onWithdraw,
  spectateDisabled,
  tournament,
}) {
  const [signupOpen, setSignupOpen] = useState(false);
  const status = statusOf(tournament);
  const signup = signupFor(tournament, accountId);
  const isRegistration = tournament.status === 'registration';
  const myMatches = pendingMatchesFor(tournament, accountId);
  const otherLiveMatches = liveMatchesOf(tournament).filter(
    (match) => ![match.player1?.userId, match.player2?.userId].includes(accountId),
  );

  return (
    <Panel tone={signup && !isRegistration ? 'accent' : 'default'}>
      <SectionHeading
        eyebrow={signup ? 'YOUR TOURNAMENT' : 'TOURNAMENT'}
        title={tournament.name}
        trailing={<Badge label={status.label} tone={status.tone} />}
      />
      <Text style={styles.meta}>
        {tournament.modeName} · {playerCountLabel(tournament)}
        {isRegistration
          ? ' · signups open until the host starts'
          : ` · ${playedMatchCount(tournament)}/${matchesOf(tournament).length} matches played`}
      </Text>

      {isRegistration &&
        (signup ? (
          <View style={styles.signedUp}>
            <Text style={styles.signedUpCheck}>✓</Text>
            <View style={styles.signedUpCopy}>
              <Text style={styles.signedUpTitle}>You are in as {signup.ign}</Text>
              <Text style={styles.signedUpMeta}>
                Seed #{signup.signupOrder} · your match order appears when the host starts
              </Text>
            </View>
          </View>
        ) : signupOpen ? (
          <TournamentSignupForm
            compact
            onSignedUp={() => setSignupOpen(false)}
            tournamentId={tournament.tournamentId}
          />
        ) : (
          <View style={styles.enterRow}>
            <Text style={styles.enterCopy}>
              Enter the event to get a seed and a round-robin schedule.
            </Text>
            <PrimaryButton compact label="SIGN UP" onPress={() => setSignupOpen(true)} />
          </View>
        ))}

      {myMatches.length > 0 && (
        <View style={styles.group}>
          <Text style={styles.groupLabel}>YOUR MATCHES</Text>
          {myMatches.slice(0, 2).map((match, index) => (
            <TournamentMatchRow
              accountId={accountId}
              emphasise={index === 0}
              key={match.matchId}
              match={match}
              onPlay={onPlay}
              onWatch={onWatch}
              onWithdraw={onWithdraw}
              spectateDisabled={spectateDisabled}
              tournament={tournament}
            />
          ))}
          {myMatches.length > 2 && (
            <Text style={styles.moreNote}>
              {myMatches.length - 2} more of your matches on the board
            </Text>
          )}
        </View>
      )}

      {otherLiveMatches.length > 0 && (
        <View style={styles.group}>
          <Text style={styles.groupLabel}>LIVE NOW · WATCH WHILE YOU WAIT</Text>
          {otherLiveMatches.map((match) => (
            <TournamentMatchRow
              accountId={accountId}
              key={match.matchId}
              match={match}
              onWatch={onWatch}
              spectateDisabled={spectateDisabled}
              tournament={tournament}
            />
          ))}
        </View>
      )}

      {!isRegistration && myMatches.length === 0 && otherLiveMatches.length === 0 && (
        <EmptyState
          detail={
            signup
              ? 'You have played every match on your card.'
              : 'No games are running in this event right now.'
          }
          title={signup ? 'Your card is complete' : 'Nothing live right now'}
        />
      )}

      <Pressable
        accessibilityLabel={`Open the ${tournament.name} board`}
        accessibilityRole="link"
        onPress={onOpenBoard}
        style={({ pressed }) => [styles.boardLink, pressed && styles.pressed]}
      >
        <Text style={styles.boardLinkText}>
          {isRegistration ? 'Tournament board' : 'Standings & full schedule'} ▸
        </Text>
      </Pressable>
      {!isConnected && (
        <Text style={styles.offlineNote}>Reconnecting — match actions resume shortly.</Text>
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  meta: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },

  enterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 13,
  },
  enterCopy: { flex: 1, color: '#c0bdb7', fontSize: 11, lineHeight: 17 },

  signedUp: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 13,
    padding: 11,
    borderRadius: 9,
    backgroundColor: '#30422b',
  },
  signedUpCheck: { color: colors.accentBright, fontSize: 18, fontWeight: '900' },
  signedUpCopy: { flex: 1 },
  signedUpTitle: { color: '#e5f4d9', fontSize: 12, fontWeight: '900' },
  signedUpMeta: { color: '#a9c497', fontSize: 10, marginTop: 2 },

  group: { marginTop: 15, gap: 7 },
  groupLabel: {
    color: colors.textFaint,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1.1,
  },
  moreNote: { color: colors.textFaint, fontSize: 10, marginTop: 2 },

  moreLink: { alignSelf: 'flex-start', paddingVertical: 4 },
  moreLinkText: { color: colors.accentBright, fontSize: 11, fontWeight: '900' },
  boardLink: { marginTop: 14, alignSelf: 'flex-start' },
  boardLinkText: { color: colors.accentBright, fontSize: 11, fontWeight: '900' },
  offlineNote: { color: colors.textFaint, fontSize: 10, marginTop: 8 },
  pressed: { opacity: 0.7 },
});
