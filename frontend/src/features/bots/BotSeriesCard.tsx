import { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import SeriesScoreTable from './SeriesScoreTable';
import { seriesMetaLine, seriesView } from './seriesSummary';
import type { BotSeries } from '@/store/api/bots';
import { colors, radius, space, type } from '@/theme';
import { Badge } from '@/ui/primitives';

// One run, drawn as the score table it is.
//
// The list this replaced was one row per run and one row per game, in two
// separate panels on two separate pages: a run said "Angel_v23_D16 6–0
// Angel_v19_D8" on the Bots page and its six games appeared, ungrouped and out
// of order, in a flat history on the Leaderboard. Nothing on either page said
// the six were the same six.
//
// So a run is a card, and the table inside it is the whole of it — both engines
// named down the side, every game a column, the totals at the end. There is no
// separate scoreline above it because there is nothing left for one to say.

/** How the run's state reads, and in what colour. */
const STATUS_TONES: Record<string, 'live' | 'accent' | 'neutral'> = {
  running: 'live',
  completed: 'accent',
  aborted: 'neutral',
  pending: 'neutral',
};

export interface BotSeriesCardProps {
  series: BotSeries;
  /** Highlighted as the game on screen, for a card beside a board. */
  currentGameId?: string | null;
  /** Given a game id when somebody picks a column. */
  onSelectGame?: (gameId: string) => void;
  /** A STOP button, or anything else the page wants on the run. */
  action?: ReactNode;
  /** "2h ago" — passed in rather than computed, so one clock drives the feed. */
  when?: string;
}

export default function BotSeriesCard({
  action,
  currentGameId = null,
  onSelectGame,
  series,
  when,
}: BotSeriesCardProps) {
  const view = seriesView(series);
  const status = String(series.status).toLowerCase();
  const meta = [
    series.modeId,
    // Only a run still going has a number of games left to describe. One that
    // stopped early played what it played; see SeriesView.planned.
    view.planned ? `game ${Math.min(view.played + 1, view.planned)} of ${view.planned}` : null,
    seriesMetaLine(series),
    when,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={styles.card}>
      <View style={styles.top}>
        <Badge label={status.toUpperCase()} tone={STATUS_TONES[status] ?? 'neutral'} />
        <Text numberOfLines={2} style={styles.meta}>
          {meta}
        </Text>
        {action}
      </View>

      <SeriesScoreTable
        currentGameId={currentGameId}
        onSelect={onSelectGame}
        series={series}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: space.small,
    padding: space.medium,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceWell,
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  meta: { ...type.meta, color: colors.textFaint, flexShrink: 1, minWidth: 0 },
});
