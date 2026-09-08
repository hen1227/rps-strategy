import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import BotIcon from './BotIcon';
import { seriesGameIsOpen, seriesView, type SeriesGameView } from './seriesSummary';
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

// The same table over a board rather than inside a card. There it is a caption
// to the game and not a panel of its own, so it says the same three lines about
// a third shorter: a run should cost the board a bar off the top of the screen,
// not a block.
const ROW_HEIGHT_COMPACT = 18;
const HEADER_HEIGHT_COMPACT = 12;
const COLUMN_WIDTH_COMPACT = 26;
const NAME_WIDTH_COMPACT = 116;

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
  /**
   * The games being played right now, from the lobby's own list.
   *
   * A column with no result is one of two things and they are not the same: a
   * board two engines are on this second, or a game a stopped run left behind
   * without one. The first is worth watching and the second cannot be opened at
   * all — it has no archived record, so sending anybody to its review lands them
   * on "this game cannot be reviewed". Only the live list can tell them apart,
   * and it does not belong to a run, so it is passed in.
   */
  liveGameIds?: readonly string[];
}

export default function SeriesScoreTable({
  compact = false,
  currentGameId = null,
  liveGameIds,
  onSelect,
  series,
}: SeriesScoreTableProps) {
  const view = seriesView(series);
  const iconSize = compact ? 16 : 24;

  return (
    <View style={styles.wrap}>
      <View style={styles.table}>
        {/*
          The names stay put while the games scroll, so a fifty-game run is
          still legible: a column of numbers with the name scrolled off the side
          would be the same problem the chips had.
        */}
        <View
          style={[
            styles.names,
            compact && dense.names,
            { width: compact ? NAME_WIDTH_COMPACT : NAME_WIDTH },
          ]}
        >
          <View style={[styles.headerCell, compact && dense.headerCell]} />
          <Name
            botId={series.firstBotId}
            compact={compact}
            digest={series.firstBotIconSha256}
            name={view.firstName}
            size={iconSize}
          />
          <Name
            botId={series.secondBotId}
            compact={compact}
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
            style={[styles.scroller, compact && dense.scroller]}
          >
            {view.games.map((entry) => (
              <GameColumn
                compact={compact}
                current={Boolean(entry.gameId) && entry.gameId === currentGameId}
                entry={entry}
                key={entry.number}
                live={entry.gameId !== null && (liveGameIds ?? []).includes(entry.gameId)}
                onSelect={onSelect}
              />
            ))}
          </ScrollView>
        )}

        <View style={[styles.totals, compact && dense.totals]}>
          <View style={[styles.headerCell, compact && dense.headerCell]} />
          <View style={[styles.totalCell, compact && dense.totalCell]}>
            <Text style={[styles.total, compact && dense.total]}>{view.firstTotal}</Text>
          </View>
          <View style={[styles.totalCell, compact && dense.totalCell]}>
            <Text style={[styles.total, compact && dense.total]}>{view.secondTotal}</Text>
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
  compact: boolean;
  digest?: string;
  name: string;
  size: number;
}

function Name({ botId, compact, digest, name, size }: NameProps) {
  return (
    <View style={[styles.nameRow, compact && dense.nameRow]}>
      <BotIcon name={name} size={size} uri={botIconUrl(botId, digest)} />
      <Text numberOfLines={1} style={[styles.name, compact && dense.name]}>
        {name}
      </Text>
    </View>
  );
}

interface GameColumnProps {
  entry: SeriesGameView;
  compact: boolean;
  current: boolean;
  live: boolean;
  onSelect?: (gameId: string) => void;
}

// One game: its number over the two points it awarded. The whole column is the
// press target, because "game four" is the thing being picked and either cell
// of it is a fair place to aim.
//
// A game being played right now shows a live mark in both cells rather than the
// dot an undecided game gets, since "nobody has won this yet" and "this is
// happening" are worth telling apart at a glance. An undecided game that is
// *not* live is inert: there is nothing behind it to open — `seriesGameIsOpen`
// is the same rule the run's own page applies to its rows.
function GameColumn({ compact, current, entry, live, onSelect }: GameColumnProps) {
  const playable = Boolean(onSelect) && seriesGameIsOpen(entry, live);
  const body = (
    <View style={[styles.column, compact && dense.column, current && styles.columnCurrent]}>
      <View style={[styles.headerCell, compact && dense.headerCell]}>
        <Text style={[styles.number, compact && dense.number]}>{entry.number}</Text>
        {entry.abandonedBy ? <Text style={styles.flag}>⚑</Text> : null}
      </View>
      <Cell compact={compact} live={live} points={entry.firstPoints} won={entry.side === 'first'} />
      <Cell
        compact={compact}
        live={live}
        points={entry.secondPoints}
        won={entry.side === 'second'}
      />
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
function Cell({
  compact,
  live,
  points,
  won,
}: {
  compact: boolean;
  live: boolean;
  points: string;
  won: boolean;
}) {
  return (
    <View style={[styles.cell, compact && dense.cell]}>
      <Text
        style={[
          styles.points,
          compact && dense.points,
          won ? styles.pointsWon : styles.pointsLost,
          live && styles.pointsLive,
        ]}
      >
        {live ? '◉' : points}
      </Text>
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
  pointsLive: { color: colors.live },

  totals: { paddingLeft: space.small, alignItems: 'flex-end', minWidth: 28 },
  totalCell: { height: ROW_HEIGHT, justifyContent: 'center' },
  total: { ...type.cardTitle, color: colors.textStrong },

  empty: { ...type.meta, color: colors.textFaint, alignSelf: 'center' },
  abandoned: { ...type.meta, color: colors.liveSoft },
});

// Only what the compact table measures differently. Kept as overrides rather
// than a second sheet so there is still one description of what the table is,
// and the two versions cannot drift into looking like two tables.
const dense = StyleSheet.create({
  names: { paddingRight: space.snug },
  nameRow: { height: ROW_HEIGHT_COMPACT },
  name: { fontSize: 11 },
  // Sized to its games rather than stretched across whatever room it was given,
  // so the totals stay against the last column instead of drifting off to the
  // far side of the strip with a two-game run in between.
  scroller: { flexGrow: 0 },
  column: { width: COLUMN_WIDTH_COMPACT },
  headerCell: { height: HEADER_HEIGHT_COMPACT },
  number: { fontSize: 9, lineHeight: 12 },
  cell: { height: ROW_HEIGHT_COMPACT },
  points: { fontSize: 11 },
  totals: { paddingLeft: space.snug, minWidth: 22 },
  totalCell: { height: ROW_HEIGHT_COMPACT },
  total: { fontSize: 12 },
});
