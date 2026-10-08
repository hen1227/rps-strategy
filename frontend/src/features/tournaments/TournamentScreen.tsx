import { useLocalSearchParams } from 'expo-router';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { failureMessage } from '@/errors';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';

import TournamentMatchRow from './TournamentMatchRow';
import TournamentOverview from './TournamentOverview';
import {
  FORMAT_LABELS,
  matchesForFilter,
  overviewMatches,
  type MatchFilter,
} from './tournamentBoard';
import TournamentRegisterForm, {
  hasEntryPanel,
} from './TournamentRegisterForm';
import PlayerLink from '@/ui/PlayerLink';
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
import { useWideScreen } from '@/hooks/useBoardLayout';
import { useGameStore } from '@/store/gameStore';
import { links } from '@/navigation/links';
import {
  setMatchResult,
  startTournament,
  withdrawFromTournament,
} from '@/store/api/tournaments';
import { useAdminToken } from '@/hooks/useAdminToken';
import { useMyBots } from '@/hooks/useMyBots';
import {
  championOf,
  currentTournaments,
  entrantHandle,
  entryFor,
  leadersOf,
  matchesOf,
  pastTournaments,
  playedMatchCount,
  statusOf,
} from '@/store/tournamentSelectors';
import type {
  Tournament,
  TournamentMatch,
  TournamentMatchResult,
} from '@/types/protocol';
import { colors, contentWidth, radius, themedSheet } from '@/theme';

