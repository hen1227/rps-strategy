import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';

import { failureMessage } from '@/errors';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import TournamentMatchRow from './TournamentMatchRow';
import TournamentSignupForm from './TournamentSignupForm';
import ScreenShell from '@/ui/ScreenShell';
import {
  Badge,
  Banner,
  EmptyState,
  GhostButton,
  GhostLink,
  LabeledInput,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';
import { useWatchGame } from '@/hooks/useWatchGame';
import { useGameStore } from '@/store/gameStore';
import { links } from '@/navigation/links';
import { setMatchResult, startTournament } from '@/store/api/tournaments';
import { useAdminToken } from '@/hooks/useAdminToken';
import { enrollBotsInTournament } from '@/store/api/bots';
import {
  championOf,
  currentTournaments,
  matchesOf,
  pastTournaments,
  playedMatchCount,
  roundsOf,
  signupFor,
  statusOf,
} from '@/store/tournamentSelectors';
import type {
  Tournament,
  TournamentMatch,
  TournamentMatchResult,
} from '@/types/protocol';
import { colors, contentWidth, radius } from '@/theme';

export default function TournamentScreen() {
  const accountId = useGameStore((state) => state.accountId);
  const tournaments = useGameStore((state) => state.tournaments);
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const spectatedGameId = useGameStore((state) => state.spectatedGameId);
  const loadTournaments = useGameStore((state) => state.loadTournaments);
  const applyTournamentUpdate = useGameStore((state) => state.applyTournamentUpdate);
  const watchGame = useWatchGame();
  const readyForTournamentMatch = useGameStore((state) => state.readyForTournamentMatch);
  const withdrawFromTournamentMatch = useGameStore(
    (state) => state.withdrawFromTournamentMatch,
  );

  // `?tournament=` opens the page on one event, which is how a card in the bot
  // history links to the event behind it. Seeded rather than forced, so picking
  // a different one from the list still works and the URL is not fought over.
  const { tournament: linkedId } = useLocalSearchParams<{ tournament?: string }>();
  const [selectedId, setSelectedId] = useState<string | null>(linkedId ?? null);
  useEffect(() => {
    if (linkedId) setSelectedId(linkedId);
  }, [linkedId]);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const admin = useAdminToken();
  const [adminTokenDraft, setAdminTokenDraft] = useState('');
  // The name and mode drafts that used to be here went with the create form —
  // see the host panel below, which now points at the admin screen's builder.

  // Two lists, because they answer different questions: what is happening, and
  // what happened. Mixing them made a finished event look like something to
  // sign up for.
  const current = useMemo(() => currentTournaments(tournaments), [tournaments]);
  const past = useMemo(() => pastTournaments(tournaments), [tournaments]);

  const selected = useMemo(
    () =>
      tournaments.find((tournament) => tournament.tournamentId === selectedId) ??
      tournaments[0] ??
      null,
    [selectedId, tournaments],
  );

  const isConnected = connectionStatus === 'connected';
  const spectateDisabled = !isConnected || Boolean(spectatedGameId);
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
    <ScreenShell width={contentWidth.standard}>
      <>
          {/*
            No back button: the shell's navigation is already the way out.

            The two controls belong beside the title, not on a line of their
            own above it — right-aligned over an empty row they read as
            floating, and the row plus the hero's padding left a band of
            nothing between the heading and the first card. The row wraps, so a
            phone still stacks them under the title rather than crushing it.
          */}
          <View style={styles.hero}>
            <View style={styles.heroRow}>
              <View style={styles.heroCopy}>
                <Text style={styles.eyebrow}>RPS STRATEGY</Text>
                <Text style={styles.title}>Tournaments</Text>
              </View>
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
                  <Text style={styles.helpText}>
                    Creating an event, and everything about how it is run — the format,
                    who may enter, the clock, the field cap — lives on the admin screen
                    now. An event is written down as a draft there and only appears here
                    once it is published, so a half-finished one is never in front of
                    anybody. What is left on this page is the match-day half: starting a
                    published event, enrolling the engines, and recording results while
                    you watch.
                  </Text>
                  <View style={styles.adminSubmit}>
                    <GhostLink
                      href={links.admin()}
                      label="OPEN THE TOURNAMENT BUILDER"
                      tone="accent"
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
            current.length > 1 && (
            <View style={styles.tournamentList}>
              {current.map((tournament) => {
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
                    <TournamentSignupForm
                      requireDiscord={selected.requireDiscord}
                      tournamentId={selected.tournamentId}
                    />
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
                              onWatch={watchGame}
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

          {past.length > 0 && (
            <Panel>
              <SectionHeading
                eyebrow="THE ARCHIVE"
                title="Past events"
                trailing={<Badge label={`${past.length}`} />}
              />
              <Text style={styles.historyHelp}>
                Every event that has finished. Open one for its full standings, roster, and
                round-by-round results.
              </Text>
              <View style={styles.historyList}>
                {past.map((tournament) => {
                  const champion = championOf(tournament);
                  const finished = tournament.completedAtUnixMs ?? tournament.createdAtUnixMs;
                  const isSelected = tournament.tournamentId === selected?.tournamentId;
                  return (
                    <Pressable
                      accessibilityLabel={`Open ${tournament.name}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isSelected }}
                      key={tournament.tournamentId}
                      onPress={() => setSelectedId(tournament.tournamentId)}
                      style={({ pressed }) => [
                        styles.historyRow,
                        isSelected && styles.historyRowSelected,
                        pressed && styles.pressed,
                      ]}
                    >
                      <View style={styles.historyCopy}>
                        <Text numberOfLines={1} style={styles.historyName}>
                          {tournament.name}
                        </Text>
                        <Text style={styles.historyMeta}>
                          {tournament.modeName} ·{' '}
                          {new Date(finished).toLocaleDateString()} ·{' '}
                          {tournament.players.length} player
                          {tournament.players.length === 1 ? '' : 's'}
                        </Text>
                      </View>
                      {champion ? (
                        <View style={styles.historyChampion}>
                          <Text style={styles.historyCrown}>♛</Text>
                          <Text numberOfLines={1} style={styles.historyChampionName}>
                            {champion}
                          </Text>
                        </View>
                      ) : (
                        <Badge label="NO RESULT" />
                      )}
                    </Pressable>
                  );
                })}
              </View>
            </Panel>
          )}
      </>
    </ScreenShell>
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
  topBarActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  hero: { paddingBottom: 6 },
  heroRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 10,
  },
  heroCopy: { flexShrink: 1, minWidth: 0 },
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

  historyHelp: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },
  historyList: { marginTop: 8 },
  historyRow: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 6,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  historyRowSelected: { backgroundColor: colors.accentSurfaceQuiet, borderRadius: radius.small },
  historyCopy: { flex: 1 },
  historyName: { color: colors.text, fontSize: 12, fontWeight: '800' },
  historyMeta: { color: colors.textFaint, fontSize: 10, marginTop: 2 },
  historyChampion: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: 150 },
  historyCrown: { color: colors.gold, fontSize: 13 },
  historyChampionName: { color: colors.goldSoft, fontSize: 11, fontWeight: '800' },
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
