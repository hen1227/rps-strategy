import { useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import LiveBoardCard from './LiveBoardCard';
import { ladderConditionsLine, type LadderRoundView } from './ladderRound';
import { liveGameMeta, waitingCount, type EngineSeat, type LiveSnapshot } from './liveSelectors';
import { useLadderRound } from './useLadderRound';
import { useLiveSnapshot } from './useLiveSnapshot';
import BotIcon from '@/features/bots/BotIcon';
import { links } from '@/navigation/links';
import { botIconUrl } from '@/store/api/bots';
import { useWatchGame } from '@/hooks/useWatchGame';
import { useGameStore } from '@/store/gameStore';
import { playerName, titledName } from '@/store/spectateSelectors';
import { colors, radius, shadows, space, themedSheet, type } from '@/theme';
import type { LiveGameSummary } from '@/types/protocol';
import { Badge, GhostButton, GhostLink, PrimaryButton } from '@/ui/primitives';
import PlayerLink from '@/ui/PlayerLink';
import TitleTag from '@/ui/TitleTag';

// What is happening right now.
//
// Deliberately hierarchical. This is the thing somebody glances at, not a page
// they read: the game worth watching gets a real board, alternatives stay one
// row each, and everything else becomes compact supporting activity.

interface BlockProps {
  title: string;
  count?: number;
  /** Something to do with the whole block, sitting at the end of its heading. */
  action?: ReactNode;
  children?: ReactNode;
}

function Block({ title, count, action, children }: BlockProps) {
  return (
    <View style={styles.block}>
      <View style={styles.blockHead}>
        <Text style={styles.blockTitle}>{title}</Text>
        {count !== undefined && count > 0 ? <Badge label={String(count)} tone="live" /> : null}
        {action}
      </View>
      {children}
    </View>
  );
}

/**
 * An engine seat the rail will draw, which is one at a board.
 *
 * Narrowed rather than checked twice: the rail only lists engines that are
 * playing, so the board is there and the row does not have to carry a shape for
 * a case it is never handed.
 */
type PlayingEngine = EngineSeat & { game: LiveGameSummary };

const isPlaying = (seat: EngineSeat): seat is PlayingEngine => Boolean(seat.game);

interface EngineLineProps {
  busy: boolean;
  onWatch: (gameId: string) => void;
  seat: PlayingEngine;
}

/**
 * One engine at a board, and the board it is on.
 *
 * A playing engine gets the same card a playing person gets, rather than a line
 * of text about it — an engine game is the thing most often worth watching here
 * at three in the morning, and it was previously reduced to a number.
 */
function EngineLine({ busy, onWatch, seat }: EngineLineProps) {
  const { bot, game, ratings, status } = seat;

  return (
    <View style={styles.engine}>
      <View style={styles.row}>
        <BotIcon name={bot.name} size={28} uri={botIconUrl(bot.botId, bot.iconSha256)} />
        <View style={styles.rowCopy}>
          <Text numberOfLines={1} style={styles.rowTitle}>
            {bot.name}
          </Text>
          <View style={styles.engineMeta}>
            <Text style={styles.engineMetaText}>vs</Text>
            <TitleTag title={seat.opponentTitle} />
            <Text numberOfLines={1} style={styles.engineOpponent}>
              {seat.opponentName}
            </Text>
            <Text numberOfLines={1} style={styles.engineMetaText}>
              · {game.modeName}
            </Text>
          </View>
          {/*
            One number, and the mode of this board rather than every mode the
            engine plays: a rating is only worth reading against the game it is
            being earned in. See `EngineSeat.ratings`.
          */}
          {ratings.length > 0 ? (
            <Text numberOfLines={1} style={styles.ratings}>
              {ratings.map((rating, index) => (
                <Text key={rating.modeId}>
                  {index > 0 ? ' · ' : ''}
                  {rating.shortCode} <Text style={styles.ratingValue}>{rating.elo}</Text>
                </Text>
              ))}
            </Text>
          ) : null}
        </View>
        <Badge label={status.label} tone={status.tone} />
      </View>
      {seat.showsBoard ? (
        <LiveBoardCard busy={busy} game={game} mode={seat.mode} onWatch={onWatch} size="inset" />
      ) : null}
    </View>
  );
}

/**
 * The next ranked round: when it is, and the way in.
 *
 * The pool is the only thing that moves an engine's rating, and this is the
 * appointment — a countdown and the conditions, so that somebody with an engine
 * knows to have it online at the top of the hour and somebody without one knows
 * there is something to watch.
 *
 * It used to list the lineup here too, six rows of it, and that was the wrong
 * place for it twice over. A rail 296 points wide could not say *why* an engine
 * was or was not in the list, so the one question an owner actually has — "is
 * mine in the next one" — got a partial answer that read as a complete one: an
 * engine that was entered but not running was simply absent, indistinguishable
 * from one that was never entered. And the count above it said "7 engines
 * entered" using a different definition of entered from the switch in the
 * owner's own settings. All of that now has a page, and what is left here is
 * the clock and the door to it.
 */
function LadderRoundBlock({ round }: { round: LadderRoundView }) {
  const live = round.phase === 'live';

  return (
    // The badge belongs on the heading rather than beside the clock, and the
    // reason is that they say opposite things about time. A round takes a good
    // part of its hour at the slower clocks, so hiding the countdown while one
    // runs would hide the next start for a third of every hour — but "41:52"
    // next to "ON NOW" reads as a round *ending* in 41:52. Up here the badge is
    // about the block, the clock underneath is unambiguously the next one, and
    // "Next:" on the conditions closes the last of it.
    <Block action={live ? <Badge label="ON NOW" tone="live" /> : undefined} title="Ranked round">
      <View style={styles.roundHead}>
        <Text style={styles.roundClock}>{round.countdown}</Text>
        <Text numberOfLines={1} style={styles.roundConditions}>
          {live ? `Next: ${ladderConditionsLine(round)}` : ladderConditionsLine(round)}
        </Text>
      </View>
      <GhostLink
        accessibilityLabel="Open the hourly rounds: who is entered, and the last round's results"
        compact
        href={links.rounds()}
        label="HOURLY ROUNDS ›"
      />
    </Block>
  );
}

export default function LiveRail() {
  const router = useRouter();
  const snapshot = useLiveSnapshot();
  const watchGame = useWatchGame();
  const spectatedGameId = useGameStore((state) => state.spectatedGameId);
  const acceptChallenge = useGameStore((state) => state.acceptChallenge);
  const cancelChallenge = useGameStore((state) => state.cancelChallenge);
  const gameState = useGameStore((state) => state.gameState);
  const connectionStatus = useGameStore((state) => state.connectionStatus);

  // Deliberately not `queue.isSearching`. Being in the queue is now a
  // background activity that can run for ten minutes across every screen, and
  // watching a game or taking somebody's open row is not in conflict with it —
  // the server drops your seek the moment either one seats you.
  const busy =
    connectionStatus !== 'connected' || Boolean(gameState) || Boolean(spectatedGameId);
  const waiting = waitingCount(snapshot);
  // Already ranked, and already missing whatever the engine rows below draw for
  // themselves — so a bot series is one board in this rail, not two.
  const liveGames = snapshot.watchable;
  const featuredGame = liveGames[0] ?? null;
  const otherLiveGames = liveGames.slice(1, 5);
  // Honest about the difference now that a search survives a closed tab. "3
  // waiting" when two of them are asleep is a number that gets somebody's hopes
  // up and then spends thirty seconds of their evening.
  const waitingTitle = (current: LiveSnapshot) => {
    const here = current.waiting.filter((seat) => seat.challenge.present).length;
    if (here === current.waiting.length) return 'Looking for a game';
    if (here === 0) return 'Waiting, away from the keyboard';
    return `Looking for a game · ${here} here now`;
  };
  const engineCount = snapshot.engines.length;
  // The engines at a board, and only those.
  //
  // This block used to be the whole roster, which on a quiet evening is a dozen
  // rows of a name, an engine and a line of ratings — a directory, in the panel
  // whose entire job is what is happening *now*, and it pushed the games worth
  // watching off the bottom of a column 296 points wide. The directory has a
  // page of its own, and it is a better one: `/bots` lists every engine online
  // with a button to play it. What belongs here is the boards.
  //
  // The count in the header stays, because how many engines are connected is
  // still worth a glance even when none of them is playing — it is the one part
  // of the roster that reads as news rather than as a list.
  const playingEngines = snapshot.engines.filter(isPlaying);
  // Absent on the pre-rendered page and until the schedule arrives. See
  // useLadderRound.
  const round = useLadderRound();
  const nothingHappening =
    snapshot.playerGames.length === 0 &&
    snapshot.botFights.length === 0 &&
    waiting === 0 &&
    snapshot.botPlayerCount === 0 &&
    !snapshot.activeTournament &&
    !round;

  return (
    <View style={styles.rail}>
      <View style={styles.header}>
        <Text style={styles.railTitle}>Right now</Text>
        <View style={styles.presence}>
          <View style={styles.presenceLine}>
            <View style={styles.presenceDot} />
            <Text style={styles.online}>{snapshot.onlineCount} here</Text>
          </View>
          {engineCount > 0 ? (
            <Text style={styles.enginesOnline}>
              {engineCount} {engineCount === 1 ? 'engine' : 'engines'} online
            </Text>
          ) : null}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
        style={styles.scroll}
      >
        {nothingHappening ? (
          <Text style={styles.quiet}>
            No live games. Watch and chat here when one starts.
          </Text>
        ) : null}

        {/*
          Above the boards, and it is the one thing in this rail that earns that.
          Everything below is what is happening; this is the only part that says
          what is about to, and a countdown found by scrolling is a countdown
          nobody sets their evening by.
        */}
        {round ? <LadderRoundBlock round={round} /> : null}

        {featuredGame ? (
          <Block count={liveGames.length} title="Watch live">
            <LiveBoardCard
              busy={busy}
              game={featuredGame}
              mode={snapshot.modes.find((mode) => mode.id === featuredGame.modeId) ?? null}
              onWatch={watchGame}
            />
            {otherLiveGames.length > 0 ? (
              <View style={styles.moreLive}>
                <Text style={styles.moreLiveTitle}>MORE LIVE BOARDS</Text>
                {otherLiveGames.map((game) => {
                  const redName = playerName(game.redPlayer, 'Red');
                  const blueName = playerName(game.bluePlayer, 'Blue');
                  const red = titledName(game.redPlayer, 'Red');
                  const blue = titledName(game.bluePlayer, 'Blue');
                  return (
                    <View key={game.gameId} style={styles.row}>
                      <View style={styles.rowCopy}>
                        <View style={styles.rowNames}>
                          <TitleTag title={game.redPlayer?.title} />
                          <PlayerLink
                            handle={game.redPlayer?.username ?? ''}
                            name={redName}
                            numberOfLines={1}
                            style={styles.rowName}
                          />
                          <Text style={styles.dim}>vs</Text>
                          <TitleTag title={game.bluePlayer?.title} />
                          <PlayerLink
                            handle={game.bluePlayer?.username ?? ''}
                            name={blueName}
                            numberOfLines={1}
                            style={styles.rowName}
                          />
                        </View>
                        <Text numberOfLines={1} style={styles.rowMeta}>
                          {liveGameMeta(game, red, blue)}
                        </Text>
                      </View>
                      <GhostButton
                        accessibilityLabel={`Watch ${red} versus ${blue}`}
                        compact
                        disabled={busy}
                        label="WATCH"
                        onPress={() => watchGame(game.gameId)}
                      />
                    </View>
                  );
                })}
              </View>
            ) : null}
          </Block>
        ) : null}

        {snapshot.activeTournament ? (
          <Block title="Tournament on">
            <Pressable
              accessibilityLabel={`Open ${snapshot.activeTournament.name}`}
              accessibilityRole="button"
              onPress={() => router.push(links.tournaments())}
              style={({ pressed }) => [styles.tournament, pressed && styles.pressed]}
            >
              <Text numberOfLines={1} style={styles.rowTitle}>
                {snapshot.activeTournament.name}
              </Text>
              <Text style={styles.rowMeta}>
                {snapshot.activeTournament.status === 'registration'
                  ? `Signups open · ${snapshot.activeTournament.players?.length ?? 0} entered`
                  : `${snapshot.activeTournament.modeName} · ${snapshot.activeTournament.players?.length ?? 0} players`}
              </Text>
            </Pressable>
          </Block>
        ) : null}

        {waiting > 0 ? (
          <Block count={waiting} title={waitingTitle(snapshot)}>
            {snapshot.waiting.slice(0, 4).map((seat) => (
              <View key={seat.key} style={styles.row}>
                <View style={styles.rowCopy}>
                  <Text numberOfLines={1} style={styles.rowTitle}>
                    {seat.label}
                  </Text>
                  <Text numberOfLines={1} style={styles.rowMeta}>
                    {seat.mine
                      ? 'Yours'
                      : !seat.challenge.present
                        ? 'Away · we will call them'
                        : seat.challenge.queued
                          ? 'Searching'
                          : 'Open game'}
                    {' · '}
                    {seat.challenge.modeName}
                  </Text>
                </View>
                {seat.mine ? (
                  <GhostButton
                    accessibilityLabel="Stop waiting for a game"
                    compact
                    label="CANCEL"
                    onPress={() => cancelChallenge(seat.challenge.id)}
                  />
                ) : (
                  <PrimaryButton
                    accessibilityLabel={`Play ${seat.challenge.challenger.username || 'this player'}`}
                    compact
                    disabled={busy}
                    label="PLAY"
                    onPress={() => acceptChallenge(seat.challenge.id)}
                  />
                )}
              </View>
            ))}
          </Block>
        ) : null}

        {playingEngines.length > 0 ? (
          <View style={styles.engines}>
            {/*
              The engines are their own half of the room. The rule says so
              without a second heading: people above it, machines below — and
              only when there is something above it to be divided from.
            */}
            {featuredGame || snapshot.activeTournament || waiting > 0 ? (
              <View style={styles.divider} />
            ) : null}
            <Block title="Engines playing">
              {playingEngines.map((seat) => (
                <EngineLine busy={busy} key={seat.key} onWatch={watchGame} seat={seat} />
              ))}
            </Block>
          </View>
        ) : null}

        {snapshot.botPlayerCount > 0 ? (
          <Text style={styles.footnote}>
            {snapshot.botPlayerCount}{' '}
            {snapshot.botPlayerCount === 1 ? 'person is' : 'people are'} practising against a bot.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

export const RAIL_WIDTH = 296;

const styles = themedSheet(() => ({
  rail: {
    width: RAIL_WIDTH,
    alignSelf: 'stretch',
    margin: space.medium,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    // Raised rather than inset: this panel is about now, and should read as
    // sitting over the page rather than as part of it.
    boxShadow: shadows.rail,
  },
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.medium,
    padding: space.medium,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  railTitle: { ...type.sectionTitle, color: colors.textStrong },
  presence: { alignItems: 'flex-end', gap: space.hair },
  presenceLine: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  presenceDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  online: { ...type.meta, color: colors.textMuted, fontWeight: '800' },
  enginesOnline: { ...type.meta, color: colors.textFaint },
  scroll: { flex: 1 },
  body: { padding: space.medium, gap: space.large },
  quiet: { ...type.body, color: colors.textFaint },

  block: { gap: space.snug },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  blockTitle: { ...type.eyebrow, color: colors.textMuted, flex: 1 },

  moreLive: { marginTop: space.tight },
  moreLiveTitle: { ...type.eyebrow, color: colors.textFaint, marginBottom: space.tight },

  roundHead: { flexDirection: 'row', alignItems: 'center', gap: space.snug, minWidth: 0 },
  // Tabular figures so a ticking countdown does not shuffle the line beside it
  // every second as the digits change width.
  roundClock: {
    ...type.sectionTitle,
    color: colors.textStrong,
    fontVariant: ['tabular-nums'],
  },
  roundConditions: { ...type.meta, color: colors.textMuted, flexShrink: 1, minWidth: 0 },

  row: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    paddingVertical: space.snug,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  // `minWidth: 0` so a long name ellipsises inside the row instead of pushing
  // the badge and the button off the end of it.
  rowCopy: { flex: 1, minWidth: 0, gap: space.tight, alignItems: 'flex-start' },
  rowTitle: { ...type.rowTitle, color: colors.text },
  rowNames: { flexDirection: 'row', alignItems: 'center', gap: space.tight, minWidth: 0 },
  rowName: { ...type.rowTitle, color: colors.text, flexShrink: 1 },
  rowMeta: { ...type.meta, color: colors.textFaint, marginTop: space.hair },
  engineMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.tight,
    minWidth: 0,
    marginTop: space.hair,
  },
  engineMetaText: { ...type.meta, color: colors.textFaint },
  engineOpponent: { ...type.meta, color: colors.textFaint, flexShrink: 1 },
  // The mode code stays faint and the number does not: the rating is what is
  // being read here, and the code is only what it belongs to.
  ratings: { ...type.meta, color: colors.textFaint },
  ratingValue: { color: colors.textMuted, fontWeight: '700' },
  dim: { color: colors.textFaint, fontSize: 10, fontWeight: '600' },
  tournament: {
    paddingVertical: space.small,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  engines: { gap: space.medium },
  engine: { gap: space.snug },
  divider: { height: 1, backgroundColor: colors.border },
  footnote: { ...type.meta, color: colors.textFaint },
  pressed: { opacity: 0.7 },
}));