export default function TournamentScreen() {
  const wide = useWideScreen();
  const scrollRef = useRef<ScrollView>(null);
  const detailOffset = useRef(0);
  const accountId = useGameStore((state) => state.accountId);
  const sessionToken = useGameStore((state) => state.sessionToken);
  const tournaments = useGameStore((state) => state.tournaments);
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const spectatedGameId = useGameStore((state) => state.spectatedGameId);
  const loadTournaments = useGameStore((state) => state.loadTournaments);
  const applyTournamentUpdate = useGameStore(
    (state) => state.applyTournamentUpdate,
  );
  const watchGame = useWatchGame();
  const readyForTournamentMatch = useGameStore(
    (state) => state.readyForTournamentMatch,
  );
  const withdrawFromTournamentMatch = useGameStore(
    (state) => state.withdrawFromTournamentMatch,
  );

  // `?tournament=` opens the page on one event, which is how a card in the bot
  // history links to the event behind it. Seeded rather than forced, so picking
  // a different one from the list still works and the URL is not fought over.
  const { tournament: linkedId } = useLocalSearchParams<{
    tournament?: string;
  }>();
  const [selectedId, setSelectedId] = useState<string | null>(linkedId ?? null);
  useEffect(() => {
    if (linkedId) setSelectedId(linkedId);
  }, [linkedId]);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const [section, setSection] = useState<'overview' | 'matches' | 'players'>(
    'overview',
  );
  const [matchFilter, setMatchFilter] = useState<MatchFilter>('all');
  const [round, setRound] = useState<number | null>(null);
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
      tournaments.find(
        (tournament) => tournament.tournamentId === selectedId,
      ) ??
      current[0] ??
      past[0] ??
      tournaments[0] ??
      null,
    [selectedId, tournaments, current, past],
  );

  const isConnected = connectionStatus === 'connected';
  const spectateDisabled = !isConnected || Boolean(spectatedGameId);
  const adminUnlocked = admin.unlocked;
  const adminToken = admin.token;
  const isBusy = busyAction !== null;
  // The account's own entry *or* its engine's: an owner who entered a bot has
  // used their one place, and the form below must not keep offering it.
  const mine = useMyBots();
  const entry = selected ? entryFor(selected, accountId, mine.userIds) : null;
  const entryIsBot = Boolean(entry) && entry?.userId !== accountId;
  const selectedMatches = matchesOf(selected);
  const liveMatches = selected ? matchesForFilter(selected, 'live') : [];
  const results = playedMatchCount(selected);
  // Everybody level at the top, so a shared first place names both.
  const winners = leadersOf(selected);
  const rounds = [
    ...new Set(selectedMatches.map((match) => match.roundNumber)),
  ].sort((a, b) => a - b);
  const displayedMatches = selected
    ? section === 'overview'
      ? overviewMatches(selected, entry?.userId)
      : matchesForFilter(selected, matchFilter).filter(
          (match) => round === null || match.roundNumber === round,
        )
    : [];
  const currentRound =
    selectedMatches.find((match) => match.result === 'pending')?.roundNumber ??
    rounds[rounds.length - 1];

  useEffect(() => {
    setSection('overview');
    setMatchFilter('all');
    setRound(null);
  }, [selected?.tournamentId]);

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

  // An entrant leaving of their own accord, which the server only allows while
  // registration is open, and only for their own entry. An engine's place is not
  // withdrawn — it is entered by its switch and leaves by it — so the button
  // this runs is drawn for people only.
  const withdraw = () =>
    runAction(
      'withdraw',
      () =>
        withdrawFromTournament(
          sessionToken ?? '',
          selected?.tournamentId ?? '',
        ),
      'You are out of the event.',
    );

  const updateResult = (
    match: TournamentMatch,
    result: TournamentMatchResult,
  ) =>
    runAction(
      `match-${match.matchId}`,
      () =>
        setMatchResult(
          adminToken,
          selected?.tournamentId ?? '',
          match.matchId,
          result,
        ),
      result === 'pending' ? 'Result cleared.' : 'Match result recorded.',
    );

  const schedule = selected ? (
    <Panel style={styles.schedulePanel}>
      <View style={styles.eventHeading}>
        <View style={styles.eventCopy}>
          <Text style={styles.eyebrow}>
            {section === 'overview' ? 'ON THE BOARDS' : 'ORDER OF PLAY'}
          </Text>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            {section === 'overview' ? 'Match center' : 'Match schedule'}
          </Text>
        </View>
        {section === 'overview' && (
          <GhostButton
            compact
            label="ALL MATCHES →"
            onPress={() => setSection('matches')}
          />
        )}
      </View>
      {section === 'matches' && (
        <>
          <View style={styles.filters}>
            {(['all', 'live', 'upcoming', 'results'] as const).map((filter) => (
              <Pressable
                key={filter}
                accessibilityRole="button"
                accessibilityState={{ selected: filter === matchFilter }}
                onPress={() => setMatchFilter(filter)}
                style={[
                  styles.filter,
                  matchFilter === filter && styles.filterSelected,
                ]}
              >
                <Text
                  style={[
                    styles.filterText,
                    matchFilter === filter && styles.tabTextSelected,
                  ]}
                >
                  {filter === 'all'
                    ? 'All'
                    : filter === 'live'
                      ? 'Live'
                      : filter === 'upcoming'
                        ? 'Upcoming'
                        : 'Results'}{' '}
                  · {matchesForFilter(selected, filter).length}
                </Text>
              </Pressable>
            ))}
          </View>
          {rounds.length > 1 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator
              contentContainerStyle={styles.roundFilters}
            >
              {[null, ...rounds].map((number) => (
                <Pressable
                  key={number ?? 'all'}
                  accessibilityRole="button"
                  accessibilityState={{ selected: round === number }}
                  onPress={() => setRound(number)}
                  style={[
                    styles.filter,
                    round === number && styles.filterSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.filterText,
                      round === number && styles.tabTextSelected,
                    ]}
                  >
                    {number === null ? 'All rounds' : `Round ${number}`}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </>
      )}
      {selected.field !== 'bots' && selected.status === 'in_progress' && (
        <Text style={styles.helpText}>
          Ready up to start when your opponent is ready.
        </Text>
      )}
      <View style={styles.roundMatches}>
        {displayedMatches.length === 0 && (
          <EmptyState
            title="No matches to show"
            detail={
              selectedMatches.length === 0
                ? 'Pairings appear when the tournament starts.'
                : 'Try another round or match filter.'
            }
          />
        )}
        {displayedMatches.map((match) => (
          <View key={match.matchId}>
            <TournamentMatchRow
              compact
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
            {adminUnlocked && adminPanelOpen && (
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
    </Panel>
  ) : null;

  return (
    <ScreenShell width={contentWidth.wide} scrollRef={scrollRef}>
      <>
        <View style={styles.hero}>
          <View style={styles.heroRow}>
            <View style={styles.heroCopy}>
              <Text style={styles.eyebrow}>COMPETE</Text>
              <Text style={[styles.title, !wide && styles.mobileTitle]}>
                Tournaments
              </Text>
            </View>
            <View style={styles.topBarActions}>
              <GhostButton
                accessibilityLabel="Refresh the tournament board"
                compact
                disabled={refreshing}
                label={refreshing ? '…' : wide ? 'REFRESH' : '↻'}
                onPress={refresh}
              />
              <GhostButton
                accessibilityLabel="Toggle tournament admin controls"
                compact
                label={
                  adminPanelOpen
                    ? 'CLOSE HOST'
                    : wide
                      ? 'HOST CONTROLS'
                      : 'HOST'
                }
                onPress={() => setAdminPanelOpen((open) => !open)}
              />
            </View>
          </View>
          <Text style={styles.subtitle}>
            Live standings, performance, and results.
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
                  <Text style={styles.unlockedText}>
                    Admin commands unlocked
                  </Text>
                </View>
                <Text style={styles.helpText}>
                  Create and publish events in Admin. Start events and record
                  results here.
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
                  Paste the server admin token. This browser will remember it
                  after it has been verified.
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

        {(error || notice) && (
          <View style={styles.banners}>
            <Banner
              message={error}
              onDismiss={() => setError(null)}
              tone="error"
            />
            <Banner message={notice} onDismiss={() => setNotice(null)} />
          </View>
        )}

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
          (current.length > 1 ||
            (current.length > 0 &&
              selected?.tournamentId !== current[0].tournamentId)) && (
            <View style={styles.tournamentList}>
              {current.map((tournament) => {
                const status = statusOf(tournament);
                const isSelected =
                  tournament.tournamentId === selected?.tournamentId;
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
                      {playedMatchCount(tournament)}/
                      {matchesOf(tournament).length} results
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )
        )}

        {selected && (
          <View
            style={styles.detailStack}
            onLayout={(event) => {
              detailOffset.current = event.nativeEvent.layout.y;
            }}
          >
            <Panel style={[styles.eventPanel, !wide && styles.mobilePanel]}>
              <View style={styles.eventHeading}>
                <View style={styles.eventCopy}>
                  <Text style={styles.eyebrow}>
                    {selected.modeName.toUpperCase()} ·{' '}
                    {FORMAT_LABELS[selected.format] ?? 'Tournament'}
                  </Text>
                  <Text
                    accessibilityRole="header"
                    style={[
                      styles.eventTitle,
                      !wide && styles.mobileEventTitle,
                    ]}
                  >
                    {selected.name}
                  </Text>
                  <Text style={styles.eventMeta}>
                    {selected.gamesPerMatch || 1} game
                    {selected.gamesPerMatch > 1 ? 's' : ''} per match
                    {selected.rounds > 0 ? ` · ${selected.rounds} rounds` : ''}
                    {selected.startsAtUnixMs &&
                    selected.status === 'registration'
                      ? ` · Starts ${new Date(selected.startsAtUnixMs).toLocaleString()}`
                      : ''}
                  </Text>
                </View>
                <Badge
                  label={statusOf(selected).label}
                  tone={statusOf(selected).tone}
                />
              </View>
              {selected.description ? (
                <Text style={styles.eventDescription}>
                  {selected.description}
                </Text>
              ) : null}
              <View style={styles.eventStats}>
                <View style={[styles.eventStat, !wide && styles.mobileStat]}>
                  <Text style={styles.eventStatValue}>
                    {selected.players.length}
                  </Text>
                  <Text
                    style={[
                      styles.eventStatLabel,
                      !wide && styles.mobileStatLabel,
                    ]}
                  >
                    Players
                  </Text>
                </View>
                <View style={[styles.eventStat, !wide && styles.mobileStat]}>
                  <Text style={styles.eventStatValue}>
                    {currentRound ?? '—'}
                    <Text style={styles.statTotal}>
                      {selected.rounds ? ` / ${selected.rounds}` : ''}
                    </Text>
                  </Text>
                  <Text
                    style={[
                      styles.eventStatLabel,
                      !wide && styles.mobileStatLabel,
                    ]}
                  >
                    Round
                  </Text>
                </View>
                <View style={[styles.eventStat, !wide && styles.mobileStat]}>
                  <Text style={styles.eventStatValue}>
                    {results}
                    <Text style={styles.statTotal}>
                      {' '}
                      / {selectedMatches.length}
                    </Text>
                  </Text>
                  <Text
                    style={[
                      styles.eventStatLabel,
                      !wide && styles.mobileStatLabel,
                    ]}
                  >
                    Results
                  </Text>
                </View>
                <View style={[styles.eventStat, !wide && styles.mobileStat]}>
                  <Text
                    style={[
                      styles.eventStatValue,
                      liveMatches.length > 0 && styles.liveValue,
                    ]}
                  >
                    {liveMatches.length}
                  </Text>
                  <Text
                    style={[
                      styles.eventStatLabel,
                      !wide && styles.mobileStatLabel,
                    ]}
                  >
                    Live matches
                  </Text>
                </View>
              </View>
              {selected.status === 'completed' && winners.length > 0 && (
                <View style={styles.championCard}>
                  <Text style={styles.championCrown}>♛</Text>
                  <View style={styles.championCopy}>
                    <Text style={styles.championLabel}>
                      {winners.length > 1
                        ? `JOINT WINNERS · ${winners[0].points} POINT${
                            winners[0].points === 1 ? '' : 'S'
                          } EACH`
                        : 'TOURNAMENT WINNER'}
                    </Text>
                    <View style={styles.championNames}>
                      {winners.map((winner, index) => (
                        <Fragment key={winner.playerId}>
                          {index > 0 && (
                            <Text style={styles.championName}>
                              {index === winners.length - 1 ? ' & ' : ', '}
                            </Text>
                          )}
                          <PlayerLink
                            handle={entrantHandle(selected, winner.playerId)}
                            name={winner.ign}
                            style={styles.championName}
                          />
                        </Fragment>
                      ))}
                    </View>
                  </View>
                </View>
              )}

              {selected.status === 'registration' &&
                hasEntryPanel(selected, accountId, mine.bots) && (
                  <View style={styles.signupSection}>
                    <SectionHeading
                      eyebrow="ENTER THE EVENT"
                      title={
                        selected.field === 'bots'
                          ? 'Your engines'
                          : 'Registration'
                      }
                    />
                    <TournamentRegisterForm tournament={selected} />
                  </View>
                )}

              {entry && selected.status === 'registration' ? (
                <View style={styles.signedUpCard}>
                  <Text style={styles.signedUpCheck}>✓</Text>
                  <View style={styles.signedUpCopy}>
                    <Text style={styles.signedUpTitle}>
                      {entryIsBot
                        ? `${entry.ign} is in the field`
                        : `You are registered as ${entry.ign}`}
                    </Text>
                    <Text style={styles.signedUpMeta}>
                      {/* No way out for an engine, because there is no way in
                            either: the switch above is both. Saying so here is
                            what stops an owner hunting for a button. */}
                      {entryIsBot
                        ? `Seed #${entry.signupOrder} · it entered on its Tournaments switch, ` +
                          'and turning that off is how it stays out'
                        : `Seed #${entry.signupOrder} · Discord: ${entry.discord}`}
                    </Text>
                  </View>
                  {selected.status === 'registration' && !entryIsBot ? (
                    <GhostButton
                      compact
                      disabled={isBusy}
                      label={busyAction === 'withdraw' ? 'LEAVING' : 'WITHDRAW'}
                      onPress={withdraw}
                    />
                  ) : null}
                </View>
              ) : null}

              {adminUnlocked &&
                adminPanelOpen &&
                selected.status === 'registration' && (
                  <View style={styles.hostAction}>
                    <View style={styles.hostActionCopy}>
                      <Text style={styles.cardTitle}>Ready to begin?</Text>
                      <Text style={styles.helpText}>
                        Starting closes signup and creates the opening pairings.
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

            <View accessibilityRole="tablist" style={styles.tabs}>
              {(['overview', 'matches', 'players'] as const).map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: section === item }}
                  onPress={() => setSection(item)}
                  style={[
                    styles.tab,
                    !wide && styles.mobileTab,
                    section === item && styles.tabSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.tabText,
                      !wide && styles.mobileTabText,
                      section === item && styles.tabTextSelected,
                    ]}
                  >
                    {item === 'overview'
                      ? 'Overview'
                      : item === 'matches'
                        ? `Matches (${selectedMatches.length})`
                        : `Players (${selected.players.length})`}
                  </Text>
                </Pressable>
              ))}
            </View>

            {section === 'overview' && (
              <TournamentOverview
                key={selected.tournamentId}
                tournament={selected}
                ownPlayerId={entry?.playerId}
                onInspect={(offset) =>
                  scrollRef.current?.scrollTo({
                    y: detailOffset.current + offset - 16,
                    animated: true,
                  })
                }
              >
                {selectedMatches.length > 0 ? schedule : null}
              </TournamentOverview>
            )}

            {section === 'matches' && schedule}

            {section === 'players' && (
              <Panel>
                <SectionHeading
                  eyebrow="ROSTER"
                  title="Players"
                  trailing={
                    <Text style={styles.countText}>
                      {selected.players.length}
                    </Text>
                  }
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
                        <Text style={styles.seedNumber}>
                          {player.signupOrder}
                        </Text>
                        <View style={styles.rosterIdentity}>
                          <Text style={styles.rosterIGN}>
                            <PlayerLink
                              handle={player.userId}
                              name={player.ign}
                            />
                            {player.userId === accountId ? ' (you)' : ''}
                          </Text>
                          <Text style={styles.rosterDiscord}>
                            {player.discord}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </Panel>
            )}
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
              Past events with standings and results.
            </Text>
            <View style={styles.historyList}>
              {past.map((tournament) => {
                const champion = championOf(tournament);
                const finished =
                  tournament.completedAtUnixMs ?? tournament.createdAtUnixMs;
                const isSelected =
                  tournament.tournamentId === selected?.tournamentId;
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
                        <Text
                          numberOfLines={1}
                          style={styles.historyChampionName}
                        >
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

function ResultButton({
  label,
  selected,
  disabled,
  onPress,
}: ResultButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{
        selected: Boolean(selected),
        disabled: Boolean(disabled),
      }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.resultButton,
        selected && styles.resultButtonSelected,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.resultButtonText,
          selected && styles.resultButtonTextSelected,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = themedSheet(() => ({
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
  eyebrow: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 2.1,
  },
  title: {
    color: colors.textStrong,
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -1,
    marginTop: 5,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 6,
  },

  adminPanel: {
    borderColor: colors.goldBorder,
    backgroundColor: colors.goldSurfaceDeep,
    marginBottom: 16,
  },
  unlockedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 12,
  },
  unlockedDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  unlockedText: { color: colors.accentSoft, fontSize: 11, fontWeight: '800' },
  adminSubmit: { marginTop: 14 },

  banners: { gap: 8 },
  helpText: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 8,
  },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '900' },

  tournamentList: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  tournamentCard: {
    flexGrow: 1,
    flexBasis: 260,
    padding: 14,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tournamentCardSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSurfaceQuiet,
  },
  tournamentCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tournamentName: {
    color: colors.textStrong,
    fontSize: 18,
    fontWeight: '900',
    marginTop: 9,
  },
  tournamentMeta: { color: colors.textDim, fontSize: 10, marginTop: 4 },

  detailStack: { gap: 16 },

  historyHelp: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 8,
  },
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
  historyRowSelected: {
    backgroundColor: colors.accentSurfaceQuiet,
    borderRadius: radius.small,
  },
  historyCopy: { flex: 1 },
  historyName: { color: colors.text, fontSize: 12, fontWeight: '800' },
  historyMeta: { color: colors.textFaint, fontSize: 10, marginTop: 2 },
  historyChampion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: 150,
  },
  historyCrown: { color: colors.gold, fontSize: 13 },
  historyChampionName: {
    color: colors.goldSoft,
    fontSize: 11,
    fontWeight: '800',
  },
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
  championCopy: { flex: 1, minWidth: 0 },
  championNames: { flexDirection: 'row', flexWrap: 'wrap' },
  championLabel: {
    color: colors.gold,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
  },
  championName: {
    color: colors.goldBright,
    fontSize: 17,
    fontWeight: '900',
    marginTop: 2,
  },

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
  signedUpCheck: {
    color: colors.accentBright,
    fontSize: 18,
    fontWeight: '900',
  },
  signedUpCopy: { flex: 1 },
  signedUpTitle: {
    color: colors.accentTextStrong,
    fontSize: 12,
    fontWeight: '900',
  },
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

  roundMatches: { gap: 8, marginTop: 16 },
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
    paddingVertical: 10,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  resultButtonSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSurfaceStrong,
  },
  resultButtonText: {
    color: colors.textDim,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.35,
  },
  resultButtonTextSelected: { color: colors.accentSoft },

  countText: { color: colors.accentBright, fontSize: 18, fontWeight: '900' },
  rosterList: { gap: 1, marginTop: 6 },
  rosterRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  seedNumber: {
    width: 28,
    color: colors.textFaint,
    fontSize: 11,
    fontWeight: '900',
  },
  rosterIdentity: { flex: 1 },
  rosterIGN: { color: colors.text, fontSize: 15, fontWeight: '800' },
  rosterDiscord: { color: colors.textMuted, fontSize: 12, marginTop: 1 },

  eventPanel: { padding: 22 },
  mobilePanel: { padding: 16 },
  mobileTitle: { fontSize: 26 },
  mobileEventTitle: { fontSize: 24 },
  mobileStat: { minWidth: 54 },
  mobileStatLabel: { fontSize: 10 },
  eventHeading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
  },
  eventCopy: { flex: 1, minWidth: 180 },
  eventTitle: {
    color: colors.textStrong,
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: -0.6,
    marginTop: 7,
  },
  eventMeta: { color: colors.textMuted, fontSize: 12, marginTop: 8 },
  eventDescription: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 12,
  },
  eventStats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 22,
    paddingTop: 18,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  eventStat: { flex: 1, minWidth: 105 },
  eventStatValue: {
    color: colors.textStrong,
    fontSize: 28,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  eventStatLabel: { color: colors.textMuted, fontSize: 12, marginTop: 3 },
  statTotal: { color: colors.textDim, fontSize: 16, fontWeight: '600' },
  liveValue: { color: colors.live },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
  },
  tabSelected: { borderBottomColor: colors.accent },
  mobileTab: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  mobileTabText: { fontSize: 12 },
  tabText: { color: colors.textMuted, fontSize: 14, fontWeight: '800' },
  tabTextSelected: { color: colors.accentBright },
  schedulePanel: { padding: 20 },
  sectionTitle: {
    color: colors.textStrong,
    fontSize: 24,
    fontWeight: '900',
    marginTop: 5,
  },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 18 },
  roundFilters: { gap: 8, paddingTop: 10, paddingBottom: 2 },
  filter: {
    minHeight: 40,
    paddingHorizontal: 13,
    justifyContent: 'center',
    borderRadius: radius.small,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  filterSelected: {
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurfaceQuiet,
  },
  filterText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
}));
