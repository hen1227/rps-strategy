import { useRouter } from 'expo-router';
import { failureMessage } from '@/errors';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import TournamentMatchRow from './TournamentMatchRow';
import TournamentSignupForm from './TournamentSignupForm';
import {
  Badge,
  Banner,
  EmptyState,
  GhostButton,
  LabeledInput,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';
import { useGameStore } from '@/store/gameStore';
import {
  createTournament,
  setMatchResult,
  startTournament,
} from '@/store/api/tournaments';
import { useAdminToken } from '@/hooks/useAdminToken';
import { enrollBotsInTournament } from '@/store/api/bots';
import {
  matchesOf,
  playedMatchCount,
  roundsOf,
  signupFor,
  statusOf,
} from '@/store/tournamentSelectors';
import { links } from '@/navigation/links';
import type { ModeID } from '@/types/game';
import type {
  Tournament,
  TournamentMatch,
  TournamentMatchResult,
} from '@/types/protocol';
import { colors, radius } from '@/theme';

export default function TournamentScreen() {
  const router = useRouter();
  const accountId = useGameStore((state) => state.accountId);
  const modes = useGameStore((state) => state.modes);
  const tournaments = useGameStore((state) => state.tournaments);
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const queue = useGameStore((state) => state.queue);
  const spectatedGameId = useGameStore((state) => state.spectatedGameId);
  const outgoingChallenge = useGameStore((state) => state.outgoingChallenge);
  const loadTournaments = useGameStore((state) => state.loadTournaments);
  const applyTournamentUpdate = useGameStore((state) => state.applyTournamentUpdate);
  const spectateGame = useGameStore((state) => state.spectateGame);
  const readyForTournamentMatch = useGameStore((state) => state.readyForTournamentMatch);
  const withdrawFromTournamentMatch = useGameStore(
    (state) => state.withdrawFromTournamentMatch,
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const admin = useAdminToken();
  const [adminTokenDraft, setAdminTokenDraft] = useState('');
  const [tournamentName, setTournamentName] = useState('');
  const [tournamentModeId, setTournamentModeId] = useState<ModeID | null>(null);

  const playableModes = useMemo(
    () => modes.filter((mode) => mode.playable !== false),
    [modes],
  );
  const selectedModeId = tournamentModeId ?? playableModes[0]?.id ?? null;
  const selected = useMemo(
    () =>
      tournaments.find((tournament) => tournament.tournamentId === selectedId) ??
      tournaments[0] ??
      null,
    [selectedId, tournaments],
  );

  const isConnected = connectionStatus === 'connected';
  const spectateDisabled =
    !isConnected ||
    queue.isSearching ||
    Boolean(spectatedGameId) ||
    Boolean(outgoingChallenge);
  const adminUnlocked = admin.unlocked;
  const adminToken = admin.token;
  const isBusy = busyAction !== null;
  const signup = selected ? signupFor(selected, accountId) : null;

  useEffect(() => {
    loadTournaments();
  }, [loadTournaments]);

  const refresh = async () => {
    setRefreshing(true);
    await loadTournaments();
    setRefreshing(false);
  };

  const runAction = async (
    key: string,
    action: () => Promise<Tournament | unknown>,
    successMessage: string,
  ) => {
    setBusyAction(key);
    setError(null);
    setNotice(null);
    try {
      const updated = (await action()) as Tournament | null;
      if (updated?.tournamentId) {
        applyTournamentUpdate(updated);
        setSelectedId(updated.tournamentId);
      }
      if (successMessage) setNotice(successMessage);
      return updated;
    } catch (requestError) {
      setError(failureMessage(requestError));
      return null;
    } finally {
      setBusyAction(null);
    }
  };

  const unlockAdmin = async () => {
    if (!adminTokenDraft.trim()) {
      setError('Paste the admin token first.');
      return;
    }
    setError(null);
    if (await admin.unlock(adminTokenDraft)) {
      setNotice('Admin commands unlocked.');
    } else {
      setError(admin.error);
    }
    setAdminTokenDraft('');
  };

  const createNewTournament = async () => {
    const created = await runAction(
      'create',
      () => createTournament(adminToken, tournamentName.trim(), selectedModeId),
      'Tournament created. Registration is open.',
    );
    if (created) setTournamentName('');
  };

  const beginTournament = () =>
    runAction(
      'start',
      () => startTournament(adminToken, selected.tournamentId),
      'Registration closed. Players can start their matches from the home screen.',
    );

  // Bots do not sign themselves up: their client is a pipe with no tournament
  // awareness. The host enrols the ones that are online and opted in, and the
  // server starts their matches when they come due.
  const enrollBots = () =>
    runAction(
      'enroll-bots',
      async () => {
        const result = await enrollBotsInTournament(adminToken, selected.tournamentId);
        await loadTournaments();
        return result;
      },
      'Online bots enrolled.',
    );

  const updateResult = (match: TournamentMatch, result: TournamentMatchResult) =>
    runAction(
      `match-${match.matchId}`,
      () => setMatchResult(adminToken, selected?.tournamentId ?? '', match.matchId, result),
      result === 'pending' ? 'Result cleared.' : 'Match result recorded.',
    );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.screen}>
          <View style={styles.topBar}>
            <Pressable
              accessibilityLabel="Back to the lobby"
              accessibilityRole="button"
              onPress={() => router.push(links.lobby())}
              style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
            >
              <Text style={styles.backText}>‹ LOBBY</Text>
            </Pressable>
            <View style={styles.topBarActions}>
              <GhostButton
                accessibilityLabel="Refresh the tournament board"
                compact
                disabled={refreshing}
                label={refreshing ? 'LOADING' : 'REFRESH'}
                onPress={refresh}
              />
              <GhostButton
                accessibilityLabel="Toggle tournament admin controls"
                compact
                label={adminUnlocked ? 'ADMIN ON' : 'HOST CONTROLS'}
                onPress={() => setAdminPanelOpen((open) => !open)}
              />
            </View>
          </View>

          <View style={styles.hero}>
            <Text style={styles.eyebrow}>RPS STRATEGY</Text>
            <Text style={styles.title}>Tournaments</Text>
            <Text style={styles.subtitle}>
              Sign up, play your matches in the app, and follow the standings live.
            </Text>
          </View>

          {adminPanelOpen && (
            <Panel style={styles.adminPanel}>
              <SectionHeading
                eyebrow="PRIVATE"
                title="Host controls"
                trailing={
                  adminUnlocked ? (
                    <GhostButton
                      compact
                      label="LOCK"
                      onPress={() => {
                        admin.lock();
                        setNotice('Admin commands locked.');
                      }}
                    />
                  ) : null
                }
              />
              {adminUnlocked ? (
                <>
                  <View style={styles.unlockedRow}>
                    <View style={styles.unlockedDot} />
                    <Text style={styles.unlockedText}>Admin commands unlocked</Text>
                  </View>
                  <LabeledInput
                    label="TOURNAMENT NAME"
                    maxLength={80}
                    onChangeText={setTournamentName}
                    placeholder="Friday Night Open"
                    value={tournamentName}
                  />
                  <Text style={styles.inputLabel}>GAME MODE</Text>
                  <View style={styles.modeChips}>
                    {playableModes.map((mode) => {
                      const isSelected = selectedModeId === mode.id;
                      return (
                        <Pressable
                          accessibilityRole="radio"
                          accessibilityState={{ checked: isSelected }}
                          key={mode.id}
                          onPress={() => setTournamentModeId(mode.id)}
                          style={({ pressed }) => [
                            styles.modeChip,
                            isSelected && styles.modeChipSelected,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Text
                            style={[
                              styles.modeChipText,
                              isSelected && styles.modeChipTextSelected,
                            ]}
                          >
                            {mode.name}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <View style={styles.adminSubmit}>
                    <PrimaryButton
                      disabled={isBusy || !tournamentName.trim() || !selectedModeId}
                      label="CREATE TOURNAMENT"
                      loading={busyAction === 'create'}
                      onPress={createNewTournament}
                    />
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.helpText}>
                    Paste the server admin token. This browser will remember it after it
                    has been verified.
                  </Text>
                  <LabeledInput
                    autoCapitalize="none"
                    autoCorrect={false}
                    label="ADMIN TOKEN"
                    onChangeText={setAdminTokenDraft}
                    placeholder="Paste token"
                    secureTextEntry
                    value={adminTokenDraft}
                  />
                  <View style={styles.adminSubmit}>
                    <PrimaryButton
                      disabled={isBusy || !adminTokenDraft.trim()}
                      label="UNLOCK COMMANDS"
                      loading={busyAction === 'unlock'}
                      onPress={unlockAdmin}
                    />
                  </View>
                </>
              )}
            </Panel>
          )}

          <View style={styles.banners}>
            <Banner message={error} onDismiss={() => setError(null)} tone="error" />
            <Banner message={notice} onDismiss={() => setNotice(null)} />
          </View>

          {tournaments.length === 0 ? (
            <Panel>
              <EmptyState
                detail="A host can create the first event with an admin token."
                title="No tournaments yet"
              />
            </Panel>
          ) : (
            // With a single event the detail panel below says everything the
            // picker would.
            tournaments.length > 1 && (
            <View style={styles.tournamentList}>
              {tournaments.map((tournament) => {
                const status = statusOf(tournament);
                const isSelected = tournament.tournamentId === selected?.tournamentId;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    key={tournament.tournamentId}
                    onPress={() => setSelectedId(tournament.tournamentId)}
                    style={({ pressed }) => [
                      styles.tournamentCard,
                      isSelected && styles.tournamentCardSelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View style={styles.tournamentCardTop}>
                      <Badge label={tournament.modeName} />
                      <Badge label={status.label} tone={status.tone} />
                    </View>
                    <Text style={styles.tournamentName}>{tournament.name}</Text>
                    <Text style={styles.tournamentMeta}>
                      {tournament.players.length} player
                      {tournament.players.length === 1 ? '' : 's'} ·{' '}
                      {playedMatchCount(tournament)}/{matchesOf(tournament).length} results
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            )
          )}

          {selected && (
            <View style={styles.detailStack}>
              <Panel>
                <SectionHeading
                  eyebrow={selected.modeName}
                  title={selected.name}
                  trailing={<Badge label={statusOf(selected).label} tone={statusOf(selected).tone} />}
                />
                {selected.status === 'completed' && selected.standings[0] && (
                  <View style={styles.championCard}>
                    <Text style={styles.championCrown}>♛</Text>
                    <View>
                      <Text style={styles.championLabel}>TOURNAMENT WINNER</Text>
                      <Text style={styles.championName}>{selected.standings[0].ign}</Text>
                    </View>
                  </View>
                )}

                {selected.status === 'registration' && !signup && (
                  <View style={styles.signupSection}>
                    <SectionHeading eyebrow="ENTER THE EVENT" title="Player signup" />
                    <TournamentSignupForm tournamentId={selected.tournamentId} />
                  </View>
                )}

                {signup ? (
                  <View style={styles.signedUpCard}>
                    <Text style={styles.signedUpCheck}>✓</Text>
                    <View style={styles.signedUpCopy}>
                      <Text style={styles.signedUpTitle}>
                        You are signed up as {signup.ign}
                      </Text>
                      <Text style={styles.signedUpMeta}>
                        Seed #{signup.signupOrder} · Discord: {signup.discord}
                      </Text>
                    </View>
                  </View>
                ) : null}

                {adminUnlocked && selected.status === 'registration' && (
                  <View style={styles.hostAction}>
                    <View style={styles.hostActionCopy}>
                      <Text style={styles.cardTitle}>Add the engines</Text>
                      <Text style={styles.helpText}>
                        Enrols every bot that is online and set to enter tournaments.
                      </Text>
                    </View>
                    <PrimaryButton
                      compact
                      disabled={isBusy}
                      label="ENROL BOTS"
                      onPress={enrollBots}
                    />
                  </View>
                )}

                {adminUnlocked && selected.status === 'registration' && (
                  <View style={styles.hostAction}>
                    <View style={styles.hostActionCopy}>
                      <Text style={styles.cardTitle}>Ready to begin?</Text>
                      <Text style={styles.helpText}>
                        Starting closes signup and creates the full round-robin order.
                      </Text>
                    </View>
                    <PrimaryButton
                      compact
                      disabled={isBusy || selected.players.length < 2}
                      label="START & SEED"
                      loading={busyAction === 'start'}
                      onPress={beginTournament}
                    />
                  </View>
                )}
              </Panel>

              {matchesOf(selected).length > 0 && (
                <Panel>
                  <SectionHeading eyebrow="ORDER OF PLAY" title="Match schedule" />
                  <Text style={styles.helpText}>
                    Ready up on your match and the game starts as soon as your opponent does
                    too.
                  </Text>
                  {roundsOf(selected).map(([roundNumber, matches]) => (
                    <View key={roundNumber} style={styles.roundBlock}>
                      <Text style={styles.roundTitle}>ROUND {roundNumber}</Text>
                      <View style={styles.roundMatches}>
                        {matches.map((match) => (
                          <View key={match.matchId}>
                            <TournamentMatchRow
                              accountId={accountId}
                              match={match}
                              onPlay={() =>
                                readyForTournamentMatch(selected.tournamentId, match.matchId)
                              }
                              onWatch={(gameId) => spectateGame(gameId)}
                              onWithdraw={() =>
                                withdrawFromTournamentMatch(
                                  selected.tournamentId,
                                  match.matchId,
                                )
                              }
                              spectateDisabled={spectateDisabled}
                              tournament={selected}
                            />
                            {adminUnlocked && (
                              <View style={styles.resultButtons}>
                                <ResultButton
                                  disabled={isBusy}
                                  label={`${match.player1.ign} WIN`}
                                  onPress={() => updateResult(match, 'player1_win')}
                                  selected={match.result === 'player1_win'}
                                />
                                <ResultButton
                                  disabled={isBusy}
                                  label="DRAW"
                                  onPress={() => updateResult(match, 'draw')}
                                  selected={match.result === 'draw'}
                                />
                                <ResultButton
                                  disabled={isBusy}
                                  label={`${match.player2.ign} WIN`}
                                  onPress={() => updateResult(match, 'player2_win')}
                                  selected={match.result === 'player2_win'}
                                />
                                {match.result !== 'pending' && (
                                  <ResultButton
                                    disabled={isBusy}
                                    label="CLEAR"
                                    onPress={() => updateResult(match, 'pending')}
                                  />
                                )}
                                {busyAction === `match-${match.matchId}` && (
                                  <ActivityIndicator color={colors.accentBright} size="small" />
                                )}
                              </View>
                            )}
                          </View>
                        ))}
                      </View>
                    </View>
                  ))}
                </Panel>
              )}

              {selected.standings.length > 0 && matchesOf(selected).length > 0 && (
                <Panel>
                  <SectionHeading eyebrow="TABLE" title="Standings" />
                  <View style={[styles.standingRow, styles.standingHeader]}>
                    <Text style={[styles.standingRank, styles.standingHeaderText]}>#</Text>
                    <Text style={[styles.standingPlayer, styles.standingHeaderText]}>PLAYER</Text>
                    <Text style={[styles.standingStat, styles.standingHeaderText]}>P</Text>
                    <Text style={[styles.standingStat, styles.standingHeaderText]}>W</Text>
                    <Text style={[styles.standingStat, styles.standingHeaderText]}>D</Text>
                    <Text style={[styles.standingStat, styles.standingHeaderText]}>L</Text>
                    <Text style={[styles.standingPoints, styles.standingHeaderText]}>PTS</Text>
                  </View>
                  {selected.standings.map((standing) => (
                    <View key={standing.playerId} style={styles.standingRow}>
                      <Text style={styles.standingRank}>{standing.rank}</Text>
                      <Text style={styles.standingPlayer} numberOfLines={1}>
                        {standing.ign}
                      </Text>
                      <Text style={styles.standingStat}>{standing.played}</Text>
                      <Text style={styles.standingStat}>{standing.wins}</Text>
                      <Text style={styles.standingStat}>{standing.draws}</Text>
                      <Text style={styles.standingStat}>{standing.losses}</Text>
                      <Text style={styles.standingPoints}>{standing.points}</Text>
                    </View>
                  ))}
                  <Text style={styles.pointsNote}>3 points for a win · 1 for a draw</Text>
                </Panel>
              )}

              <Panel>
                <SectionHeading
                  eyebrow="ROSTER"
                  title="Players"
                  trailing={<Text style={styles.countText}>{selected.players.length}</Text>}
                />
                {selected.players.length === 0 ? (
                  <EmptyState
                    detail="Signups appear here as players enter."
                    title="Nobody has signed up yet"
                  />
                ) : (
                  <View style={styles.rosterList}>
                    {selected.players.map((player) => (
                      <View key={player.playerId} style={styles.rosterRow}>
                        <Text style={styles.seedNumber}>{player.signupOrder}</Text>
                        <View style={styles.rosterIdentity}>
                          <Text style={styles.rosterIGN}>
                            {player.ign}
                            {player.userId === accountId ? ' (you)' : ''}
                          </Text>
                          <Text style={styles.rosterDiscord}>{player.discord}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </Panel>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

interface ResultButtonProps {
  label: string;
  /** The result this button records, when it is the one already recorded. */
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

function ResultButton({ label, selected, disabled, onPress }: ResultButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected), disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.resultButton,
        selected && styles.resultButtonSelected,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.resultButtonText, selected && styles.resultButtonTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  scrollContent: { flexGrow: 1 },
  screen: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 96,
  },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topBarActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  backButton: { paddingVertical: 8, paddingRight: 12 },
  backText: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 0.9 },

  hero: { paddingTop: 24, paddingBottom: 22 },
  eyebrow: { color: colors.accent, fontSize: 10, fontWeight: '900', letterSpacing: 2.1 },
  title: {
    color: colors.textStrong,
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -1,
    marginTop: 5,
  },
  subtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 20, marginTop: 6 },

  adminPanel: { borderColor: colors.goldBorder, backgroundColor: colors.goldSurfaceDeep, marginBottom: 16 },
  unlockedRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 12 },
  unlockedDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  unlockedText: { color: colors.accentSoft, fontSize: 11, fontWeight: '800' },
  inputLabel: {
    color: colors.textMuted,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
    marginTop: 14,
    marginBottom: 6,
  },
  adminSubmit: { marginTop: 14 },
  modeChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  modeChip: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  modeChipSelected: { backgroundColor: colors.accentSurfaceStrong, borderColor: colors.accent },
  modeChipText: { color: colors.textMuted, fontSize: 10, fontWeight: '800' },
  modeChipTextSelected: { color: colors.accentSoft },

  banners: { gap: 8, marginBottom: 14 },
  helpText: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '900' },

  tournamentList: { gap: 9, marginBottom: 16 },
  tournamentCard: {
    padding: 14,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tournamentCardSelected: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceQuiet },
  tournamentCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tournamentName: { color: colors.textStrong, fontSize: 18, fontWeight: '900', marginTop: 9 },
  tournamentMeta: { color: colors.textDim, fontSize: 10, marginTop: 4 },

  detailStack: { gap: 12 },
  championCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 13,
    borderRadius: radius.medium,
    backgroundColor: colors.goldSurface,
    marginTop: 14,
  },
  championCrown: { color: colors.gold, fontSize: 26 },
  championLabel: { color: colors.gold, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  championName: { color: colors.goldBright, fontSize: 17, fontWeight: '900', marginTop: 2 },

  signupSection: {
    paddingTop: 16,
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  signedUpCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: radius.medium,
    backgroundColor: colors.accentSurfaceRaised,
    marginTop: 15,
  },
  signedUpCheck: { color: colors.accentBright, fontSize: 18, fontWeight: '900' },
  signedUpCopy: { flex: 1 },
  signedUpTitle: { color: colors.accentTextStrong, fontSize: 12, fontWeight: '900' },
  signedUpMeta: { color: colors.accentText, fontSize: 10, marginTop: 2 },

  hostAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 16,
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  hostActionCopy: { flex: 1 },

  roundBlock: { marginTop: 15 },
  roundTitle: {
    color: colors.textDim,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1.2,
    marginBottom: 7,
  },
  roundMatches: { gap: 8 },
  resultButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 5,
    marginTop: 7,
    marginBottom: 4,
  },
  resultButton: {
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  resultButtonSelected: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceStrong },
  resultButtonText: { color: colors.textDim, fontSize: 7, fontWeight: '900', letterSpacing: 0.35 },
  resultButtonTextSelected: { color: colors.accentSoft },

  standingRow: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  standingHeader: { minHeight: 30, marginTop: 10, borderTopWidth: 0 },
  standingHeaderText: {
    color: colors.textFaint,
    fontSize: 7,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  standingRank: { width: 25, color: colors.textMuted, fontSize: 11, fontWeight: '800' },
  standingPlayer: { flex: 1, color: colors.text, fontSize: 11, fontWeight: '800' },
  standingStat: { width: 27, textAlign: 'center', color: colors.textMuted, fontSize: 10 },
  standingPoints: {
    width: 35,
    textAlign: 'right',
    color: colors.accentBright,
    fontSize: 11,
    fontWeight: '900',
  },
  pointsNote: { color: colors.textFaint, fontSize: 9, marginTop: 9 },

  countText: { color: colors.accentBright, fontSize: 18, fontWeight: '900' },
  rosterList: { gap: 1, marginTop: 6 },
  rosterRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  seedNumber: { width: 28, color: colors.textFaint, fontSize: 11, fontWeight: '900' },
  rosterIdentity: { flex: 1 },
  rosterIGN: { color: colors.text, fontSize: 13, fontWeight: '800' },
  rosterDiscord: { color: colors.textDim, fontSize: 10, marginTop: 1 },

  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
});
