import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { liveSnapshot, waitingCount, type LiveSnapshot } from './liveSelectors';
import BotIcon from '@/features/bots/BotIcon';
import SetupPreview from '@/features/game/SetupPreview';
import { links } from '@/navigation/links';
import { useGameStore } from '@/store/gameStore';
import { playerName, seriesProgressLabel, seriesScoreLabel, seriesScoreOf } from '@/store/spectateSelectors';
import { colors, radius, space, type } from '@/theme';
import { Badge, GhostButton, PrimaryButton } from '@/ui/primitives';

// What is happening right now.
//
// Deliberately short. This is the thing somebody glances at, not a page they
// read: every block is at most a few rows, each row leads with a name, and
// every row that could be joined or watched carries the button that does it.
// Anything that wants explaining belongs in a section instead.

/** Read the whole snapshot from the store. One hook, so the rail cannot drift. */
export const useLiveSnapshot = (): LiveSnapshot => {
  const accountId = useGameStore((state) => state.accountId);
  const onlineCount = useGameStore((state) => state.onlineCount);
  const liveGames = useGameStore((state) => state.liveGames);
  const botPlayerCount = useGameStore((state) => state.botPlayerCount);
  const engineBots = useGameStore((state) => state.engineBots);
  const openChallenges = useGameStore((state) => state.openChallenges);
  const tournaments = useGameStore((state) => state.tournaments);
  const modes = useGameStore((state) => state.modes);
  return liveSnapshot({
    accountId,
    onlineCount,
    liveGames,
    botPlayerCount,
    engineBots,
    openChallenges,
    tournaments,
    modes,
  });
};

interface BlockProps {
  title: string;
  count?: number;
  children?: ReactNode;
}

function Block({ title, count, children }: BlockProps) {
  return (
    <View style={styles.block}>
      <View style={styles.blockHead}>
        <Text style={styles.blockTitle}>{title}</Text>
        {count !== undefined && count > 0 ? <Badge label={String(count)} tone="live" /> : null}
      </View>
      {children}
    </View>
  );
}

export interface LiveRailProps {
  /** Rendered inside a sheet on a phone, where it has the full width. */
  embedded?: boolean;
}

