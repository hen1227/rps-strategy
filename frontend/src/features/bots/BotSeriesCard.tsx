import { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import SeriesLink from './SeriesLink';
import SeriesScoreTable from './SeriesScoreTable';
import { seriesMetaLine, seriesStatusTone, seriesView } from './seriesSummary';
import { seriesURL } from '@/navigation/links';
import type { BotSeries } from '@/store/api/bots';
import { colors, radius, space, type } from '@/theme';
import CopyLinkButton from '@/ui/CopyLinkButton';
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
//
// What the card cannot be is the run's *address*. A feed is a moving window —
// this card will not be on the Bots page for long — so the two things underneath
// it point at somewhere that does not scroll away: the run's own page, and a
// link to that page for somebody who is not here.

export interface BotSeriesCardProps {
  series: BotSeries;
  /** Highlighted as the game on screen, for a card beside a board. */
  currentGameId?: string | null;
  /** Given a game id when somebody picks a column. */
  onSelectGame?: (gameId: string) => void;
  /**
   * The games being played right now, so the column two engines are on this
   * second is drawn as live and opens the board rather than a record that does
   * not exist yet. See `SeriesScoreTable`.
   */
  liveGameIds?: readonly string[];
  /** A STOP button, or anything else the page wants on the run. */
  action?: ReactNode;
  /** "2h ago" — passed in rather than computed, so one clock drives the feed. */
  when?: string;
}

export default function BotSeriesCard({
  action,
  currentGameId = null,
  liveGameIds,
  onSelectGame,
  series,
  when,
}: BotSeriesCardProps) {
  const view = seriesView(series);
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
        <Badge label={String(series.status).toUpperCase()} tone={seriesStatusTone(series)} />
        <Text numberOfLines={2} style={styles.meta}>
          {meta}
        </Text>
        {action}
      </View>

      <SeriesScoreTable
        currentGameId={currentGameId}
        liveGameIds={liveGameIds}
        onSelect={onSelectGame}
        series={series}
      />

      <View style={styles.links}>
        <CopyLinkButton
          accessibilityLabel={`Copy a link to ${view.firstName} versus ${view.secondName}`}
          label="COPY SERIES LINK"
          url={seriesURL(series.seriesId)}
        />
        <SeriesLink seriesId={series.seriesId} />
      </View>
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
  // Trailing rather than centred, and wrapping, so the pair reads as what to do
  // *next* with the table above them rather than as the card's own footer.
  links: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: space.snug,
  },
});
