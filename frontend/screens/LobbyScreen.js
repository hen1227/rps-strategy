import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BOT_PROFILES, DEFAULT_BOT_PROFILE_ID } from '../engine/botProfiles';
import BotIcon from '../components/BotIcon';
import HowToPlayModal from '../components/HowToPlayModal';
import ModePreview from '../components/ModePreview';
import PGNImportModal from '../components/PGNImportModal';
import PositionSetupModal from '../components/PositionSetupModal';
import TournamentSpotlight from '../components/TournamentSpotlight';
import { reviewSourceFromPGN } from '../engine/gameReview';
import {
  Badge,
  EmptyState,
  GhostButton,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '../components/ui';
import { useGameStore } from '../store/gameStore';
import BotSeriesPanel from '../components/BotSeriesPanel';
import EngineBotRow from '../components/EngineBotRow';
import { colors, radius, WIDE_LAYOUT_WIDTH } from '../theme';

const formatSearchTime = (milliseconds) => `${Math.floor(milliseconds / 1000)}s`;

const playerName = (profile, fallback) => {
  const username = profile?.username?.trim();
  return username && username.toLowerCase() !== 'guest' ? username : fallback;
};

function BotLevelPicker({ label, onSelect, selectedProfileId }) {
  return (
    <View>
      {label ? <Text style={styles.botPickerLabel}>{label}</Text> : null}
      <View style={styles.botLevels}>
        {BOT_PROFILES.map((profile) => {
          const selected = profile.id === selectedProfileId;
          return (
            <Pressable
              accessibilityLabel={`${label ? `${label}, ` : ''}${profile.name}, level ${profile.rating}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              key={profile.id}
              onPress={() => onSelect(profile.id)}
              style={({ pressed }) => [
                styles.botLevel,
                selected && styles.botLevelSelected,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.botLevelArt}>
                <BotIcon profileId={profile.id} />
              </View>
              <Text style={[styles.botLevelName, selected && styles.botLevelNameSelected]}>
                {profile.name}
              </Text>
              <Text style={[styles.botLevelRating, selected && styles.botLevelRatingSelected]}>
                {profile.rating}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function LobbyScreen({ navigation }) {
  const { width } = useWindowDimensions();
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const modes = useGameStore((state) => state.modes);
  const modePlayerCounts = useGameStore((state) => state.modePlayerCounts);
  const botPlayerCount = useGameStore((state) => state.botPlayerCount);
  const startBotGame = useGameStore((state) => state.startBotGame);
  const account = useGameStore((state) => state.account);
  // Known before the socket connects, so the button does not change label a
  // moment after the lobby paints.
  const sessionToken = useGameStore((state) => state.sessionToken);
  const liveGames = useGameStore((state) => state.liveGames);
  const queue = useGameStore((state) => state.queue);
  const incomingChallenges = useGameStore((state) => state.incomingChallenges);
  const outgoingChallenge = useGameStore((state) => state.outgoingChallenge);
  const acceptingChallengeId = useGameStore((state) => state.acceptingChallengeId);
  const challengeNotice = useGameStore((state) => state.challengeNotice);
  const joinQueue = useGameStore((state) => state.joinQueue);
  const leaveQueue = useGameStore((state) => state.leaveQueue);
  const challengePlayer = useGameStore((state) => state.challengePlayer);
  const acceptChallenge = useGameStore((state) => state.acceptChallenge);
  const declineChallenge = useGameStore((state) => state.declineChallenge);
  const cancelChallenge = useGameStore((state) => state.cancelChallenge);
  const spectateGame = useGameStore((state) => state.spectateGame);
  const spectatedGameId = useGameStore((state) => state.spectatedGameId);
  const engineBots = useGameStore((state) => state.engineBots);
  const challengeBot = useGameStore((state) => state.challengeBot);
  const gameState = useGameStore((state) => state.gameState);
  const error = useGameStore((state) => state.error);
  const clearError = useGameStore((state) => state.clearError);

  const [howToPlayMode, setHowToPlayMode] = useState(null);
  const [botProfileId, setBotProfileId] = useState(DEFAULT_BOT_PROFILE_ID);
  const [battleRedProfileId, setBattleRedProfileId] = useState(DEFAULT_BOT_PROFILE_ID);
  const [battleBlueProfileId, setBattleBlueProfileId] = useState('boulder');
  const [challengeOpen, setChallengeOpen] = useState(false);
  const [challengeUsername, setChallengeUsername] = useState('');
  const [challengePosition, setChallengePosition] = useState(null);
  const [challengePositionOpen, setChallengePositionOpen] = useState(false);
  const [pgnModalOpen, setPgnModalOpen] = useState(false);
  const [engineBotModeId, setEngineBotModeId] = useState(null);

  const isWide = width >= WIDE_LAYOUT_WIDTH;
  const isConnected = connectionStatus === 'connected';

  // A retired mode keeps its analysis board but accepts no new matches.
  const playableModes = useMemo(
    () => modes.filter((mode) => mode.playable !== false),
    [modes],
  );
  const retiredModes = useMemo(
    () => modes.filter((mode) => mode.playable === false),
    [modes],
  );

  const challengeActionsDisabled =
    !isConnected || queue.isSearching || Boolean(gameState) || Boolean(outgoingChallenge);
  const spectateDisabled =
    !isConnected ||
    queue.isSearching ||
    Boolean(spectatedGameId) ||
    Boolean(outgoingChallenge);

  const submitChallenge = (mode) => {
    if (challengeActionsDisabled || !challengeUsername.trim()) return;
    if (challengePlayer(challengeUsername, mode.id, challengePosition)) {
      setChallengeUsername('');
      setChallengePosition(null);
    }
  };

  const topBar = (
    <View style={styles.topBar}>
      <View style={styles.brandMark}>
        <Text style={styles.brandMarkText}>R</Text>
        <Text style={styles.brandMarkSlash}>/</Text>
        <Text style={styles.brandMarkText}>P</Text>
        <Text style={styles.brandMarkSlash}>/</Text>
        <Text style={styles.brandMarkText}>S</Text>
      </View>
      <View style={styles.topBarActions}>
        <View style={styles.statusChip}>
          <View
            style={[
              styles.connectionDot,
              isConnected ? styles.connectionDotOnline : styles.connectionDotOffline,
            ]}
          />
          <Text style={styles.statusChipText}>{isConnected ? 'ONLINE' : 'CONNECTING'}</Text>
        </View>
        <GhostButton
          accessibilityLabel="Browse the opening book"
          compact
          label="OPENINGS"
          onPress={() => navigation.navigate('Openings')}
        />
        <GhostButton
          accessibilityLabel="Open tournaments"
          compact
          label="TOURNAMENTS"
          onPress={() => navigation.navigate('Tournaments')}
        />
        <GhostButton
          accessibilityLabel={sessionToken ? 'Edit account settings' : 'Create an account or sign in'}
          compact
          label={sessionToken ? 'ACCOUNT' : 'SIGN IN'}
          onPress={() => navigation.navigate('Account')}
        />
      </View>
    </View>
  );

  const challengeInbox =
    incomingChallenges.length > 0 || outgoingChallenge || challengeNotice ? (
      <Panel tone="accent">
        <SectionHeading eyebrow="INVITES" title="Player challenges" />
        <View style={styles.inboxList}>
          {incomingChallenges.map((challenge) => {
            const challengerName = playerName(challenge.challenger, 'Another player');
            const isAccepting = acceptingChallengeId === challenge.id;
            return (
              <View key={challenge.id} style={styles.inboxRow}>
                <View style={styles.inboxCopy}>
                  <Text style={styles.inboxTitle}>{challengerName} challenged you</Text>
                  <Text style={styles.inboxMeta}>
                    {challenge.modeName} · unranked
                    {challenge.startingPosition ? ' · custom position' : ''}
                  </Text>
                </View>
                <View style={styles.inboxActions}>
                  <GhostButton
                    accessibilityLabel={`Decline challenge from ${challengerName}`}
                    compact
                    disabled={isAccepting}
                    label="DECLINE"
                    onPress={() => declineChallenge(challenge.id)}
                  />
                  <PrimaryButton
                    accessibilityLabel={`Accept challenge from ${challengerName}`}
                    compact
                    disabled={challengeActionsDisabled}
                    label="ACCEPT"
                    loading={isAccepting}
                    onPress={() => acceptChallenge(challenge.id)}
                  />
                </View>
              </View>
            );
          })}
          {Boolean(outgoingChallenge) && (
            <View style={styles.inboxRow}>
              <View style={styles.inboxCopy}>
                <Text style={styles.inboxTitle}>
                  Waiting for {outgoingChallenge.targetUsername}
                </Text>
                <Text style={styles.inboxMeta}>
                  {outgoingChallenge.modeName}
                  {outgoingChallenge.startingPosition ? ' · custom position' : ''}
                  {' · they see this when they connect'}
                </Text>
              </View>
              <GhostButton
                accessibilityLabel="Cancel player challenge"
                compact
                label="CANCEL"
                onPress={() => cancelChallenge(outgoingChallenge.id)}
              />
            </View>
          )}
          {Boolean(challengeNotice) && <Text style={styles.inboxNotice}>{challengeNotice}</Text>}
        </View>
      </Panel>
    ) : null;

  const playSection = (
    <View>
      <SectionHeading
        eyebrow="RANKED PLAY"
        title="Choose your battle"
        trailing={
          queue.isSearching ? (
            <Badge label={`SEARCHING ${formatSearchTime(queue.queuedForMs)}`} tone="warm" />
          ) : (
            <GhostButton
              accessibilityLabel="Load a game analysis from PGN"
              compact
              label="LOAD PGN"
              onPress={() => setPgnModalOpen(true)}
            />
          )
        }
      />
      <View style={styles.modeGrid}>
        {playableModes.map((mode) => {
          const playerCount = modePlayerCounts[mode.id] ?? 0;
          // Ratings are per mode, so the card shows the one this queue uses.
          const modeElo = account?.modeRatings?.[mode.id]?.elo ?? account?.elo ?? null;
          const isSearchingThisMode = queue.isSearching && queue.modeId === mode.id;
          const isMuted = queue.isSearching && !isSearchingThisMode;

          return (
            <View
              key={mode.id}
              style={[
                styles.modeCard,
                isSearchingThisMode && styles.modeCardSearching,
                isMuted && styles.modeCardMuted,
              ]}
            >
              <ModePreview mode={mode} />
              <View style={styles.modeContent}>
                <View style={styles.modeTopRow}>
                  <View style={styles.modeBadges}>
                    <Badge label={mode.shortCode} />
                    {modeElo !== null && <Badge label={`${modeElo} ELO`} tone="accent" />}
                  </View>
                  <Badge label={`${playerCount} PLAYING`} tone={playerCount > 0 ? 'live' : 'neutral'} />
                </View>
                <Text style={styles.modeTitle}>{mode.name}</Text>
                <Text style={styles.modeObjective} numberOfLines={2}>
                  {mode.objective}
                </Text>
                <Pressable
                  accessibilityLabel={`How to play ${mode.name}`}
                  accessibilityRole="button"
                  onPress={() => setHowToPlayMode(mode)}
                  style={({ pressed }) => [styles.howToLink, pressed && styles.pressed]}
                >
                  <Text style={styles.howToLinkText}>? How to play</Text>
                </Pressable>
                <View style={styles.modeFooter}>
                  {isSearchingThisMode ? (
                    <>
                      <View style={styles.searchStatus}>
                        <ActivityIndicator color={colors.accentBright} size="small" />
                        <View>
                          <Text style={styles.searchTitle}>Finding opponent</Text>
                          <Text style={styles.searchTime}>
                            Searching · {formatSearchTime(queue.queuedForMs)}
                          </Text>
                        </View>
                      </View>
                      <GhostButton
                        accessibilityLabel="Cancel matchmaking search"
                        compact
                        label="CANCEL"
                        onPress={leaveQueue}
                      />
                    </>
                  ) : (
                    <View style={styles.modeButtons}>
                      <GhostButton
                        accessibilityLabel={`Analyze ${mode.name} with RPSFish`}
                        compact
                        disabled={isMuted}
                        label="ANALYZE"
                        onPress={() => navigation.navigate('Analysis', { mode })}
                      />
                      <PrimaryButton
                        accessibilityLabel={`Play ${mode.name} online`}
                        compact
                        disabled={!isConnected || isMuted || Boolean(outgoingChallenge)}
                        label={isConnected ? 'PLAY ▶' : 'CONNECTING'}
                        onPress={() => joinQueue(mode.id)}
                      />
                    </View>
                  )}
                </View>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );

  const selectedBotProfile =
    BOT_PROFILES.find((profile) => profile.id === botProfileId) ?? BOT_PROFILES[0];
  // RPSFish runs in a browser Worker, so bots are a website feature for now —
  // the same limit the analysis board already has.
  const botsSupported = Platform.OS === 'web';
  const botLaunchBlocked = !botsSupported || Boolean(gameState);

  // Bots run on this device, so this panel works with the server unreachable
  // and never touches a rating.
  const botSection = (
    <Panel>
      <SectionHeading
        eyebrow="PRACTICE"
        title="Play a bot"
        trailing={
          <Badge
            label={`${botPlayerCount} PLAYING BOTS`}
            tone={botPlayerCount > 0 ? 'live' : 'neutral'}
          />
        }
      />
      <Text style={styles.helpText}>
        {botsSupported
          ? 'RPSFish plays the other side in your browser. No clock, no rating, and the hint and undo buttons stay switched on.'
          : 'Bots run on the RPSFish web engine, so this practice board is available on the website.'}
      </Text>
      <BotLevelPicker onSelect={setBotProfileId} selectedProfileId={selectedBotProfile.id} />
      <Text style={styles.botBlurb}>{selectedBotProfile.blurb}</Text>
      <View style={styles.modeActionButtons}>
        {playableModes.map((mode) => {
          return (
            <View key={mode.id} style={styles.modeActionButton}>
              <PrimaryButton
                accessibilityLabel={`Play ${mode.name} against ${selectedBotProfile.name}`}
                disabled={botLaunchBlocked}
                label={`PLAY ${mode.name.toUpperCase()} ▶`}
                onPress={() => startBotGame({ mode, profileId: selectedBotProfile.id })}
              />
            </View>
          );
        })}
      </View>
    </Panel>
  );

  const battleRedProfile =
    BOT_PROFILES.find((profile) => profile.id === battleRedProfileId) ?? BOT_PROFILES[0];
  const battleBlueProfile =
    BOT_PROFILES.find((profile) => profile.id === battleBlueProfileId) ?? BOT_PROFILES[0];
  const battleLaunchBlocked = !botsSupported || Boolean(gameState);

  const botBattleSection = (
    <Panel tone="accent">
      <SectionHeading eyebrow="BOT ARENA" title="Watch bot vs bot" />
      <Text style={styles.helpText}>
        Pick both fighters, then start either mode. They run at full device speed while
        RPSFish fills the evaluation, chart, and move-by-move review live.
      </Text>
      <BotLevelPicker
        label="RED BOT"
        onSelect={setBattleRedProfileId}
        selectedProfileId={battleRedProfile.id}
      />
      <BotLevelPicker
        label="BLUE BOT"
        onSelect={setBattleBlueProfileId}
        selectedProfileId={battleBlueProfile.id}
      />
      <View style={styles.modeActionButtons}>
        {playableModes.map((mode) => {
          return (
            <View key={mode.id} style={styles.modeActionButton}>
              <PrimaryButton
                accessibilityLabel={`Watch ${battleRedProfile.name} fight ${battleBlueProfile.name} in ${mode.name}`}
                disabled={battleLaunchBlocked}
                label={`WATCH ${mode.name.toUpperCase()} ▶`}
                onPress={() =>
                  navigation.navigate('BotBattle', {
                    blueProfileId: battleBlueProfile.id,
                    mode,
                    redProfileId: battleRedProfile.id,
                  })
                }
              />
            </View>
          );
        })}
      </View>
    </Panel>
  );

  const friendSection = (
    <Panel>
      <SectionHeading
        eyebrow="PLAY WITH A FRIEND"
        title="Challenge by username"
        trailing={
          <GhostButton
            accessibilityLabel={
              challengeOpen ? 'Hide the challenge form' : 'Show the challenge form'
            }
            compact
            label={challengeOpen ? 'HIDE' : 'OPEN'}
            onPress={() => setChallengeOpen((open) => !open)}
          />
        }
      />
      {challengeOpen && (
        <View style={styles.challengeForm}>
          <Text style={styles.helpText}>
            Enter a username, optionally set a starting position, then pick the mode to send.
            One position covers both modes. The challenge waits until they connect.
          </Text>
          <View style={styles.challengeInputRow}>
            <TextInput
              accessibilityLabel="Username to challenge"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!outgoingChallenge}
              maxLength={40}
              onChangeText={setChallengeUsername}
              placeholder="Enter a username"
              placeholderTextColor={colors.textFaint}
              returnKeyType="done"
              selectionColor={colors.accent}
              style={[styles.challengeInput, Boolean(outgoingChallenge) && styles.disabled]}
              value={challengeUsername}
            />
          </View>
          <View style={styles.challengePositionList}>
            <View style={styles.positionSetupRow}>
              <View style={styles.positionSetupCopy}>
                <Text style={styles.positionSetupTitle}>Starting position</Text>
                <Text style={styles.positionSetupDetail}>
                  {challengePosition ? 'Custom position' : 'Standard position'} · Used by whichever
                  mode you send · Red moves first.
                </Text>
              </View>
              {challengePosition && (
                <GhostButton
                  accessibilityLabel="Reset the challenge starting position"
                  compact
                  disabled={Boolean(outgoingChallenge)}
                  label="RESET"
                  onPress={() => setChallengePosition(null)}
                />
              )}
              <GhostButton
                accessibilityLabel="Configure the challenge starting position"
                compact
                disabled={Boolean(outgoingChallenge)}
                label={challengePosition ? 'EDIT' : 'SET POSITION'}
                onPress={() => setChallengePositionOpen(true)}
              />
            </View>
          </View>
          <View style={styles.modeActionButtons}>
            {playableModes.map((mode) => (
              <View key={mode.id} style={styles.modeActionButton}>
                <PrimaryButton
                  accessibilityLabel={`Challenge ${challengeUsername.trim() || 'player'} to ${mode.name}`}
                  disabled={challengeActionsDisabled || !challengeUsername.trim()}
                  label={`CHALLENGE ${mode.name.toUpperCase()} ▶`}
                  onPress={() => submitChallenge(mode)}
                />
              </View>
            ))}
          </View>
        </View>
      )}
    </Panel>
  );

  const liveSection = (
    <Panel>
      <SectionHeading
        eyebrow="WATCH THE ARENA"
        title="Live games"
        trailing={
          <Badge
            label={`${liveGames.length} LIVE`}
            tone={liveGames.length > 0 ? 'live' : 'neutral'}
          />
        }
      />
      {liveGames.length === 0 ? (
        <EmptyState
          detail="Start a match or watch a tournament board when one opens."
          title="No games are live right now"
        />
      ) : (
        <View style={styles.liveList}>
          {liveGames.map((liveGame) => {
            const redName = playerName(liveGame.redPlayer, 'Red player');
            const blueName = playerName(liveGame.bluePlayer, 'Blue player');
            const spectators = liveGame.spectatorCount ?? 0;
            return (
              <View key={liveGame.gameId} style={styles.liveRow}>
                <View style={styles.liveCopy}>
                  <Text style={styles.liveMatchup} numberOfLines={1}>
                    {redName} <Text style={styles.eloText}>({liveGame.redElo})</Text>
                    <Text style={styles.versusText}> vs </Text>
                    {blueName} <Text style={styles.eloText}>({liveGame.blueElo})</Text>
                  </Text>
                  <Text style={styles.liveMeta}>
                    {liveGame.modeName} ·{' '}
                    {spectators === 1 ? '1 spectator' : `${spectators} spectators`}
                  </Text>
                </View>
                <GhostButton
                  accessibilityLabel={`Spectate ${redName} versus ${blueName}`}
                  compact
                  disabled={spectateDisabled}
                  label={spectatedGameId === liveGame.gameId ? 'OPENING' : '◉ WATCH'}
                  onPress={() => spectateGame(liveGame.gameId)}
                />
              </View>
            );
          })}
        </View>
      )}
    </Panel>
  );

  // Engines somebody is running on their own machine. Deliberately *not*
  // gated on `botsSupported` like the panel above: that gate exists because
  // the browser bots need RPSFish in a Worker, and an engine bot runs on
  // somebody else's computer, so iOS can challenge one perfectly well.
  const engineBotMode =
    playableModes.find((mode) => mode.id === engineBotModeId) ?? playableModes[0] ?? null;
  const onlineBotSection = (
    <Panel>
      <SectionHeading
        eyebrow="PLAYERS' ENGINES"
        title="Bots online"
        trailing={
          <View style={styles.engineBotHeading}>
            <Badge
              label={`${engineBots.length} ONLINE`}
              tone={engineBots.length > 0 ? 'accent' : 'neutral'}
            />
            <GhostButton
              compact
              label="CONNECT ONE"
              onPress={() => navigation.navigate('BotGuide')}
            />
          </View>
        }
      />
      {engineBots.length === 0 ? (
        <EmptyState
          detail="Anyone can connect one — write a program that reads and writes lines."
          title="No engines are connected"
        />
      ) : (
        <>
          {playableModes.length > 1 ? (
            <View style={styles.engineBotModes}>
              {playableModes.map((mode) => (
                <GhostButton
                  key={mode.id}
                  compact
                  label={mode.id === engineBotMode?.id ? `▸ ${mode.name}` : mode.name}
                  onPress={() => setEngineBotModeId(mode.id)}
                />
              ))}
            </View>
          ) : null}
          <View style={styles.liveList}>
            {engineBots.map((bot) => (
              <EngineBotRow
                bot={bot}
                disabled={challengeActionsDisabled || !engineBotMode}
                key={bot.botId}
                modeId={engineBotMode?.id}
                onChallenge={() => challengeBot(bot.botId, engineBotMode?.id)}
              />
            ))}
          </View>
        </>
      )}
    </Panel>
  );

  const botSeriesSection = <BotSeriesPanel bots={engineBots} modes={playableModes} />;

  const tournamentSection = (
    <TournamentSpotlight onOpenBoard={() => navigation.navigate('Tournaments')} />
  );

  // Every online game is stored against both accounts, so the lobby always
  // carries the link that says so.
  const policyFooter = (
    <Pressable
      accessibilityLabel="Read the privacy policy and online play agreement"
      accessibilityRole="button"
      onPress={() => navigation.navigate('Policy')}
      style={({ pressed }) => [styles.policyFooter, pressed && styles.policyFooterPressed]}
    >
      <Text style={styles.policyFooterText}>
        Playing online stores every game against your account. Be nice, do not cheat —{' '}
        <Text style={styles.policyFooterLink}>Privacy & play agreement</Text>
      </Text>
    </Pressable>
  );

  const errorBanner = error ? (
    <Pressable
      accessibilityLabel="Dismiss error"
      accessibilityRole="button"
      onPress={clearError}
      style={styles.errorBanner}
    >
      <Text style={styles.errorText}>{error}</Text>
      <Text style={styles.errorDismiss}>×</Text>
    </Pressable>
  ) : null;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.screen, isWide && styles.screenWide]}>
          {topBar}
          {errorBanner}
          {isWide ? (
            <View style={styles.columns}>
              <View style={styles.mainColumn}>
                {tournamentSection}
                {challengeInbox}
                {playSection}
                {botSection}
                {botBattleSection}
              </View>
              <View style={styles.sideColumn}>
                {onlineBotSection}
                {botSeriesSection}
                {liveSection}
                {friendSection}
              </View>
            </View>
          ) : (
            <View style={styles.stack}>
              {tournamentSection}
              {challengeInbox}
              {playSection}
              {botSection}
              {botBattleSection}
              {onlineBotSection}
              {botSeriesSection}
              {liveSection}
              {friendSection}
            </View>
          )}
          {policyFooter}
        </View>
      </ScrollView>
      <HowToPlayModal
        mode={howToPlayMode}
        onClose={() => setHowToPlayMode(null)}
        visible={Boolean(howToPlayMode)}
      />
      <PositionSetupModal
        initialPosition={challengePosition}
        modes={playableModes}
        onApply={(position) => {
          setChallengePosition(position);
          setChallengePositionOpen(false);
        }}
        onClose={() => setChallengePositionOpen(false)}
        title="Challenge setup"
        visible={challengePositionOpen}
      />
      <PGNImportModal
        onClose={() => setPgnModalOpen(false)}
        onLoad={(pgn) => {
          reviewSourceFromPGN(pgn, modes);
          setPgnModalOpen(false);
          navigation.navigate('Review', { pgn });
        }}
        visible={pgnModalOpen}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  scrollContent: { flexGrow: 1 },
  screen: {
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 16,
    // Leaves room for the floating tournament call to action.
    paddingBottom: 96,
  },
  screenWide: { maxWidth: 1180 },

  policyFooter: { marginTop: 18, paddingVertical: 10, paddingHorizontal: 4 },
  policyFooterPressed: { opacity: 0.7 },
  policyFooterText: {
    color: colors.textFaint,
    fontSize: 10,
    lineHeight: 16,
    textAlign: 'center',
  },
  policyFooterLink: { color: colors.textMuted, fontWeight: '900' },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 18,
  },
  brandMark: { flexDirection: 'row', alignItems: 'center' },
  brandMarkText: {
    color: colors.accentBright,
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  brandMarkSlash: {
    color: colors.textFaint,
    fontSize: 12,
    fontWeight: '700',
    marginHorizontal: 3,
  },
  topBarActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: radius.medium,
    backgroundColor: colors.surface,
  },
  statusChipText: {
    color: colors.textMuted,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  connectionDot: { width: 7, height: 7, borderRadius: 4 },
  connectionDotOnline: { backgroundColor: colors.accent },
  connectionDotOffline: { backgroundColor: colors.textFaint },

  columns: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  mainColumn: { flex: 1.35, gap: 14 },
  sideColumn: { flex: 1, minWidth: 300, maxWidth: 420, gap: 14 },
  stack: { gap: 14 },

  inboxList: { gap: 8, marginTop: 12 },
  inboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 11,
    borderRadius: radius.medium,
    backgroundColor: colors.accentSurface,
  },
  inboxCopy: { flex: 1 },
  inboxTitle: { color: colors.textStrong, fontSize: 12, fontWeight: '900' },
  inboxMeta: { color: colors.accentText, fontSize: 10, marginTop: 2 },
  inboxActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  inboxNotice: { color: colors.accentSoft, fontSize: 11 },

  modeGrid: { gap: 12, marginTop: 12 },
  modeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 13,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  modeCardSearching: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceQuiet },
  modeCardMuted: { opacity: 0.4 },
  modeContent: { flex: 1, alignSelf: 'stretch', paddingLeft: 14 },
  modeTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modeBadges: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  modeTitle: {
    color: colors.textStrong,
    fontSize: 19,
    fontWeight: '900',
    marginTop: 10,
  },
  modeObjective: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 4 },
  howToLink: { alignSelf: 'flex-start', marginTop: 7, paddingVertical: 2 },
  howToLinkText: {
    color: colors.accentSoft,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  modeFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 'auto',
    paddingTop: 14,
  },
  modeButtons: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  searchStatus: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9 },
  searchTitle: { color: colors.text, fontSize: 12, fontWeight: '900' },
  searchTime: { color: colors.textMuted, fontSize: 10, marginTop: 1 },

  challengeForm: { marginTop: 12 },
  positionSetupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    padding: 10,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceSunken,
  },
  positionSetupCopy: { flex: 1 },
  positionSetupTitle: { color: colors.textSoft, fontSize: 10, fontWeight: '900' },
  positionSetupDetail: { color: colors.textFaint, fontSize: 8, marginTop: 2 },
  challengePositionList: { gap: 8, marginTop: 12 },
  helpText: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },
  botPickerLabel: {
    color: colors.textFaint,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1.2,
    marginTop: 14,
  },
  // Six difficulty tiles wrap into as many rows as the column allows, so the
  // whole ladder is visible at a glance on a phone and in one row on desktop.
  botLevels: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 13 },
  botLevel: {
    minWidth: 78,
    flexGrow: 1,
    alignItems: 'center',
    paddingHorizontal: 9,
    paddingTop: 8,
    paddingBottom: 9,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSunken,
  },
  botLevelSelected: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceStrong },
  botLevelArt: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 5,
  },
  botLevelName: { color: colors.textSubtle, fontSize: 11, fontWeight: '900' },
  botLevelNameSelected: { color: colors.accentTextStrong },
  botLevelRating: { color: colors.textFaint, fontSize: 9, fontWeight: '800', marginTop: 2 },
  botLevelRatingSelected: { color: colors.accentSoft },
  botBlurb: { color: colors.textDim, fontSize: 11, lineHeight: 17, marginTop: 11 },
  modeActionButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 13 },
  modeActionButton: { flexBasis: 180, flexGrow: 1 },
  challengeInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  challengeInput: {
    flex: 1,
    height: 42,
    paddingHorizontal: 12,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSunken,
    color: colors.textStrong,
    fontSize: 14,
  },

  engineBotHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  engineBotModes: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  liveList: { gap: 1, marginTop: 8 },
  liveRow: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  liveCopy: { flex: 1 },
  liveMatchup: { color: colors.text, fontSize: 12, fontWeight: '800' },
  liveMeta: { color: colors.textFaint, fontSize: 10, marginTop: 2 },
  eloText: { color: colors.textFaint, fontSize: 10, fontWeight: '600' },
  versusText: { color: colors.textFaint, fontSize: 10 },

  retiredList: { gap: 1, marginTop: 8 },
  retiredRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  retiredCopy: { flex: 1 },
  retiredName: { color: colors.text, fontSize: 13, fontWeight: '800' },
  retiredMeta: { color: colors.textFaint, fontSize: 10, marginTop: 2 },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: radius.medium,
    backgroundColor: colors.dangerSurface,
    marginBottom: 14,
  },
  errorText: { flex: 1, color: colors.dangerText, fontSize: 12 },
  errorDismiss: { color: colors.dangerText, fontSize: 18, paddingHorizontal: 5 },

  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
});