export default function LiveRail({ embedded }: LiveRailProps) {
  const router = useRouter();
  const snapshot = useLiveSnapshot();
  const spectateGame = useGameStore((state) => state.spectateGame);
  const spectatedGameId = useGameStore((state) => state.spectatedGameId);
  const acceptChallenge = useGameStore((state) => state.acceptChallenge);
  const cancelChallenge = useGameStore((state) => state.cancelChallenge);
  const defaultTimeControl = useGameStore((state) => state.defaultTimeControl);
  const gameState = useGameStore((state) => state.gameState);
  const connectionStatus = useGameStore((state) => state.connectionStatus);

  // Deliberately not `queue.isSearching`. Being in the queue is now a
  // background activity that can run for ten minutes across every screen, and
  // watching a game or taking somebody's open row is not in conflict with it —
  // the server drops your seek the moment either one seats you.
  const busy =
    connectionStatus !== 'connected' || Boolean(gameState) || Boolean(spectatedGameId);
  const waiting = waitingCount(snapshot);
  // Honest about the difference now that a search survives a closed tab. "3
  // waiting" when two of them are asleep is a number that gets somebody's hopes
  // up and then spends thirty seconds of their evening.
  const waitingTitle = (current: LiveSnapshot) => {
    const here = current.waiting.filter((seat) => seat.challenge.present).length;
    if (here === current.waiting.length) return 'Looking for a game';
    if (here === 0) return 'Waiting, away from the keyboard';
    return `Looking for a game · ${here} here now`;
  };
  const nothingHappening =
    snapshot.playerGames.length === 0 &&
    snapshot.botFights.length === 0 &&
    waiting === 0 &&
    snapshot.botPlayerCount === 0 &&
    !snapshot.activeTournament;

  return (
    <View style={[styles.rail, embedded && styles.railEmbedded]}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>RIGHT NOW</Text>
        <Text style={styles.online}>
          {snapshot.onlineCount} {snapshot.onlineCount === 1 ? 'person here' : 'people here'}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
        style={styles.scroll}
      >
        {nothingHappening ? (
          <Text style={styles.quiet}>
            Nobody is playing yet. Start a game and you will be the thing in this panel.
          </Text>
        ) : null}

        {snapshot.activeTournament ? (
          <Block title="Tournament">
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
            {/*
              A board on every row, because every row is now a *particular*
              game: the thumbnail shows the position it starts from and, by the
              way each mode tints its own board, which mode that is. The marks
              under it are the rest of the terms.
            */}
            {snapshot.waiting.slice(0, 4).map((seat) => (
              <View key={seat.key} style={styles.waitingRow}>
                <SetupPreview
                  compact
                  defaultTimeControl={defaultTimeControl}
                  mode={seat.mode}
                  setup={seat.challenge.setup}
                />
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
                      label="PLAY ▶"
                      onPress={() => acceptChallenge(seat.challenge.id)}
                    />
                  )}
                </View>
              </View>
            ))}
          </Block>
        ) : null}

        {snapshot.playerGames.length > 0 ? (
          <Block count={snapshot.playerGames.length} title="Live games">
            {snapshot.playerGames.slice(0, 5).map((game) => {
              const red = playerName(game.redPlayer, 'Red');
              const blue = playerName(game.bluePlayer, 'Blue');
              return (
                <View key={game.gameId} style={styles.row}>
                  <View style={styles.rowCopy}>
                    <Text numberOfLines={1} style={styles.rowTitle}>
                      {red} <Text style={styles.dim}>vs</Text> {blue}
                    </Text>
                    <Text style={styles.rowMeta}>
                      {game.modeName}
                      {game.spectatorCount ? ` · ${game.spectatorCount} watching` : ''}
                    </Text>
                  </View>
                  <GhostButton
                    accessibilityLabel={`Watch ${red} versus ${blue}`}
                    compact
                    disabled={busy}
                    label="◉"
                    onPress={() => spectateGame(game.gameId)}
                  />
                </View>
              );
            })}
          </Block>
        ) : null}

        {snapshot.botFights.length > 0 ? (
          <Block count={snapshot.botFights.length} title="Bot fights">
            {snapshot.botFights.slice(0, 4).map((game) => {
              const red = playerName(game.redPlayer, 'Red');
              const blue = playerName(game.bluePlayer, 'Blue');
              const series = game.series;
              return (
                <View key={game.gameId} style={styles.row}>
                  <View style={styles.rowCopy}>
                    <Text numberOfLines={1} style={styles.rowTitle}>
                      {red} <Text style={styles.dim}>vs</Text> {blue}
                    </Text>
                    <Text numberOfLines={1} style={styles.rowMeta}>
                      {series
                        ? `${seriesProgressLabel(series)} · ${seriesScoreLabel(seriesScoreOf(series, red, blue))}`
                        : game.modeName}
                    </Text>
                  </View>
                  <GhostButton
                    accessibilityLabel={`Watch ${red} versus ${blue}`}
                    compact
                    disabled={busy}
                    label="◉"
                    onPress={() => spectateGame(game.gameId)}
                  />
                </View>
              );
            })}
          </Block>
        ) : null}

        {snapshot.connectedBots.length > 0 ? (
          <Block count={snapshot.connectedBots.length} title="Engines online">
            {snapshot.connectedBots.slice(0, 4).map((bot) => (
              <View key={bot.botId} style={styles.row}>
                <BotIcon name={bot.name} size={26} />
                <View style={styles.rowCopy}>
                  <Text numberOfLines={1} style={styles.rowTitle}>
                    {bot.name} <Text style={styles.dim}>({bot.elo})</Text>
                  </Text>
                  <Text style={styles.rowMeta}>{bot.busy ? 'Playing' : 'Idle'}</Text>
                </View>
              </View>
            ))}
            <GhostButton
              compact
              label="ALL BOTS"
              onPress={() => router.push(links.bots())}
            />
          </Block>
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
  railEmbedded: { width: '100%', margin: 0, borderWidth: 0, boxShadow: undefined },
  header: {
    gap: space.hair,
    padding: space.medium,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  eyebrow: { ...type.eyebrow, color: colors.live },
  online: { ...type.cardTitle, color: colors.textStrong },
  scroll: { flex: 1 },
  body: { padding: space.medium, gap: space.large },
  quiet: { ...type.body, color: colors.textFaint },

  block: { gap: space.tight },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  blockTitle: { ...type.eyebrow, color: colors.textMuted, flex: 1 },

  row: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  // Taller than the other rows and top-aligned: it carries a board, and a
  // board next to vertically centred text reads as two unrelated things.
  waitingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.small,
    paddingVertical: space.snug,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  rowCopy: { flex: 1, gap: space.tight, alignItems: 'flex-start' },
  rowTitle: { ...type.rowTitle, color: colors.text },
  rowMeta: { ...type.meta, color: colors.textFaint, marginTop: space.hair },
  dim: { color: colors.textFaint, fontSize: 10, fontWeight: '600' },
  tournament: {
    paddingVertical: space.small,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  footnote: { ...type.meta, color: colors.textFaint },
  pressed: { opacity: 0.7 },
});
