import { useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import LiveBoardCard from './LiveBoardCard';
import { liveGameMeta, waitingCount, type EngineSeat, type LiveSnapshot } from './liveSelectors';
import { useLiveSnapshot } from './useLiveSnapshot';
import BotIcon from '@/features/bots/BotIcon';
import { links } from '@/navigation/links';
import { botIconUrl } from '@/store/api/bots';
import { useGameStore } from '@/store/gameStore';
import { titledName } from '@/store/spectateSelectors';
import { colors, radius, space, type } from '@/theme';
import { Badge, GhostButton, PrimaryButton } from '@/ui/primitives';

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

interface EngineLineProps {
  busy: boolean;
  onWatch: (gameId: string) => void;
  seat: EngineSeat;
}

/**
 * One connected engine, and the board it is on.
 *
 * A playing engine gets the same card a playing person gets, rather than a line
 * of text about it — an engine game is the thing most often worth watching here
 * at three in the morning, and it was previously reduced to a number.
 */
function EngineLine({ busy, onWatch, seat }: EngineLineProps) {
  const { bot, game, ratings, status } = seat;
  // The modes it plays are no longer worth spelling out here: the ratings line
  // below names every one of them, and with a number against each.
  const meta = game ? `vs ${seat.opponent} · ${game.modeName}` : bot.engineName || 'engine';

  return (
    <View style={styles.engine}>
      <View style={styles.row}>
        <BotIcon name={bot.name} size={28} uri={botIconUrl(bot.botId, bot.iconSha256)} />
        <View style={styles.rowCopy}>
          <Text numberOfLines={1} style={styles.rowTitle}>
            {bot.name}
          </Text>
          <Text numberOfLines={1} style={styles.rowMeta}>
            {meta}
          </Text>
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
      {game && seat.showsBoard ? (
        <LiveBoardCard busy={busy} game={game} mode={seat.mode} onWatch={onWatch} size="inset" />
      ) : null}
    </View>
  );
}

export default function LiveRail() {
  const router = useRouter();
  const snapshot = useLiveSnapshot();
  const spectateGame = useGameStore((state) => state.spectateGame);
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
  const nothingHappening =
    snapshot.playerGames.length === 0 &&
    snapshot.botFights.length === 0 &&
    waiting === 0 &&
    engineCount === 0 &&
    snapshot.botPlayerCount === 0 &&
    !snapshot.activeTournament;

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
            No live boards yet. When a game starts, you can watch it and join the chat here.
          </Text>
        ) : null}

        {featuredGame ? (
          <Block count={liveGames.length} title="Watch live">
            <LiveBoardCard
              busy={busy}
              game={featuredGame}
              mode={snapshot.modes.find((mode) => mode.id === featuredGame.modeId) ?? null}
              onWatch={spectateGame}
            />
            {otherLiveGames.length > 0 ? (
              <View style={styles.moreLive}>
                <Text style={styles.moreLiveTitle}>MORE LIVE BOARDS</Text>
                {otherLiveGames.map((game) => {
                  const red = titledName(game.redPlayer, 'Red');
                  const blue = titledName(game.bluePlayer, 'Blue');
                  return (
                    <View key={game.gameId} style={styles.row}>
                      <View style={styles.rowCopy}>
                        <Text numberOfLines={1} style={styles.rowTitle}>
                          {red} <Text style={styles.dim}>vs</Text> {blue}
                        </Text>
                        <Text numberOfLines={1} style={styles.rowMeta}>
                          {liveGameMeta(game, red, blue)}
                        </Text>
                      </View>
                      <GhostButton
                        accessibilityLabel={`Watch ${red} versus ${blue}`}
                        compact
                        disabled={busy}
                        label="WATCH"
                        onPress={() => spectateGame(game.gameId)}
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

        {engineCount > 0 ? (
          <View style={styles.engines}>
            {/*
              The engines are their own half of the room. The rule says so
              without a second heading: people above it, machines below — and
              only when there is something above it to be divided from.
            */}
            {featuredGame || snapshot.activeTournament || waiting > 0 ? (
              <View style={styles.divider} />
            ) : null}
            <Block
              action={
                <GhostButton
                  accessibilityLabel="Browse every engine"
                  compact
                  label="BROWSE"
                  onPress={() => router.push(links.bots())}
                />
              }
              title="Engines"
            >
              {snapshot.engines.map((seat) => (
                <EngineLine busy={busy} key={seat.key} onWatch={spectateGame} seat={seat} />
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

const styles = StyleSheet.create({
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
    boxShadow: [{ offsetX: 0, offsetY: 6, blurRadius: 14, color: 'rgba(23, 22, 19, 0.34)' }],
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
  rowMeta: { ...type.meta, color: colors.textFaint, marginTop: space.hair },
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
});
