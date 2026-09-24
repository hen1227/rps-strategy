import { StyleSheet, Text, View } from 'react-native';

import { colors, record as recordTones, space, themedSheet, type } from '@/theme';
import type { LeaderboardEntry } from '@/types/protocol';

// A row's record, in the two shapes every board on this page wants it: the
// numbers as words, and the ratio between them as a picture.
//
// Both live here rather than in the row and the podium card, because they are
// the same claim at two sizes and a second copy of "what counts as a win rate"
// is a second chance for the podium to disagree with the row directly under it.

/** Win-draw-loss, and what the three of them are out of. */
export interface LadderRecord {
  wins: number;
  draws: number;
  losses: number;
  games: number;
  /**
   * Share of finished games won, 0–1, and null for an account with none.
   *
   * Wins over games rather than wins over losses, which is what "win-loss
   * ratio" literally asks for and is the wrong number in a game with draws: an
   * engine at 1W 0L 99D would report an infinite ratio for a record that is
   * almost entirely stalemate. This one falls to a fiftieth, which is what
   * happened.
   */
  winRate: number | null;
}

export const ladderRecord = (entry: LeaderboardEntry): LadderRecord => {
  // The counters rather than `gamesPlayed`, which is a separate column and can
  // be the larger of the two on a row whose games predate a counter. The bar
  // below has to add up to what it draws.
  const games = entry.wins + entry.draws + entry.losses;
  return {
    wins: entry.wins,
    draws: entry.draws,
    losses: entry.losses,
    games,
    winRate: games > 0 ? entry.wins / games : null,
  };
};

/** `62%`, or a dash where there is nothing to take a percentage of. */
export const winRateLabel = (result: LadderRecord) =>
  result.winRate === null ? '–' : `${Math.round(result.winRate * 100)}%`;

/** `96W · 0D · 2L · 98 games`. */
export const recordLine = (result: LadderRecord) => {
  const games = result.games === 1 ? '1 game' : `${result.games} games`;
  return `${result.wins}W · ${result.draws}D · ${result.losses}L · ${games}`;
};

export interface RatioBarProps {
  result: LadderRecord;
  /** Wider on a podium card than in a row. */
  height?: number;
}

/**
 * The record as one bar: won, drawn, lost, left to right.
 *
 * The counters are already on the row, so this is not new information — it is
 * the same information in a form you can compare down a column without reading
 * six numbers per line, which is the whole reason a ladder is a list.
 *
 * Nothing at all for an account with no finished games, rather than an empty
 * track: a bar with no fill in it looks like a record of nothing but losses.
 */
export function RatioBar({ result, height = 4 }: RatioBarProps) {
  if (result.games === 0) return null;
  return (
    <View
      accessibilityLabel={recordLine(result)}
      accessibilityRole="progressbar"
      style={[styles.track, { height, borderRadius: height / 2 }]}
    >
      {/*
        `flex` on each segment rather than a percentage width: three rounded
        percentages do not add to a hundred, and the rounding error lands as a
        gap at the end of the bar.
      */}
      <View style={[styles.segment, { flex: result.wins, backgroundColor: recordTones.win }]} />
      <View style={[styles.segment, { flex: result.draws, backgroundColor: recordTones.draw }]} />
      <View style={[styles.segment, { flex: result.losses, backgroundColor: recordTones.loss }]} />
    </View>
  );
}

/** The bar with its percentage beside it, which is how a podium card says it. */
export function RecordSummary({ result }: { result: LadderRecord }) {
  return (
    <View style={styles.summary}>
      <View style={styles.summaryLine}>
        <Text style={styles.rate}>{winRateLabel(result)}</Text>
        <Text style={styles.rateLabel}>WINS</Text>
      </View>
      <RatioBar height={5} result={result} />
      <Text numberOfLines={1} style={styles.counters}>
        {recordLine(result)}
      </Text>
    </View>
  );
}

const styles = themedSheet(() => ({
  track: {
    flexDirection: 'row',
    overflow: 'hidden',
    backgroundColor: colors.surfaceSunken,
    width: '100%',
  },
  segment: { height: '100%' },

  summary: { gap: space.tight, width: '100%' },
  summaryLine: { flexDirection: 'row', alignItems: 'baseline', gap: space.tight },
  rate: { ...type.rowTitle, color: colors.textSoft },
  rateLabel: { ...type.eyebrow, color: colors.textFaint },
  counters: { ...type.meta, color: colors.textFaint },
}));
