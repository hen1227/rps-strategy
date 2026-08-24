import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import BotIcon from './BotIcon';
import { seriesView, type SeriesGameView } from './seriesSummary';
import { botIconUrl, type BotSeries } from '@/store/api/bots';
import { colors, radius, space, type } from '@/theme';

// A run's games, as the score table a match between two engines actually is.
//
// This was a row of W/L/D chips, and it did not work. A letter is only readable
// against a side, the side was written once above the row, and the seats swap
// every game — so `W L W W` asked the reader to hold "W means the left one" in
// their head and apply it six times against the instinct to read it off the
// board. Whose W it was is exactly the thing the strip existed to say.
//
// A table says it by construction. Each bot owns a row, each game owns a
// column, and a point sits under the game in the winner's row: one, nothing, or
// half each. Nobody has to be told which side they are looking at, and the two
// totals at the end are the run's score without anybody having to count.
//
// The same table in three places — inside the card on the Bots and Leaderboard
// pages, and over the board on the review and spectate screens — because a run
// is one thing that happened, and where you reached it from should not change
// what it looks like.

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 16;
const COLUMN_WIDTH = 34;
// The names column is a fixed width rather than sized to its contents, so that
// a stack of cards lines its games up with each other. Sized to fit, every card
// in the feed would start its first game at a different place depending on how
// long its two engines happened to be called.
const NAME_WIDTH = 150;
const NAME_WIDTH_COMPACT = 138;

export interface SeriesScoreTableProps {
  series: BotSeries;
  /** The game being watched, drawn as the current column. */
  currentGameId?: string | null;
  /**
   * Called with a game id to switch to. Omitted makes the columns inert, which
   * is what a card only reporting a finished run wants.
   */
  onSelect?: (gameId: string) => void;
  /** Smaller, for the strip over a board rather than the card in a list. */
  compact?: boolean;
}

export default function SeriesScoreTable({
  compact = false,
  currentGameId = null,
  onSelect,
  series,
}: SeriesScoreTableProps) {
  const view = seriesView(series);
  const iconSize = compact ? 20 : 24;

  return (
    <View style={styles.wrap}>
      <View style={styles.table}>
        {/*
          The names stay put while the games scroll, so a fifty-game run is
          still legible: a column of numbers with the name scrolled off the side
          would be the same problem the chips had.
        */}
        <View style={[styles.names, { width: compact ? NAME_WIDTH_COMPACT : NAME_WIDTH }]}>
          <View style={styles.headerCell} />
          <Name
            botId={series.firstBotId}
            digest={series.firstBotIconSha256}
            name={view.firstName}
            size={iconSize}
          />
          <Name
            botId={series.secondBotId}
            digest={series.secondBotIconSha256}
            name={view.secondName}
            size={iconSize}
          />
        </View>

        {view.games.length === 0 ? (
          <Text style={styles.empty}>No games played yet.</Text>
        ) : (
          <ScrollView
            contentContainerStyle={styles.columns}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.scroller}
          >
            {view.games.map((entry) => (
              <GameColumn
                current={Boolean(entry.gameId) && entry.gameId === currentGameId}
                entry={entry}
                key={entry.number}
                onSelect={onSelect}
              />
            ))}
          </ScrollView>
        )}

        <View style={styles.totals}>
          <View style={styles.headerCell} />
          <View style={styles.totalCell}>
            <Text style={styles.total}>{view.firstTotal}</Text>
          </View>
          <View style={styles.totalCell}>
            <Text style={styles.total}>{view.secondTotal}</Text>
          </View>
        </View>
      </View>

      {/*
        Spelled out rather than left to the flag on the column. A walk-off is the
        one result that is about a bot rather than about a game, it is what
        people ask about when a score looks wrong, and a mark over a column
        cannot say whose fault it was.
      */}
      {view.abandoned.map((entry) => (
        <Text key={entry.number} style={styles.abandoned}>
          Game {entry.number}: {entry.abandonedBy} abandoned ·{' '}
          {entry.side === 'first' ? view.firstName : view.secondName} awarded the win
        </Text>
      ))}
    </View>
  );
}

interface NameProps {
  botId: string;
  digest?: string;
  name: string;
  size: number;
}

function Name({ botId, digest, name, size }: NameProps) {
  return (
    <View style={styles.nameRow}>
      <BotIcon name={name} size={size} uri={botIconUrl(botId, digest)} />
      <Text numberOfLines={1} style={styles.name}>
        {name}
      </Text>
    </View>
  );
}

interface GameColumnProps {
  entry: SeriesGameView;
  current: boolean;
  onSelect?: (gameId: string) => void;
}

// One game: its number over the two points it awarded. The whole column is the
// press target, because "game four" is the thing being picked and either cell
// of it is a fair place to aim.
function GameColumn({ current, entry, onSelect }: GameColumnProps) {
  const playable = Boolean(entry.gameId) && Boolean(onSelect);
  const body = (
    <View style={[styles.column, current && styles.columnCurrent]}>
      <View style={styles.headerCell}>
        <Text style={styles.number}>{entry.number}</Text>
        {entry.abandonedBy ? <Text style={styles.flag}>⚑</Text> : null}
      </View>
      <Cell points={entry.firstPoints} won={entry.side === 'first'} />
      <Cell points={entry.secondPoints} won={entry.side === 'second'} />
    </View>
  );

  if (!playable) {
    return (
      <View accessibilityLabel={entry.label} accessible>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityLabel={`${entry.label}. Watch this game.`}
      accessibilityRole="button"
      accessibilityState={{ selected: current }}
      onPress={() => onSelect?.(entry.gameId as string)}
      style={({ pressed }) => (pressed ? styles.pressed : undefined)}
    >
      {body}
    </Pressable>
  );
}

// A point reads as a point. The nought is dimmed rather than coloured, because
// a table of ones and noughts wants one thing to look at, and colouring the
// losses as loudly as the wins gives it two.
function Cell({ points, won }: { points: string; won: boolean }) {
  return (
    <View style={styles.cell}>
      <Text style={[styles.points, won ? styles.pointsWon : styles.pointsLost]}>{points}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.snug },
  table: { flexDirection: 'row', alignItems: 'flex-start' },

  names: { paddingRight: space.small },
  nameRow: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.snug,
  },
  name: { ...type.rowTitle, color: colors.text, flexShrink: 1, minWidth: 0 },

  scroller: { flexShrink: 1 },
  columns: { flexDirection: 'row' },
  column: {
    width: COLUMN_WIDTH,
    alignItems: 'center',
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  // A ring rather than a fill, so "which one am I on" and "who won it" stay two
  // separate readings of the same column.
  columnCurrent: { borderColor: colors.textStrong, backgroundColor: colors.surfaceRaised },
  pressed: { opacity: 0.55 },

  headerCell: { height: HEADER_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: 1 },
  number: { ...type.meta, color: colors.textFaint },
  flag: { fontSize: 8, color: colors.live },

  cell: { height: ROW_HEIGHT, justifyContent: 'center' },
  points: { ...type.rowTitle, textAlign: 'center' },
  pointsWon: { color: colors.accentSoft },
  pointsLost: { color: colors.textFaint },

  totals: { paddingLeft: space.small, alignItems: 'flex-end', minWidth: 28 },
  totalCell: { height: ROW_HEIGHT, justifyContent: 'center' },
  total: { ...type.cardTitle, color: colors.textStrong },

  empty: { ...type.meta, color: colors.textFaint, alignSelf: 'center' },
  abandoned: { ...type.meta, color: colors.liveSoft },
});
