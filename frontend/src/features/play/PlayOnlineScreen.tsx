import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import GameSettingsModal from './GameSettingsModal';
import LocalPlayPanel from './LocalPlayPanel';
import LiveNowPanel from '@/features/live/LiveNowPanel';
import MatchAlertsPanel from '@/features/queue/MatchAlertsPanel';
import HowToPlayModal from '@/features/game/HowToPlayModal';
import ModePreview from '@/features/game/ModePreview';
import SetupPreview, { SETUP_CARD_WIDTH } from '@/features/game/SetupPreview';
import PGNImportModal from '@/features/pgn/PGNImportModal';
import PositionSetupModal from '@/features/pgn/PositionSetupModal';
import OfficialTournamentBanner from '@/features/tournaments/OfficialTournamentBanner';
import TournamentSpotlight from '@/features/tournaments/TournamentSpotlight';
import { reviewSourceFromPGN } from '@/engine/gameReview';
import { engineUnavailableMessage } from '@/engine/rpsfish/client';
import { useCalloutReserve } from '@/features/shell/CalloutLayer';
import { useWideScreen } from '@/hooks/useBoardLayout';
import { useLobbyGate } from '@/hooks/useQueueCall';
import { links } from '@/navigation/links';
import { useGameStore } from '@/store/gameStore';
import { updatePausedReason } from '@/store/queueSelectors';
import { useReviewHandoff } from '@/store/reviewHandoff';
import {
  hasCustomPosition,
  isStandardSetup,
  setupSummary,
  standardSetup,
} from '@/store/setupSelectors';
import { titledName } from '@/store/spectateSelectors';
import { colors, contentWidth, radius, space, themedSheet, type } from '@/theme';
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

/**
 * The narrowest the challenge form is worth reading, and so the floor on its
 * column when the preview card is standing beside it.
 *
 * A phone must not honour it: 300 points of minimum on a 320-point screen is an
 * overflow, and there the form is the whole width anyway.
 */
const CHALLENGE_FORM_FLOOR = 300;

/**
 * How much room the challenge panel needs before the form and the game it
 * describes can stand side by side.
 *
 * The form has a floor and the card has a fixed width, and neither shrinks —
 * `flexShrink` is 0 by default in React Native — so a panel narrower than the
 * two of them together does not squeeze, it overflows. That is how an iPad in
 * landscape ended up drawing the board off the side of the page: the window is
 * wide enough for the two-column lobby, but a 232-point sidebar and a
 * 296-point live rail leave the middle column about 460 points to put 556
 * points of columns in. Measured rather than derived from the window, because
 * the middle column is what is actually at stake and only it knows how wide it
 * has ended up.
 */
