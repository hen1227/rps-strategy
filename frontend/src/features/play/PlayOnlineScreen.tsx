import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Text, TextInput, View, type LayoutChangeEvent } from 'react-native';

import GameSettingsModal from './GameSettingsModal';
import LocalPlayPanel from './LocalPlayPanel';
import { FeaturedModeCard, VariantModeCard } from './ModeCards';
import OpenGamesStrip from './OpenGamesStrip';
import LiveNowPanel from '@/features/live/LiveNowPanel';
import MatchAlertsPanel from '@/features/queue/MatchAlertsPanel';
import HowToPlayModal from '@/features/game/HowToPlayModal';
import SetupPreview, { SETUP_CARD_WIDTH } from '@/features/game/SetupPreview';
import PGNImportModal from '@/features/pgn/PGNImportModal';
import PositionSetupModal from '@/features/pgn/PositionSetupModal';
import OfficialTournamentBanner from '@/features/tournaments/OfficialTournamentBanner';
import TournamentSpotlight from '@/features/tournaments/TournamentSpotlight';
import { reviewSourceFromPGN } from '@/engine/gameReview';
import { useCalloutReserve } from '@/features/shell/CalloutLayer';
import { useWideScreen } from '@/hooks/useBoardLayout';
import { useLobbyGate } from '@/hooks/useQueueCall';
import { links } from '@/navigation/links';
import { useGameStore } from '@/store/gameStore';
import { featuredModeOf, playableModesOf, variantModesOf } from '@/store/modeSelectors';
import { updatePausedReason } from '@/store/queueSelectors';
import { useReviewHandoff } from '@/store/reviewHandoff';
import { hasCustomPosition, isStandardSetup, standardSetup } from '@/store/setupSelectors';
import { colors, contentWidth, radius, space, themedSheet, type } from '@/theme';
import ScreenShell from '@/ui/ScreenShell';
import { GhostButton, Panel, PrimaryButton, SectionHeading } from '@/ui/primitives';
import type { GameSetup, ModeDefinition } from '@/types/game';

// Playing against people.
//
// What used to be the top two thirds of one 1024-line lobby, with the bot
// panels moved to their own section and the live-game table moved to the rail
// that exists to show it. What is left is one question — how do I get into a
// game against a person — and the page answers it in the order somebody asks
// it: the main game and its button, then whoever is already waiting, then the
// variants, then the ways in that need something set up first.
//
// The main game leads because it is the game. Three equal cards said there
// were three equal choices, when two of them are variations on the first; see
// `ModeCards` and `featuredModeOf`. And the waiting games are second because on
// a phone they used to be last, under everything, so nobody knew somebody was
// waiting without scrolling to the bottom to check — see `OpenGamesStrip` for
// why the strip holds its height while games come and go.

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

  // Only what the challenge form and the panels around it need. The mode cards
  // and the open games read their own counts and requests out of the store,
  // so a request arriving or a count moving redraws them rather than this.
  const modes = useGameStore((state) => state.modes);
  const outgoingChallenge = useGameStore((state) => state.outgoingChallenge);
  const challengePlayer = useGameStore((state) => state.challengePlayer);
  const postOpenChallenge = useGameStore((state) => state.postOpenChallenge);
  const gameState = useGameStore((state) => state.gameState);
  // Read for its sentence only. Whether anything is paused at all is the gate's
  // answer below, so the two cannot disagree about it.
  const serverUpdate = useGameStore((state) => state.serverUpdate);
  const defaultTimeControl = useGameStore((state) => state.defaultTimeControl);

  const [howToPlayMode, setHowToPlayMode] = useState<ModeDefinition | null>(null);
  const [challengeUsername, setChallengeUsername] = useState('');
  // Null until somebody touches a knob, so the draft follows the mode catalog
  // as it arrives instead of being pinned to whatever was known at first render.
  const [draft, setDraft] = useState<GameSetup | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [positionOpen, setPositionOpen] = useState(false);
  const [pgnOpen, setPgnOpen] = useState(false);

  // A retired mode keeps its analysis board but accepts no new matches.
  const playableModes = useMemo(() => playableModesOf(modes), [modes]);
  const featuredMode = useMemo(() => featuredModeOf(modes), [modes]);
  const variantModes = useMemo(() => variantModesOf(modes), [modes]);

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

  // A challenge starts out as the main game, which is what most of them are.
  const baseMode = featuredMode;
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

      <SectionHeading
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

      {featuredMode ? (
        <FeaturedModeCard mode={featuredMode} onHowToPlay={setHowToPlayMode} />
      ) : null}

      {/*
        Second on the page, and the same height whether it holds nothing or a
        dozen games: this is where a challenge to you, your own posted game and
        everybody else's now all land, instead of a panel that opened at the top
        of the page and pushed everything down when one arrived.
      */}
      <View style={styles.section}>
        <OpenGamesStrip />
      </View>

      {variantModes.length > 0 ? (
        <View style={styles.section}>
          <View>
            <SectionHeading title="More modes" />
            <Text style={styles.help}>Same pieces, different ways to win.</Text>
          </View>
          <View style={styles.variantGrid}>
            {variantModes.map((mode) => (
              <VariantModeCard key={mode.id} mode={mode} onHowToPlay={setHowToPlayMode} />
            ))}
          </View>
        </View>
      ) : null}

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
                <SectionHeading title="Create a challenge" />
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
                      Casual while you are signed out. Sign in to play for a rating.
                    </Text>
                  ) : null}
                </View>
              </View>
            </View>

            {challengeWide ? setupCard : null}
          </View>
        </Panel>
      ) : null}

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
  // A section break: the page's gap between cards, and as much again, so a
  // heading reads as the start of the next thing rather than a caption on the
  // card above it.
  section: { gap: space.medium, marginTop: space.medium },
  // Side by side where two fit and one to a row where they do not. A row, so
  // the basis is a width — see `VariantModeCard`.
  variantGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.medium },

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

  disabled: { opacity: 0.35 },
}));
