import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import GameSetupEditor from './GameSetupEditor';
import MatchAlertsPanel from '@/features/queue/MatchAlertsPanel';
import HowToPlayModal from '@/features/game/HowToPlayModal';
import ModePreview from '@/features/game/ModePreview';
import SetupPreview from '@/features/game/SetupPreview';
import PGNImportModal from '@/features/pgn/PGNImportModal';
import PositionSetupModal from '@/features/pgn/PositionSetupModal';
import TournamentSpotlight from '@/features/tournaments/TournamentSpotlight';
import { reviewSourceFromPGN } from '@/engine/gameReview';
import { CALLOUT_RESERVE } from '@/features/shell/CalloutLayer';
import { useWideScreen } from '@/hooks/useBoardLayout';
import { useLobbyGate, useQueueCall } from '@/hooks/useQueueCall';
import { links } from '@/navigation/links';
import { useGameStore } from '@/store/gameStore';
import { useReviewHandoff } from '@/store/reviewHandoff';
import {
  customizationCount,
  hasCustomPosition,
  isStandardSetup,
  setupSummary,
  standardSetup,
} from '@/store/setupSelectors';
import { playerName } from '@/store/spectateSelectors';
import { colors, contentWidth, radius, space, type } from '@/theme';
import ListRow from '@/ui/ListRow';
import ScreenShell from '@/ui/ScreenShell';
import {
  Badge,
  EmptyState,
  GhostButton,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';
import type { GameSetup, ModeDefinition } from '@/types/game';

// Playing against people.
//
// What used to be the top two thirds of one 1024-line lobby, with the bot
// panels moved to their own section and the live-game table moved to the rail
// that exists to show it. What is left is one question — how do I get into a
// game against a person — and one answer: describe the game you want and wait
// for somebody. The mode cards above are that with nothing filled in, the setup
// panel is that with something filled in, and the open board is everybody
// else's answer to it.

export default function PlayOnlineScreen() {
  const router = useRouter();
  const handReview = useReviewHandoff((state) => state.hand);

  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const modes = useGameStore((state) => state.modes);
  const modePlayerCounts = useGameStore((state) => state.modePlayerCounts);
  const account = useGameStore((state) => state.account);
  const queue = useGameStore((state) => state.queue);
  const incomingChallenges = useGameStore((state) => state.incomingChallenges);
  const openChallenges = useGameStore((state) => state.openChallenges);
  const outgoingChallenge = useGameStore((state) => state.outgoingChallenge);
  const acceptingChallengeId = useGameStore((state) => state.acceptingChallengeId);
  const challengeNotice = useGameStore((state) => state.challengeNotice);
  const joinQueue = useGameStore((state) => state.joinQueue);
  const leaveQueue = useGameStore((state) => state.leaveQueue);
  const challengePlayer = useGameStore((state) => state.challengePlayer);
  const postOpenChallenge = useGameStore((state) => state.postOpenChallenge);
  const acceptChallenge = useGameStore((state) => state.acceptChallenge);
  const declineChallenge = useGameStore((state) => state.declineChallenge);
  const cancelChallenge = useGameStore((state) => state.cancelChallenge);
  const gameState = useGameStore((state) => state.gameState);
  const accountId = useGameStore((state) => state.accountId);
  const defaultTimeControl = useGameStore((state) => state.defaultTimeControl);

  const [howToPlayMode, setHowToPlayMode] = useState<ModeDefinition | null>(null);
  const [challengeUsername, setChallengeUsername] = useState('');
  // Null until somebody touches a knob, so the draft follows the mode catalog
  // as it arrives instead of being pinned to whatever was known at first render.
  const [draft, setDraft] = useState<GameSetup | null>(null);
  const [positionOpen, setPositionOpen] = useState(false);
  const [pgnOpen, setPgnOpen] = useState(false);

  const isConnected = connectionStatus === 'connected';
  const isWide = useWideScreen();
  // A retired mode keeps its analysis board but accepts no new matches.
  const playableModes = useMemo(() => modes.filter((mode) => mode.playable !== false), [modes]);
  const retiredModes = useMemo(() => modes.filter((mode) => mode.playable === false), [modes]);

  // Two flags rather than one. Being queued used to disable this whole page,
  // which was harmless when a search lasted twenty seconds and took the screen
  // over anyway. Now that you can sit in the queue for ten minutes while doing
  // something else, a blanket disable would make the lobby read-only — and
  // taking somebody's game off the board while queued is not a conflict at all:
  // it is the same act as being matched, only faster, and the server drops your
  // seek the moment a game starts.
  const gate = useLobbyGate();
  const queueCall = useQueueCall();
  // Empty is not a mistake here: it is what makes the game open to the lobby.
  const namedOpponent = challengeUsername.trim();

  const baseMode = playableModes[0] ?? null;
  const setup = draft ?? (baseMode ? standardSetup(baseMode, defaultTimeControl) : null);
  const setupMode = playableModes.find((mode) => mode.id === setup?.modeId) ?? baseMode;
  // The same question the server asks. Nothing changed and nobody named means
  // this is a plain search, and the button says so rather than promising a row
  // on the board that would never appear.
  const setupIsPlainSearch =
    Boolean(setup) && !namedOpponent && isStandardSetup(setup!, setupMode, defaultTimeControl);
  const setupChanges = setup ? customizationCount(setup, setupMode, defaultTimeControl) : 0;

  const resetDraft = () => setDraft(null);

  // Somebody else's open games. Your own is already shown as outgoing, and the
  // server would refuse it anyway.
  const otherOpenChallenges = openChallenges.filter(
    (challenge) => challenge.challenger.userId !== accountId,
  );

  return (
    <ScreenShell bottomInset={queueCall ? CALLOUT_RESERVE : 0} width={contentWidth.page}>
      <TournamentSpotlight onOpenBoard={() => router.push(links.tournaments())} />

      {incomingChallenges.length > 0 || outgoingChallenge || challengeNotice ? (
        <Panel tone="accent">
          <SectionHeading eyebrow="INVITES" title="Your challenges" />
          <View style={styles.inbox}>
            {incomingChallenges.map((challenge) => {
              const from = playerName(challenge.challenger, 'Another player');
              const accepting = acceptingChallengeId === challenge.id;
              return (
                <ListRow
                  divided={false}
                  key={challenge.id}
                  leading={
                    <SetupPreview
                      compact
                      defaultTimeControl={defaultTimeControl}
                      mode={modes.find((mode) => mode.id === challenge.setup.modeId)}
                      setup={challenge.setup}
                    />
                  }
                  meta={`${challenge.modeName} · ${setupSummary(
                    challenge.setup,
                    modes.find((mode) => mode.id === challenge.setup.modeId),
                    defaultTimeControl,
                  )}`}
                  style={[styles.inboxRow, styles.setupRow]}
                  title={`${from} challenged you`}
                  trailing={
                    <View style={styles.inboxActions}>
                      <GhostButton
                        accessibilityLabel={`Decline the challenge from ${from}`}
                        compact
                        disabled={accepting}
                        label="DECLINE"
                        onPress={() => declineChallenge(challenge.id)}
                      />
                      <PrimaryButton
                        accessibilityLabel={`Accept the challenge from ${from}`}
                        compact
                        disabled={gate.atBoard}
                        label="ACCEPT"
                        loading={accepting}
                        onPress={() => acceptChallenge(challenge.id)}
                      />
                    </View>
                  }
                />
              );
            })}
            {outgoingChallenge ? (
              <ListRow
                divided={false}
                leading={
                  <SetupPreview
                    compact
                    defaultTimeControl={defaultTimeControl}
                    mode={modes.find((mode) => mode.id === outgoingChallenge.setup.modeId)}
                    setup={outgoingChallenge.setup}
                  />
                }
                meta={`${setupSummary(
                  outgoingChallenge.setup,
                  modes.find((mode) => mode.id === outgoingChallenge.setup.modeId),
                  defaultTimeControl,
                )} · ${
                  outgoingChallenge.targetUsername
                    ? 'they see this when they connect'
                    : 'anyone in the lobby can take it'
                }`}
                style={[styles.inboxRow, styles.setupRow]}
                title={
                  outgoingChallenge.targetUsername
                    ? `Waiting for ${outgoingChallenge.targetUsername}`
                    : 'Your open game is up'
                }
                trailing={
                  <GhostButton
                    accessibilityLabel="Cancel your challenge"
                    compact
                    label="CANCEL"
                    onPress={() => cancelChallenge(outgoingChallenge.id)}
                  />
                }
              />
            ) : null}
            {challengeNotice ? <Text style={styles.notice}>{challengeNotice}</Text> : null}
          </View>
        </Panel>
      ) : null}

      <View>
        {/*
          No SEARCHING badge here any more. The floating bar carries the search
          on every screen, so a second copy on this one both duplicated it and
          displaced LOAD PGN for the length of a wait that can now run for
          minutes.
        */}
        <SectionHeading
          eyebrow="RANKED PLAY"
          title="Choose your battle"
          trailing={
            <GhostButton
              accessibilityLabel="Load a game analysis from PGN"
              compact
              label="LOAD PGN"
              onPress={() => setPgnOpen(true)}
            />
          }
        />
        <View style={styles.modeGrid}>
          {playableModes.map((mode) => {
            const playerCount = modePlayerCounts[mode.id] ?? 0;
            // Ratings are per mode, so the card shows the one this queue uses.
            const modeElo = account?.modeRatings?.[mode.id]?.elo ?? account?.elo ?? null;
            const searchingHere = queue.isSearching && queue.modeId === mode.id;

            return (
              <View
                key={mode.id}
                style={[styles.modeCard, searchingHere && styles.modeCardSearching]}
              >
                <ModePreview mode={mode} />
                <View style={styles.modeContent}>
                  <View style={styles.modeTopRow}>
                    <View style={styles.modeBadges}>
                      <Badge label={mode.shortCode} />
                      {modeElo !== null ? <Badge label={`${modeElo} ELO`} tone="accent" /> : null}
                    </View>
                    <Badge
                      label={`${playerCount} PLAYING`}
                      tone={playerCount > 0 ? 'live' : 'neutral'}
                    />
                  </View>
                  <Text style={styles.modeTitle}>{mode.name}</Text>
                  <Text numberOfLines={2} style={styles.modeObjective}>
                    {mode.objective}
                  </Text>
                  <Pressable
                    accessibilityLabel={`How to play ${mode.name}`}
                    accessibilityRole="button"
                    onPress={() => setHowToPlayMode(mode)}
                    style={({ pressed }) => [styles.howTo, pressed && styles.pressed]}
                  >
                    <Text style={styles.howToText}>? How to play</Text>
                  </Pressable>
                  {/*
                    The spinner and the ticking timer have moved to the floating
                    bar, which is on every screen rather than only this one. All
                    that is left here is which mode you are queued in — the card
                    keeps its accent border — and the button, which becomes the
                    way out of that queue without moving or changing size.

                    Every *other* mode's PLAY button stays live, and switching is
                    one press: the store leaves the old queue before joining the
                    new one, because the server allows one search per person.
                  */}
                  <View style={styles.modeFooter}>
                    <View style={styles.modeButtons}>
                      <GhostButton
                        accessibilityLabel={`Analyse ${mode.name} with RPSFish`}
                        compact
                        label="ANALYZE"
                        onPress={() => router.push(links.analysis(mode.id))}
                      />
                      {searchingHere ? (
                        <PrimaryButton
                          accessibilityLabel={`Leave the ${mode.name} queue`}
                          compact
                          label="IN QUEUE ✕"
                          onPress={leaveQueue}
                          tone="quiet"
                        />
                      ) : (
                        <PrimaryButton
                          accessibilityLabel={`Play ${mode.name} online`}
                          compact
                          disabled={gate.atBoard || Boolean(outgoingChallenge)}
                          label={isConnected ? 'PLAY ▶' : 'CONNECTING'}
                          onPress={() => joinQueue(mode.id)}
                        />
                      )}
                    </View>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      </View>

      <MatchAlertsPanel />

      {setup ? (
        <Panel>
          <SectionHeading
            eyebrow="CUSTOM GAMES"
            title="Set up your own game"
            trailing={
              <Badge
                label={setupChanges === 0 ? 'STANDARD' : `${setupChanges} CHANGED`}
                tone={setupChanges === 0 ? 'neutral' : 'accent'}
              />
            }
          />
          <Text style={styles.help}>
            This is the ordinary game with the knobs exposed. Change nothing and the button
            below just finds you a match; change something and it becomes a game of your own,
            posted to the board or sent to one person.
          </Text>

          <View style={[styles.builder, isWide && styles.builderWide]}>
            <View style={styles.builderControls}>
              <GameSetupEditor
                defaultTimeControl={defaultTimeControl}
                disabled={Boolean(outgoingChallenge)}
                modes={playableModes}
                onChange={setDraft}
                onEditPosition={() => setPositionOpen(true)}
                onResetPosition={() =>
                  setupMode
                    ? setDraft({ ...setup, startingPosition: setupMode.startingPosition })
                    : undefined
                }
                positionIsCustom={hasCustomPosition(setup, setupMode)}
                setup={setup}
              />

              {/*
                Who the game is for is a *property* of it, not a different kind
                of thing — the server takes the same message either way — so it
                is one optional field rather than a second set of buttons.
              */}
              <View style={[styles.opponentField, isWide && styles.opponentFieldWide]}>
                <Text style={styles.groupLabel}>OPPONENT — OPTIONAL</Text>
                <TextInput
                  accessibilityLabel="Username to challenge, or leave blank to open the game to anyone"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!outgoingChallenge}
                  maxLength={40}
                  onChangeText={setChallengeUsername}
                  placeholder="Leave blank for anyone"
                  placeholderTextColor={colors.textFaint}
                  returnKeyType="done"
                  selectionColor={colors.accent}
                  style={[styles.input, Boolean(outgoingChallenge) && styles.disabled]}
                  value={challengeUsername}
                />
              </View>
            </View>

            {/* The thing itself, as everybody else will see it on the board. */}
            <View style={styles.builderPreview}>
              <SetupPreview
                defaultTimeControl={defaultTimeControl}
                mode={setupMode}
                setup={setup}
              />
            </View>
          </View>

          <View style={styles.builderAction}>
            <PrimaryButton
              accessibilityLabel={
                namedOpponent
                  ? `Challenge ${namedOpponent}`
                  : setupIsPlainSearch
                    ? 'Find a match'
                    : 'Post this game to the lobby'
              }
              disabled={gate.atBoard || gate.seekTaken}
              label={
                namedOpponent
                  ? `CHALLENGE ${namedOpponent.toUpperCase()} ▶`
                  : setupIsPlainSearch
                    ? 'FIND A GAME ▶'
                    : 'POST THIS GAME ▶'
              }
              onPress={() => {
                const sent = namedOpponent
                  ? challengePlayer(namedOpponent, setup)
                  : postOpenChallenge(setup);
                if (!sent) return;
                setChallengeUsername('');
                resetDraft();
              }}
            />
            <Text style={styles.actionHint}>
              {namedOpponent
                ? `Only ${namedOpponent} will see it. It waits ten minutes.`
                : setupIsPlainSearch
                  ? 'Nothing is changed, so this is an ordinary rated match: you go straight into matchmaking.'
                  : 'It goes on the open board for ten minutes, and pairs you at once with anybody waiting for the same game.'}
            </Text>
          </View>
        </Panel>
      ) : null}

      <Panel>
        <SectionHeading
          eyebrow="OPEN BOARD"
          title="Games waiting to be taken"
          trailing={
            <Badge
              label={`${otherOpenChallenges.length} OPEN`}
              tone={otherOpenChallenges.length > 0 ? 'live' : 'neutral'}
            />
          }
        />
        {otherOpenChallenges.length === 0 ? (
          <EmptyState
            detail="Press play on a mode above, or set one up, and you will be the row in this list."
            title="Nobody is waiting for a game"
          />
        ) : (
          <View style={styles.list}>
            {/*
              A board on every row. It shows the position the game starts from —
              which for a custom game is the only way to know what you are
              accepting — and, because each mode tints and marks its own board,
              it says which mode that is without spending the line of text the
              terms underneath need.
            */}
            {otherOpenChallenges.map((challenge, index) => {
              const mode = modes.find((candidate) => candidate.id === challenge.setup.modeId);
              const who = playerName(challenge.challenger, 'Someone');
              return (
                <ListRow
                  divided={index > 0}
                  key={challenge.id}
                  leading={
                    <SetupPreview
                      defaultTimeControl={defaultTimeControl}
                      mode={mode}
                      setup={challenge.setup}
                    />
                  }
                  meta={`${challenge.modeName} · ${
                    challenge.queued ? 'in matchmaking' : 'waiting on the board'
                  }${challenge.present ? '' : ' · away, we will call them'}`}
                  style={styles.setupRow}
                  title={who}
                  trailing={
                    <PrimaryButton
                      accessibilityLabel={`Play ${who}: ${setupSummary(
                        challenge.setup,
                        mode,
                        defaultTimeControl,
                      )}`}
                      compact
                      disabled={gate.atBoard}
                      label="PLAY ▶"
                      loading={acceptingChallengeId === challenge.id}
                      onPress={() => acceptChallenge(challenge.id)}
                    />
                  }
                />
              );
            })}
          </View>
        )}
      </Panel>

      <HowToPlayModal
        mode={howToPlayMode}
        onClose={() => setHowToPlayMode(null)}
        visible={Boolean(howToPlayMode)}
      />
      <PositionSetupModal
        initialPosition={setup?.startingPosition ?? null}
        mode={setupMode}
        modes={playableModes}
        onApply={(position) => {
          if (setup) setDraft({ ...setup, startingPosition: position });
          setPositionOpen(false);
        }}
        onClose={() => setPositionOpen(false)}
        title="Custom game setup"
        visible={positionOpen}
      />
      <PGNImportModal
        onClose={() => setPgnOpen(false)}
        onLoad={(pgn) => {
          // Parsed here so a record that cannot be read fails in the modal,
          // where the person can fix the paste, rather than on the next page.
          reviewSourceFromPGN(pgn, modes);
          setPgnOpen(false);
          handReview({ pgn, playerColor: null });
          router.push(links.review());
        }}
        visible={pgnOpen}
      />
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  inbox: { gap: space.snug, marginTop: space.medium },
  inboxRow: {
    paddingHorizontal: space.medium,
    borderRadius: radius.medium,
    backgroundColor: colors.accentSurface,
  },
  inboxActions: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  notice: { ...type.body, color: colors.accentSoft },

  modeGrid: { gap: space.medium, marginTop: space.medium },
  modeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: space.medium,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  modeCardSearching: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceQuiet },
  modeContent: { flex: 1, alignSelf: 'stretch', paddingLeft: space.large },
  modeTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modeBadges: { flexDirection: 'row', alignItems: 'center', gap: space.snug, flexShrink: 1 },
  modeTitle: { ...type.screenTitle, color: colors.textStrong, marginTop: space.small },
  modeObjective: { ...type.body, color: colors.textMuted, marginTop: space.tight },
  howTo: { alignSelf: 'flex-start', marginTop: space.snug, paddingVertical: space.hair },
  howToText: { ...type.label, color: colors.accentSoft, letterSpacing: 0.4 },
  modeFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.small,
    marginTop: 'auto',
    paddingTop: space.medium,
  },
  modeButtons: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', gap: space.small },

  help: { ...type.body, color: colors.textMuted, marginTop: space.small },
  groupLabel: { ...type.eyebrow, color: colors.textFaint, marginBottom: space.tight },

  // Controls on one side, the game they describe on the other. Narrow screens
  // stack them, which puts the preview directly above the button that posts it.
  builder: { gap: space.large, marginTop: space.small },
  builderWide: { flexDirection: 'row', alignItems: 'flex-start' },
  builderControls: { flex: 1, gap: space.medium },
  builderPreview: { alignItems: 'center' },
  builderAction: { gap: space.snug, marginTop: space.large, maxWidth: 420 },
  actionHint: { ...type.meta, color: colors.textFaint },

  // A row carrying a board is taller than one carrying two lines of text, and
  // centring the copy against it reads as two unrelated things side by side.
  setupRow: { alignItems: 'flex-start', paddingVertical: space.small },

  opponentField: { flexGrow: 1, flexBasis: 220 },
  // A username is short. Letting the field run the width of a desktop panel
  // made it look like the main event rather than an optional detail.
  opponentFieldWide: { flexGrow: 0, flexBasis: 260, maxWidth: 260 },
  input: {
    height: 42,
    paddingHorizontal: space.medium,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSunken,
    color: colors.textStrong,
    fontSize: 14,
  },
  list: { marginTop: space.small },

  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
});