const CHALLENGE_TWO_COLUMNS = CHALLENGE_FORM_FLOOR + space.large + SETUP_CARD_WIDTH;

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
  // Read for its sentence only. Whether anything is paused at all is the gate's
  // answer below, so the two cannot disagree about it.
  const serverUpdate = useGameStore((state) => state.serverUpdate);
  const accountId = useGameStore((state) => state.accountId);
  const defaultTimeControl = useGameStore((state) => state.defaultTimeControl);

  const [howToPlayMode, setHowToPlayMode] = useState<ModeDefinition | null>(null);
  const [challengeUsername, setChallengeUsername] = useState('');
  // Null until somebody touches a knob, so the draft follows the mode catalog
  // as it arrives instead of being pinned to whatever was known at first render.
  const [draft, setDraft] = useState<GameSetup | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [positionOpen, setPositionOpen] = useState(false);
  const [pgnOpen, setPgnOpen] = useState(false);

  const isConnected = connectionStatus === 'connected';
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
  const wide = useWideScreen();
  // Room at the foot of the page for the shell's floating card, whichever of
  // the two is up. Asking `useQueueCall` here instead reserved nothing under a
  // tournament call-out — and the tournament is the one that wins the layer.
  const calloutReserve = useCalloutReserve();
  // How wide the challenge panel has turned out, which is not something the
  // window can be asked: the sidebar and the live rail take their width off the
  // front of it. Zero until the first layout, which reads as the single-column
  // shape — the same thing `wide` does on the first client render, and for the
  // same reason.
  const [challengeWidth, setChallengeWidth] = useState(0);
  const measureChallenge = (event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.width);
    setChallengeWidth((current) => (current === measured ? current : measured));
  };
  const challengeWide = wide && challengeWidth >= CHALLENGE_TWO_COLUMNS;
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
  // Who ends up with this game: the one thing about it the preview card cannot
  // read off the setup, and the difference between posting a game and queueing.
  const setupAudience = namedOpponent
    ? `Only ${namedOpponent} can take it.`
    : setupIsPlainSearch
      ? 'Standard settings.'
      : 'Anyone in the lobby can take it.';

  const resetDraft = () => setDraft(null);

  // The game being written out, drawn once and hung in whichever place the
  // width allows: its own column beside the form, or — where there is no
  // beside — straight under the heading, above the fields. Wrapping it to
  // the end of the column instead left it *below the button*, which is the one
  // position that makes a preview useless: the decision it exists to inform has
  // already been taken by the time you scroll to it.
  const setupCard = setup ? (
    <SetupPreview
      caption={setupAudience}
      defaultTimeControl={defaultTimeControl}
      mode={setupMode}
      setup={setup}
      size="feature"
      stretch={!challengeWide}
    />
  ) : null;

  // Somebody else's open games. Your own is already shown as outgoing, and the
  // server would refuse it anyway.
  const otherOpenChallenges = openChallenges.filter(
    (challenge) => challenge.challenger.userId !== accountId,
  );

  return (
    <ScreenShell bottomInset={calloutReserve} width={contentWidth.page}>
      {/*
        Above the site's own tournaments, and above everything else, for the two
        days it is on screen at all: it is about an event that is not here and
        that people would otherwise miss by being here. It takes itself down —
        see OfficialTournamentBanner.
      */}
      <OfficialTournamentBanner />
      <TournamentSpotlight onOpenBoard={() => router.push(links.tournaments())} />

      {incomingChallenges.length > 0 || outgoingChallenge || challengeNotice ? (
        <Panel tone="accent">
          <SectionHeading eyebrow="INVITES" title="Your challenges" />
          <View style={styles.inbox}>
            {incomingChallenges.map((challenge) => {
              const from = titledName(challenge.challenger, 'Another player');
              const accepting = acceptingChallengeId === challenge.id;
              return (
                <ListRow
                  divided={false}
                  key={challenge.id}
                  leading={
                    <SetupPreview
                      defaultTimeControl={defaultTimeControl}
                      mode={modes.find((mode) => mode.id === challenge.setup.modeId)}
                      setup={challenge.setup}
                      size="compact"
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
                      {gate.needsAccount && !challenge.setup.casual ? (
                        <TakeGameButton
                          accessibilityLabel={`Accept the challenge from ${from}`}
                          locked
                          onPlay={() => acceptChallenge(challenge.id)}
                        />
                      ) : (
                        <PrimaryButton
                          accessibilityLabel={`Accept the challenge from ${from}`}
                          compact
                          disabled={gate.atBoard || gate.paused}
                          label="ACCEPT"
                          loading={accepting}
                          onPress={() => acceptChallenge(challenge.id)}
                        />
                      )}
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
                    defaultTimeControl={defaultTimeControl}
                    mode={modes.find((mode) => mode.id === outgoingChallenge.setup.modeId)}
                    setup={outgoingChallenge.setup}
                    size="compact"
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
          title="Play online"
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
            const engineUnavailable = engineUnavailableMessage(mode.id);

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
                      {modeElo !== null ? <Badge label={`RATING ${modeElo}`} tone="accent" /> : null}
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
                  {engineUnavailable ? (
                    <Text style={styles.engineNotice}>{engineUnavailable}</Text>
                  ) : null}
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
                        accessibilityLabel={`Open the ${mode.name} analysis board`}
                        compact
                        disabled={Boolean(engineUnavailable)}
                        label={engineUnavailable ? 'ANALYSIS LOCKED' : 'ANALYZE'}
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
                          accessibilityLabel={
                            gate.needsAccount
                              ? `Play ${mode.name} online, casually`
                              : `Play ${mode.name} online`
                          }
                          compact
                          disabled={gate.atBoard || gate.paused || Boolean(outgoingChallenge)}
                          label={
                            gate.paused
                              ? 'PAUSED'
                              : isConnected
                                ? gate.needsAccount
                                  ? 'PLAY CASUAL ▶'
                                  : 'PLAY ▶'
                                : 'CONNECTING'
                          }
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

      {/*
        What is on, for the screens with no room for the rail beside them. The
        rail is the wide layout's answer to the same question, so a screen that
        has one does not want this as well.
      */}
      {wide ? null : <LiveNowPanel />}

      <MatchAlertsPanel />

      {/*
        Gated on already being at a board, and deliberately *not* on `gate`,
        which reads a disconnected socket as a reason to start nothing. Every
        other way into a game on this page needs the server; this one is the
        answer for when it is down, so the gate that serves them would take it
        away at precisely the moment it is the only thing that still works.
      */}
      <LocalPlayPanel disabled={Boolean(gameState)} modes={playableModes} />

      {setup ? (
        <Panel>
          {/*
            The game itself on the right, at the size a thing you are about to
            put in front of a stranger deserves. Without it this was a form with
            a summary line in it, which reads as a second way to press play —
            and the rows on the open board below are drawn from exactly this
            preview, so seeing it here is seeing what they will see.

            The heading comes inside the row rather than sitting above it, so
            the card runs the full height of the panel instead of hanging off
            the top of a form that is shorter than it is.
          */}
          <View
            onLayout={measureChallenge}
            style={[styles.challengeBody, challengeWide && styles.challengeBodyWide]}
          >
            <View style={[styles.challengeForm, challengeWide && styles.challengeFormWide]}>
              <View>
                <SectionHeading eyebrow="CUSTOM GAMES" title="Create a challenge" />
                <Text style={styles.help}>
                  Enter a username to challenge someone. Leave blank for an open game.
                </Text>
              </View>

              {challengeWide ? null : setupCard}

              <View style={styles.opponentField}>
                <Text style={styles.groupLabel}>OPPONENT (OPTIONAL)</Text>
                <TextInput
                  accessibilityLabel="Username to challenge, or leave blank to open the game to anyone"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!outgoingChallenge}
                  maxLength={40}
                  onChangeText={setChallengeUsername}
                  placeholder="Username or anyone"
                  placeholderTextColor={colors.textFaint}
                  returnKeyType="done"
                  selectionColor={colors.accent}
                  style={[styles.input, Boolean(outgoingChallenge) && styles.disabled]}
                  value={challengeUsername}
                />
              </View>

              <View style={styles.settingsRow}>
                <View style={styles.settingsCopy}>
                  <Text style={styles.groupLabel}>GAME SETUP</Text>
                  <Text style={styles.settingsBlurb}>
                    Choose the mode, clock, side, and rules.
                  </Text>
                </View>
                <GhostButton
                  accessibilityLabel="Adjust game settings"
                  disabled={Boolean(outgoingChallenge)}
                  label="GAME SETTINGS"
                  onPress={() => setSettingsOpen(true)}
                />
              </View>

              {/*
                Pushed to the bottom of its column rather than sitting under the
                last field, so the thing you press and the game you are pressing
                it about finish on the same line.
              */}
              <View style={styles.builderAction}>
                <View style={styles.builderButton}>
                  <PrimaryButton
                    accessibilityLabel={
                      namedOpponent
                        ? `Challenge ${namedOpponent}`
                        : setupIsPlainSearch
                          ? 'Find a match'
                          : 'Post this game to the lobby'
                    }
                    disabled={gate.atBoard || gate.seekTaken || gate.paused}
                    label={
                      gate.paused
                        ? 'PAUSED FOR AN UPDATE'
                        : namedOpponent
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
                      setSettingsOpen(false);
                    }}
                  />
                  {/*
                    What the button does, not who the game is for — the preview's
                    caption has already said that, and saying it twice under two
                    different headings is how a panel stops being read at all.
                  */}
                  <Text style={styles.actionHint}>
                    {gate.paused
                      ? updatePausedReason(serverUpdate?.note)
                      : namedOpponent
                        ? 'It waits ten minutes for them to answer.'
                        : setupIsPlainSearch
                          ? 'Find an opponent.'
                          : "Open for ten minutes. Matching players pair immediately."}
                  </Text>
                  {gate.needsAccount ? (
                    <Text style={styles.actionHint}>
                      Casual while you are signed out. Sign in with Discord to play for a rating.
                    </Text>
                  ) : null}
                </View>
              </View>
            </View>

            {challengeWide ? setupCard : null}
          </View>
        </Panel>
      ) : null}

      <Panel>
        <SectionHeading
          eyebrow="OPEN BOARD"
          title="Open games"
          trailing={
            <Badge
              label={`${otherOpenChallenges.length} OPEN`}
              tone={otherOpenChallenges.length > 0 ? 'live' : 'neutral'}
            />
          }
        />
        {otherOpenChallenges.length === 0 ? (
          <EmptyState
            detail="Choose a mode above to find a game."
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
              const who = titledName(challenge.challenger, 'Someone');
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
                    <TakeGameButton
                      accessibilityLabel={`Play ${who}: ${setupSummary(
                        challenge.setup,
                        mode,
                        defaultTimeControl,
                      )}`}
                      loading={acceptingChallengeId === challenge.id}
                      locked={gate.needsAccount && !challenge.setup.casual}
                      onPlay={() => acceptChallenge(challenge.id)}
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
      {setup ? (
        <GameSettingsModal
          defaultTimeControl={defaultTimeControl}
          disabled={Boolean(outgoingChallenge)}
          mode={setupMode}
          modes={playableModes}
          onChange={setDraft}
          onClose={() => setSettingsOpen(false)}
          onEditPosition={() => {
            setSettingsOpen(false);
            setPositionOpen(true);
          }}
          onReset={resetDraft}
          onResetPosition={() =>
            setupMode
              ? setDraft({ ...setup, startingPosition: setupMode.startingPosition })
              : undefined
          }
          positionIsCustom={hasCustomPosition(setup, setupMode)}
          rankedLocked={gate.needsAccount}
          setup={setup}
          visible={settingsOpen}
        />
      ) : null}
      <PositionSetupModal
        initialPosition={setup?.startingPosition ?? null}
        mode={setupMode}
        modes={playableModes}
        onApply={({ position }) => {
          // Pieces only: `GameSetup` compares whole setups to pair two seeks,
          // so a side to move or a territory it cannot hold is one the other
          // player could never agree to.
          if (setup) setDraft({ ...setup, startingPosition: position });
          setPositionOpen(false);
          setSettingsOpen(true);
        }}
        onClose={() => {
          setPositionOpen(false);
          setSettingsOpen(true);
        }}
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

const styles = themedSheet(() => ({
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
  engineNotice: { ...type.meta, color: colors.accentSoft, marginTop: space.snug },
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

  // The form and the game it describes, side by side. The panel used to run out
  // of things to say a third of the way across the page, which made writing a
  // game out look like a smaller act than pressing PLAY on a mode card.
  // One column or two, chosen rather than wrapped: the order of a wrapped row
  // is the order of the source, and the source order that reads correctly
  // beside the form — form, then game — is the wrong one underneath it. Which
  // of the two is a question about this panel's own width rather than the
  // window's; see `CHALLENGE_TWO_COLUMNS`.
  challengeBody: { gap: space.large },
  challengeBodyWide: { flexDirection: 'row', alignItems: 'stretch' },
  challengeForm: { flex: 1, gap: space.medium },
  // A floor for the form's column, so the preview beside it cannot squeeze the
  // fields down to a stack of labels. Only ever applied where the panel has
  // room for the pair, which is what keeps it from being an overflow of its own.
  challengeFormWide: { minWidth: CHALLENGE_FORM_FLOOR },
  settingsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.medium,
    padding: space.medium,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSunken,
  },
  settingsCopy: { flex: 1, minWidth: 220 },
  settingsBlurb: { ...type.bodyStrong, color: colors.textSoft },
  builderAction: {
    marginTop: 'auto',
    paddingTop: space.medium,
      width: '100%',
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  builderButton: { gap: space.snug },
  actionHint: { ...type.meta, color: colors.textFaint },

  // A row carrying a board is taller than one carrying two lines of text, and
  // centring the copy against it reads as two unrelated things side by side.
  setupRow: { alignItems: 'flex-start', paddingVertical: space.small },

  opponentField: { alignSelf: 'stretch' },
  // A username is short. Letting the field run the width of a desktop panel
  // made it look like the main event rather than an optional detail.
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
}));

/**
 * The button on somebody else's game: play it, or go and get an account.
 *
 * A guest is refused a rated game by the server, because the setup belongs to
 * whoever posted it — silently turning their game casual would change what they
 * advertised. So rather than greying the control out, this offers the thing
 * that would make it work. Casual rows are unaffected and stay playable.
 */
function TakeGameButton({
  accessibilityLabel,
  loading,
  locked,
  onPlay,
}: {
  accessibilityLabel: string;
  loading?: boolean;
  locked: boolean;
  onPlay: () => void;
}) {
  const router = useRouter();
  if (locked) {
    return (
      <PrimaryButton
        accessibilityLabel="Sign in to play ranked games"
        compact
        label="SIGN IN"
        onPress={() => router.push(links.account())}
        tone="quiet"
      />
    );
  }
  return (
    <PrimaryButton
      accessibilityLabel={accessibilityLabel}
      compact
      label="PLAY ▶"
      loading={loading}
      onPress={onPlay}
    />
  );
}
