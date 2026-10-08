import { type ReactNode } from 'react';
import { Text, View } from 'react-native';

import OccasionTag from './OccasionTag';
import SeriesLink from './SeriesLink';
import SeriesScoreTable from './SeriesScoreTable';
import { seriesMetaLine, seriesOccasion, seriesStatus, seriesView } from './seriesSummary';
import type { BotSeries } from '@/store/api/bots';
import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, themedSheet, type } from '@/theme';
import { Badge } from '@/ui/primitives';

// One run, drawn as the score table it is.
//
// The list this replaced was one row per run and one row per game, in two
// separate panels on two separate pages: a run said "Angel_v23_D16 6–0
// Angel_v19_D8" on the Bots page and its six games appeared, ungrouped and out
// of order, in a flat history on the Leaderboard. Nothing on either page said
// the six were the same six.
//
// So a run is a card, and the table inside it is the whole of its result — both
// engines named down the side, every game a column, the totals at the end.
//
// What the table cannot say is what the run *was*, and that is the card's first
// line: RANKED or CASUAL, and who picked the pairing — the hourly round, the
// server on somebody's press, or a person. Those used to be a stray "casual" in
// a line of settings, so an hourly round and a hand-started run between the
// same two engines drew as the same card. See `seriesOccasion`.
//
// What the card cannot be is the run's *address*. A feed is a moving window —
// this card will not be on the Bots page for long — so the link underneath it
// points at somewhere that does not scroll away: the run's own page.

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
  const modes = useGameStore((state) => state.modes);
  const view = seriesView(series);
  const status = seriesStatus(series);
  // Only a run still going has a game to be on. One that stopped early played
  // what it played; see SeriesView.planned.
  const progress = view.planned
    ? `Game ${Math.min(view.played + 1, view.planned)} of ${view.planned}`
    : null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <OccasionTag occasion={seriesOccasion(series)} />
        <View style={styles.status}>
          <Badge label={status.label} tone={status.tone} />
          <Text numberOfLines={1} style={styles.when}>
            {[progress, when].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </View>
      <Text numberOfLines={2} style={styles.meta}>
        {seriesMetaLine(series, modes)}
      </Text>

      <View style={styles.table}>
        <SeriesScoreTable
          currentGameId={currentGameId}
          liveGameIds={liveGameIds}
          onSelect={onSelectGame}
          series={series}
        />
      </View>

      <View style={styles.footer}>
        {action ? <View style={styles.action}>{action}</View> : null}
        {/*
          One quiet link rather than two buttons: a feed is a column of these,
          and a green button on every card is a column of primary actions. The
          run's own page has the link to copy.
        */}
        <View style={styles.links}>
          <SeriesLink label="VIEW SERIES ›" seriesId={series.seriesId} tone="default" />
        </View>
      </View>
    </View>
  );
}

const styles = themedSheet(() => ({
  card: {
    gap: space.small,
    padding: space.medium,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceWell,
  },
  // Wrapping, so on a phone the status drops under the tag rather than
  // squeezing the pairing's name to an ellipsis.
  header: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: space.medium,
    rowGap: space.snug,
  },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  when: { ...type.meta, color: colors.textFaint },
  meta: { ...type.meta, color: colors.textFaint },
  // The table sits on its own band, so the result reads as the card's body
  // rather than as another line of it.
  table: {
    paddingVertical: space.small,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.borderFaint,
  },
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.snug,
  },
  action: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  // Trailing and wrapping, so the pair reads as what to do *next* with the
  // table above them rather than as the card's own footer.
  links: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: space.snug,
    marginLeft: 'auto',
  },
}));
