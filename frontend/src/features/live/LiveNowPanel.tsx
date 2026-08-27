import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import LiveBoardCard from './LiveBoardCard';
import { allLiveBoards, liveGameGrid, liveGameMeta } from './liveSelectors';
import { useLiveSnapshot } from './useLiveSnapshot';
import MiniBoard from '@/features/board/MiniBoard';
import { modeBackground, modeLooks } from '@/features/board/modeArt';
import { useGameStore } from '@/store/gameStore';
import { titledName } from '@/store/spectateSelectors';
import { colors, space, type } from '@/theme';
import type { ModeDefinition } from '@/types/game';
import type { LiveGameSummary } from '@/types/protocol';
import ListRow from '@/ui/ListRow';
import { GhostButton, Panel, SectionHeading } from '@/ui/primitives';

// The live boards, on a screen with no room for the rail.
//
// This is what the phone used to keep behind a button: one line of counts above
// the tab bar, and a sheet over the whole screen for anybody who pressed it.
// The counts were not the thing — the boards are — and a panel that has to be
// opened before it shows anything is a panel most people never see. So the
// boards come to the page instead, at the size a phone can actually give them,
// under the one heading that says what they are.
//
// Only the boards. Everything else the rail carries is already on this page in
// its own words: the open games are the board below, the tournament is the
// spotlight at the top, and the engines have a section of their own.

/** Beyond this the list is longer than the reason anybody scrolled here. */
const ROWS = 5;

interface WatchRowProps {
  busy: boolean;
  divided: boolean;
  game: LiveGameSummary;
  mode: ModeDefinition | null;
  onWatch: (gameId: string) => void;
}

/** One more live board: small, but still the position rather than a note about it. */
function WatchRow({ busy, divided, game, mode, onWatch }: WatchRowProps) {
  const openingRows = mode?.startingPosition?.rows;
  const grid = useMemo(() => liveGameGrid(game, openingRows), [game.position, openingRows]);
  const red = titledName(game.redPlayer, 'Red');
  const blue = titledName(game.bluePlayer, 'Blue');

  return (
    <ListRow
      divided={divided}
      leading={
        <MiniBoard
          boardBackground={modeBackground(mode)}
          grid={grid}
          modeId={game.modeId}
          pieceLooks={modeLooks(mode)}
          size={68}
        />
      }
      meta={liveGameMeta(game, red, blue)}
      title={
        <Text numberOfLines={1} style={styles.rowTitle}>
          {red} <Text style={styles.dim}>vs</Text> {blue}
        </Text>
      }
      trailing={
        <GhostButton
          accessibilityLabel={`Watch ${red} versus ${blue}`}
          compact
          disabled={busy}
          label="WATCH"
          onPress={() => onWatch(game.gameId)}
        />
      }
    />
  );
}

export default function LiveNowPanel() {
  const snapshot = useLiveSnapshot();
  const spectateGame = useGameStore((state) => state.spectateGame);
  const spectatedGameId = useGameStore((state) => state.spectatedGameId);
  const gameState = useGameStore((state) => state.gameState);
  const connectionStatus = useGameStore((state) => state.connectionStatus);

  // The rail's rule, for the same reason: watching is off the table while you
  // are at a board of your own, and before the socket is up there is nothing to
  // watch with.
  const busy = connectionStatus !== 'connected' || Boolean(gameState) || Boolean(spectatedGameId);
  const boards = allLiveBoards(snapshot);
  const featured = boards[0];
  // Nothing is live: no panel. An empty box under a heading about live games is
  // a worse answer than the silence, and the mode cards above already say how
  // many people are in each queue.
  if (!featured) return null;

  const modeOf = (game: LiveGameSummary) =>
    snapshot.modes.find((mode) => mode.id === game.modeId) ?? null;
  const rest = boards.slice(1, 1 + ROWS);
  const overflow = boards.length - 1 - rest.length;

  return (
    <Panel>
      {/*
        No count badge beside this heading. The title is the count, the card
        below wears the LIVE mark, and the top bar is already saying how many
        people are here — three ways of saying the same number in one screen.
      */}
      <SectionHeading
        eyebrow="RIGHT NOW"
        title={boards.length === 1 ? 'A game is on' : `${boards.length} games are on`}
      />
      <View style={styles.body}>
        <LiveBoardCard
          busy={busy}
          game={featured}
          mode={modeOf(featured)}
          onWatch={spectateGame}
          size="page"
        />
        {rest.map((game, index) => (
          <WatchRow
            busy={busy}
            divided={index > 0}
            game={game}
            key={game.gameId}
            mode={modeOf(game)}
            onWatch={spectateGame}
          />
        ))}
        {overflow > 0 ? (
          <Text style={styles.footnote}>
            …and {overflow} more {overflow === 1 ? 'board' : 'boards'} in play.
          </Text>
        ) : null}
      </View>
    </Panel>
  );
}

const styles = StyleSheet.create({
  body: { marginTop: space.medium, gap: space.small },
  rowTitle: { ...type.rowTitle, color: colors.text },
  dim: { color: colors.textFaint, fontSize: 10, fontWeight: '600' },
  footnote: { ...type.meta, color: colors.textFaint, marginTop: space.tight },
});
