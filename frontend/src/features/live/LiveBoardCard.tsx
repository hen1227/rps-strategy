import { useMemo, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { liveGameGrid, liveMoveLabel } from './liveSelectors';
import MiniBoard from '@/features/board/MiniBoard';
import { titledName } from '@/store/spectateSelectors';
import { colors, players, radius, space, type } from '@/theme';
import type { ModeDefinition, SideColor } from '@/types/game';
import type { LiveGameSummary } from '@/types/protocol';
import { Badge, PrimaryButton } from '@/ui/primitives';

// One live game, drawn: two names, the position between them, and the way in.
//
// Lifted out of the rail the day the phone stopped hiding this behind a button.
// The lobby now shows the same card at the width a phone actually has, and two
// copies of "what a live board looks like" is how the two of them end up
// disagreeing about it.

/** How much room the card has, and so how large the board inside it is. */
export type LiveBoardSize = 'rail' | 'inset' | 'page';

/** The rail's column is a fixed 296 wide, so its board needs no measuring. */
const RAIL_BOARD = 184;
/** A card nested inside a row of the rail, under the engine it belongs to. */
const INSET_BOARD = 156;
/** A page's card is as wide as the page. These are the ends of reasonable. */
const PAGE_BOARD_MIN = 132;
const PAGE_BOARD_MAX = 280;
/** What a page card draws before its first layout, so it is never board-less. */
const PAGE_BOARD = 220;
/** Wide enough to stand the names and the button beside the board. */
const BANNER_WIDTH = 460;
/** …and the board's share of it, so the column beside it stays readable. */
const BANNER_SHARE = 0.46;
const CARD_PAD = space.small;

const clampBoard = (size: number) =>
  Math.round(Math.max(PAGE_BOARD_MIN, Math.min(PAGE_BOARD_MAX, size)));

/** Whatever is left inside a card of this width once its padding is paid. */
const boardForWidth = (width: number) => clampBoard(width - 2 * CARD_PAD - 2);

/** The same question for a banner, where the copy has to fit alongside it. */
const bannerBoardForWidth = (width: number) => clampBoard(width * BANNER_SHARE);

/** A rating, written after the name it belongs to, in the one way this app writes it. */
export function PlayerElo({ value }: { value: number }) {
  return <Text style={styles.elo}>{value}</Text>;
}

interface PlayerLineProps {
  active: boolean;
  color: SideColor;
  compact?: boolean;
  elo: number;
  name: string;
}

function PlayerLine({ active, color, compact, elo, name }: PlayerLineProps) {
  return (
    <View style={[styles.playerLine, compact && styles.playerLineCompact]}>
      <View style={[styles.playerDot, { backgroundColor: players[color].strong }]} />
      <Text numberOfLines={1} style={styles.playerName}>
        {name} <PlayerElo value={elo} />
      </Text>
      {active ? <Text style={styles.turn}>TO MOVE</Text> : null}
    </View>
  );
}

export interface LiveBoardCardProps {
  /** Already at a board, or not connected: watching is not on offer. */
  busy: boolean;
  game: LiveGameSummary;
  mode: ModeDefinition | null;
  onWatch: (gameId: string) => void;
  size?: LiveBoardSize;
}

export default function LiveBoardCard({
  busy,
  game,
  mode,
  onWatch,
  size = 'rail',
}: LiveBoardCardProps) {
  const page = size === 'page';
  // Measured rather than assumed, for the card whose width is not its own to
  // pick — see `SetupPreview`, which learned this the same way.
  const [cardWidth, setCardWidth] = useState<number | null>(null);
  const measure = (event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    setCardWidth((current) => (current === width ? current : width));
  };
  // Past a certain width a stacked card is a board with a margin of nothing on
  // either side of it. Wide enough, and the names and the button stand beside
  // the board instead — which is the shape that uses the room it was given.
  const banner = page && cardWidth !== null && cardWidth >= BANNER_WIDTH;
  const boardSize = !page
    ? size === 'inset'
      ? INSET_BOARD
      : RAIL_BOARD
    : cardWidth
      ? banner
        ? bannerBoardForWidth(cardWidth)
        : boardForWidth(cardWidth)
      : PAGE_BOARD;

  const openingRows = mode?.startingPosition?.rows;
  const grid = useMemo(() => liveGameGrid(game, openingRows), [game.position, openingRows]);
  const currentTurn = game.currentTurn === 'Blue' ? 'Blue' : 'Red';
  const red = titledName(game.redPlayer, 'Red');
  const blue = titledName(game.bluePlayer, 'Blue');
  const audience = game.spectatorCount
    ? `${game.spectatorCount} ${game.spectatorCount === 1 ? 'person' : 'people'} watching`
    : 'Be first in the room';

  // The pieces, once, so the two arrangements below cannot drift apart.
  const head = (
    <View style={styles.head}>
      <Badge label="LIVE" tone="live" />
      <Text numberOfLines={1} style={styles.mode}>
        {game.series ? `${game.modeName} · BOT SERIES` : game.modeName}
      </Text>
    </View>
  );
  const blueLine = (
    <PlayerLine
      active={currentTurn === 'Blue'}
      color="Blue"
      compact={!page}
      elo={game.blueElo}
      name={blue}
    />
  );
  const redLine = (
    <PlayerLine
      active={currentTurn === 'Red'}
      color="Red"
      compact={!page}
      elo={game.redElo}
      name={red}
    />
  );
  const board = (
    <View style={styles.board}>
      <MiniBoard
        grid={grid}
        modeId={game.modeId}
        size={boardSize}
      />
    </View>
  );
  const facts = (
    <View style={styles.facts}>
      <Text style={styles.fact}>{liveMoveLabel(game.moveNumber)}</Text>
      <Text style={styles.fact}>{audience}</Text>
    </View>
  );
  const watch = (
    <PrimaryButton
      accessibilityLabel={`Watch and chat in ${red} versus ${blue}`}
      compact={!page}
      disabled={busy}
      label="WATCH & CHAT →"
      onPress={() => onWatch(game.gameId)}
    />
  );

  if (banner) {
    return (
      <View onLayout={measure} style={[styles.card, styles.cardPage, styles.cardBanner]}>
        {board}
        <View style={styles.beside}>
          {head}
          <View style={styles.besideMiddle}>
            {blueLine}
            {redLine}
            {facts}
          </View>
          {watch}
        </View>
      </View>
    );
  }

  // Stacked, which is also the order of the board: the player at the top of it
  // is named above, the player at the bottom below.
  return (
    <View
      onLayout={page ? measure : undefined}
      style={[styles.card, page && styles.cardPage, size === 'inset' && styles.cardInset]}
    >
      {head}
      {blueLine}
      {board}
      {redLine}
      {facts}
      {watch}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: space.snug,
    padding: CARD_PAD,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.liveBorder,
    backgroundColor: colors.surfaceWell,
  },
  cardPage: { alignSelf: 'stretch', gap: space.small },
  cardBanner: { flexDirection: 'row', alignItems: 'stretch', gap: space.medium },
  cardInset: { width: '100%', maxWidth: 360, alignSelf: 'center', gap: space.tight },
  // `minWidth: 0` so a long name in the column beside the board ellipsises
  // instead of pushing the board off the card. The three parts then spread
  // over the height of the board rather than floating in the middle of it:
  // the mark at the top, the game in the middle, the way in at the foot.
  beside: { flex: 1, minWidth: 0, gap: space.small, justifyContent: 'space-between' },
  besideMiddle: { gap: space.snug },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.small },
  mode: { ...type.label, color: colors.textMuted, flex: 1, minWidth: 0, textAlign: 'right' },

  playerLine: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.snug,
    paddingHorizontal: space.tight,
  },
  playerLineCompact: { minHeight: 24 },
  playerDot: { width: 8, height: 8, borderRadius: 4 },
  playerName: { ...type.rowTitle, color: colors.text, flex: 1, minWidth: 0 },
  elo: { ...type.meta, color: colors.textFaint, fontWeight: '500' },
  turn: { ...type.eyebrow, color: colors.accentSoft },

  board: { alignItems: 'center' },
  facts: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.small,
    paddingHorizontal: space.tight,
  },
  fact: { ...type.meta, color: colors.textFaint },
});
