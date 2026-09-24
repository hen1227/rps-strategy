import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { failureMessage } from '@/errors';
import { colors, themedSheet } from '@/theme';
import { useMyBots } from '@/hooks/useMyBots';
import { useWatchGame } from '@/hooks/useWatchGame';
import { withdrawFromTournament } from '@/store/api/tournaments';
import { useGameStore } from '@/store/gameStore';
import {
  entryFor,
  hiddenHomeTournamentCount,
  homeTournaments,
  liveMatchesOf,
  matchesOf,
  pendingMatchesFor,
  playedMatchCount,
  statusOf,
} from '@/store/tournamentSelectors';
import TournamentMatchRow, { type MatchActions } from './TournamentMatchRow';
import TournamentRegisterForm from './TournamentRegisterForm';
import type { Tournament } from '@/types/protocol';
import {
  Badge,
  Banner,
  EmptyState,
  GhostButton,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';

const playerCountLabel = (tournament: Tournament) => {
  const count = tournament.players?.length ?? 0;
  return `${count} player${count === 1 ? '' : 's'}`;
};

// The home screen's tournament section: register while registration is open,
// then play your own matches or watch the rest without leaving the front page.
export interface TournamentSpotlightProps {
  /** Opens the full tournament board. */
  onOpenBoard: () => void;
}

export default function TournamentSpotlight({ onOpenBoard }: TournamentSpotlightProps) {
  const accountId = useGameStore((state) => state.accountId);
  const tournaments = useGameStore((state) => state.tournaments);
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const spectatedGameId = useGameStore((state) => state.spectatedGameId);
  const watchGame = useWatchGame();
  const readyForTournamentMatch = useGameStore((state) => state.readyForTournamentMatch);
  const withdrawFromTournamentMatch = useGameStore(
    (state) => state.withdrawFromTournamentMatch,
  );

  // An event this account's engine is in counts as one of theirs on the front
  // page, same as one they entered themselves.
  const mine = useMyBots();
  const botUserIds = mine.userIds;
  const botKey = botUserIds.join(',');
  const featured = useMemo(
    () => homeTournaments(tournaments, accountId, 3, botUserIds),
    // botKey rather than the array itself: a fresh array holding the same ids
    // arrives every render and would defeat the memo.
    [tournaments, accountId, botKey],
  );
  const hiddenCount = hiddenHomeTournamentCount(tournaments, accountId, 3, botUserIds);

  const isConnected = connectionStatus === 'connected';
  // Watching somebody else's board while you wait for your own game is exactly
  // what a queue you can walk away from is for, so being queued no longer stops
  // it. The server takes you out of the queue when your game starts.
  const spectateDisabled = !isConnected || Boolean(spectatedGameId);

  if (featured.length === 0) return null;

  return (
    <View style={styles.stack}>
      {featured.map((tournament) => (
        <TournamentCard
          accountId={accountId}
          botUserIds={botUserIds}
          isConnected={isConnected}
          key={tournament.tournamentId}
          onOpenBoard={onOpenBoard}
          onPlay={(match) => readyForTournamentMatch(tournament.tournamentId, match.matchId)}
          onWatch={watchGame}
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

interface TournamentCardProps extends MatchActions {
  accountId: string;
  /** The accounts this player's engines play under. See `entryFor`. */
  botUserIds: readonly string[];
  isConnected: boolean;
  onOpenBoard: () => void;
  spectateDisabled: boolean;
  tournament: Tournament;
}

function TournamentCard({
  accountId,
  botUserIds,
  isConnected,
  onOpenBoard,
  onPlay,
  onWatch,
  onWithdraw,
  spectateDisabled,
  tournament,
}: TournamentCardProps) {
  const sessionToken = useGameStore((state) => state.sessionToken);
  const applyTournamentUpdate = useGameStore((state) => state.applyTournamentUpdate);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = statusOf(tournament);
  const entry = entryFor(tournament, accountId, botUserIds);
  const entryIsBot = Boolean(entry) && entry?.userId !== accountId;
  const isRegistration = tournament.status === 'registration';
  // An engines-only event has nothing for a person to fill in, so the button
  // that opens the panel should not promise one. See TournamentRegisterForm.
  const enginesOnly = tournament.field === 'bots';

  const leave = async () => {
    setLeaving(true);
    setError(null);
    try {
      applyTournamentUpdate(
        await withdrawFromTournament(sessionToken ?? '', tournament.tournamentId),
      );
    } catch (requestError) {
      setError(failureMessage(requestError, 'The withdrawal could not be completed.'));
    } finally {
      setLeaving(false);
    }
  };
  const myMatches = pendingMatchesFor(tournament, accountId);
  const otherLiveMatches = liveMatchesOf(tournament).filter(
    (match) => ![match.player1?.userId, match.player2?.userId].includes(accountId),
  );

  return (
    <Panel tone={entry && !isRegistration ? 'accent' : 'default'}>
      <SectionHeading
        eyebrow={entry ? 'YOUR TOURNAMENT' : 'TOURNAMENT'}
        title={tournament.name}
        trailing={<Badge label={status.label} tone={status.tone} />}
      />
      <Text style={styles.meta}>
        {tournament.modeName} · {playerCountLabel(tournament)}
        {isRegistration
          ? ' · registration open until the host starts'
          : ` · ${playedMatchCount(tournament)}/${matchesOf(tournament).length} matches played`}
      </Text>

      {isRegistration &&
        (entry ? (
          <View style={styles.signedUp}>
            <Text style={styles.signedUpCheck}>✓</Text>
            <View style={styles.signedUpCopy}>
              <Text style={styles.signedUpTitle}>
                {entryIsBot ? `${entry.ign} is in` : `You are in as ${entry.ign}`}
              </Text>
              <Text style={styles.signedUpMeta}>
                Seed #{entry.signupOrder} · the match order appears when the host starts
              </Text>
            </View>
            {/* An engine has no way out here because it had no way in: its
                switch is both, and it lives on the panel the button below
                opens. */}
            {entryIsBot ? null : (
              <GhostButton
                compact
                disabled={leaving}
                label={leaving ? 'LEAVING' : 'WITHDRAW'}
                onPress={leave}
              />
            )}
          </View>
        ) : registerOpen ? (
          <TournamentRegisterForm
            compact
            onRegistered={() => setRegisterOpen(false)}
            tournament={tournament}
          />
        ) : (
          <View style={styles.enterRow}>
            <Text style={styles.enterCopy}>
              {enginesOnly
                ? "Check which engines are set to enter."
                : 'Enter to get a seed and a schedule.'}
            </Text>
            <PrimaryButton
              compact
              label={enginesOnly ? 'YOUR ENGINES' : 'REGISTER'}
              onPress={() => setRegisterOpen(true)}
            />
          </View>
        ))}

      {error ? (
        <View style={styles.cardBanner}>
          <Banner message={error} onDismiss={() => setError(null)} tone="error" />
        </View>
      ) : null}

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
            entry
              ? `Every match on ${entryIsBot ? `${entry.ign}'s` : 'your'} card has been played.`
              : 'No games are running in this event right now.'
          }
          title={entry ? 'That card is complete' : 'Nothing live right now'}
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
        <Text style={styles.offlineNote}>Reconnecting…</Text>
      )}
    </Panel>
  );
}

const styles = themedSheet(() => ({
  stack: { gap: 12 },
  meta: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },

  enterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 13,
  },
  enterCopy: { flex: 1, color: colors.textSubtle, fontSize: 11, lineHeight: 17 },

  signedUp: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 13,
    padding: 11,
    borderRadius: 9,
    backgroundColor: colors.accentSurfaceRaised,
  },
  signedUpCheck: { color: colors.accentBright, fontSize: 18, fontWeight: '900' },
  signedUpCopy: { flex: 1, minWidth: 0 },
  cardBanner: { marginTop: 11 },
  signedUpTitle: { color: colors.accentTextStrong, fontSize: 12, fontWeight: '900' },
  signedUpMeta: { color: colors.accentText, fontSize: 10, marginTop: 2 },

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
}));
