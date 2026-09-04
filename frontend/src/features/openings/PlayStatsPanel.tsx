// What people actually play.
//
// The book half of this page says what is good. This says what happens, and
// the gap between the two is the interesting part: a move can be RPSFish's
// third choice and the one four players in five reach for. Nothing here tries
// to reconcile them.
//
// Compiled from the game archive once a day, so every number is dated and the
// panel says when. It also says how many games it could *not* count, which is
// not a footnote at the moment: the rules changed on 2026-09-03 so that Blue
// moves first, and a game recorded before that does not replay under today's
// rules -- so most of the archive is uncountable and a panel that showed only
// the games it kept would badly mislead.

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { walkOpeningLine } from '@/engine/openingLine';
import {
  formatShare,
  hasEnoughGames,
  openingScoreline,
  type OpeningCohort,
  type OpeningStatsLine,
  type OpeningStatsNode,
} from '@/engine/openingStats';
import MiniBoard from '@/features/board/MiniBoard';
import { colors, players, radius, space } from '@/theme';
import type { ModeDefinition, ModeID } from '@/types/game';
import { Badge, OptionChips, Panel } from '@/ui/primitives';

import { publishedOn, ui } from './openingsUi';

/** The board beside the headline, showing the most played opening move. */
const STATS_BOARD = 150;

const COHORTS: readonly { value: OpeningCohort; label: string }[] = [
  { value: 'human', label: 'HUMANS' },
  { value: 'bot', label: 'BOTS' },
  { value: 'mixed', label: 'HUMAN v BOT' },
];

interface ShareRowProps {
  line: OpeningStatsLine;
  label: string;
  onOpen: () => void;
  total: number;
}

/**
 * One line's share, drawn as a bar with the result mix inside it.
 *
 * The bar is the count and the fill inside it is who won, so a row answers
 * both questions at once -- how often this is played, and whether it works --
 * without two charts or a tooltip.
 */
function ShareRow({ line, label, onOpen, total }: ShareRowProps) {
  const share = line.share;
  const scoreline = openingScoreline(line);
  return (
    <Pressable
      accessibilityLabel={`Open ${line.line.join(' ')}`}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [styles.row, pressed && ui.pressed]}
    >
      <View style={styles.rowHeading}>
        <Text style={styles.rowLabel}>{label}</Text>
        <View style={styles.rowFacts}>
          {/* Below a handful of games a percentage is a count wearing a
              percent sign, so the count is what gets shown. */}
          {hasEnoughGames(total) ? (
            <Text style={styles.rowShare}>{formatShare(share)}</Text>
          ) : null}
          <Text style={styles.rowGames}>
            {line.games} game{line.games === 1 ? '' : 's'}
          </Text>
        </View>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.min(100, Math.max(1, share * 100))}%` }]}>
          {scoreline ? (
            <>
              <View style={[styles.segment, { flex: Math.max(0.001, scoreline.redShare) }]} />
              <View
                style={[
                  styles.segment,
                  styles.drawSegment,
                  { flex: Math.max(0.001, scoreline.drawShare) },
                ]}
              />
              <View
                style={[
                  styles.segment,
                  styles.blueSegment,
                  { flex: Math.max(0.001, scoreline.blueShare) },
                ]}
              />
            </>
          ) : null}
        </View>
      </View>
      {scoreline ? (
        <Text style={styles.rowResults}>
          {line.redWins}R · {line.draws}D · {line.blueWins}B
        </Text>
      ) : null}
    </Pressable>
  );
}

export interface PlayStatsPanelProps {
  cohort: OpeningCohort;
  /** Null while loading; the 404 case arrives as `missing`. */
  stats: OpeningStatsNode | null;
  /** True when the server has never compiled this mode. */
  missing: boolean;
  mode: ModeDefinition | null;
  modeId: ModeID;
  onCohort: (cohort: OpeningCohort) => void;
  onOpen: (line: string[]) => void;
}

export default function PlayStatsPanel({
  cohort,
  stats,
  missing,
  mode,
  modeId,
  onCohort,
  onOpen,
}: PlayStatsPanelProps) {
  const top = stats?.continuations?.[0];
  const walk = top ? walkOpeningLine(mode, top.line) : null;
  const board = walk?.steps.at(-1) ?? null;

  return (
    <Panel style={styles.panel}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={ui.eyebrow}>WHAT PEOPLE PLAY</Text>
          <Text style={styles.sectionTitle}>Most played openings</Text>
        </View>
        {stats?.computedAtUnixMs ? (
          <Badge label={`COMPILED ${publishedOn(stats.computedAtUnixMs)}`} />
        ) : null}
      </View>

      <OptionChips options={COHORTS} onChange={onCohort} value={cohort} />

      {missing ? (
        <Text style={styles.emptyCopy}>
          These statistics have not been compiled yet. The server recompiles them from the game
          archive once a day.
        </Text>
      ) : !stats ? (
        <Text style={styles.emptyCopy}>Counting games…</Text>
      ) : stats.games === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No games to count yet.</Text>
          <Text style={styles.emptyCopy}>
            {stats.skipped > 0
              ? `${stats.skipped} archived game${stats.skipped === 1 ? '' : 's'} could not be counted: ` +
                'they were played before the 3 September 2026 rules change, when Red moved first, ' +
                'so their opening moves are not legal opening moves now. Games played from here on ' +
                'will fill this in.'
              : 'Nobody in this group has finished a game in this mode yet.'}
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.headline}>
            {/* The board earns its place: it is the position the most played
                opening move produces, which is what the panel is about. */}
            {board ? (
              <MiniBoard
                capture={board.captured}
                grid={board.game.grid}
                modeId={modeId}
                move={board.move}
                mover={board.mover}
                size={STATS_BOARD}
              />
            ) : null}
            <View style={styles.headlineCopy}>
              <Text style={styles.headlineNumber}>{stats.games.toLocaleString()}</Text>
              <Text style={styles.headlineLabel}>
                game{stats.games === 1 ? '' : 's'} counted
              </Text>
              {top ? (
                <Text style={styles.headlineDetail}>
                  {hasEnoughGames(stats.games)
                    ? `${formatShare(top.share)} of them open ${top.move}.`
                    : `The most common opening move so far is ${top.move}.`}
                </Text>
              ) : null}
              {stats.skipped > 0 ? (
                <Text style={styles.skipped}>
                  {stats.skipped.toLocaleString()} older game
                  {stats.skipped === 1 ? '' : 's'} skipped — played before the 3 September 2026
                  rules change and no longer replayable.
                </Text>
              ) : null}
            </View>
          </View>

          <Text style={styles.sectionCopy}>
            First moves, most played first. The bar is how much of the archive played it; the
            colours inside are who went on to win.
          </Text>
          <View style={styles.rows}>
            {stats.continuations.slice(0, 10).map((line) => (
              <ShareRow
                key={line.line.join(' ')}
                label={line.move ?? ''}
                line={line}
                onOpen={() => onOpen(line.line)}
                total={stats.games}
              />
            ))}
          </View>

          {stats.popular?.length ? (
            <>
              <Text style={styles.subheading}>Most played lines</Text>
              <View style={styles.rows}>
                {stats.popular.slice(0, 8).map((line) => (
                  <ShareRow
                    key={line.line.join(' ')}
                    label={line.line.join('  ')}
                    line={line}
                    onOpen={() => onOpen(line.line)}
                    total={stats.games}
                  />
                ))}
              </View>
            </>
          ) : null}
        </>
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  panel: { gap: space.small },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: space.small,
    justifyContent: 'space-between',
  },
  headerCopy: { flex: 1, gap: 2, minWidth: 0 },
  sectionTitle: { color: colors.text, fontSize: 19, fontWeight: '700' },
  sectionCopy: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  subheading: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    marginTop: space.tight,
  },
  headline: { alignItems: 'center', flexDirection: 'row', gap: space.medium },
  headlineCopy: { flex: 1, gap: 2, minWidth: 0 },
  headlineNumber: { color: colors.text, fontSize: 34, fontWeight: '800', lineHeight: 38 },
  headlineLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  headlineDetail: { color: colors.text, fontSize: 13, lineHeight: 19, marginTop: 4 },
  skipped: { color: colors.textFaint, fontSize: 11, lineHeight: 16, marginTop: 6 },
  rows: { gap: space.small },
  row: { gap: 3 },
  rowHeading: { alignItems: 'baseline', flexDirection: 'row', gap: space.small },
  // minWidth 0 is what lets a long line wrap rather than push the counts off
  // the row: a flex item will not shrink below its longest word without it.
  rowLabel: {
    color: colors.text,
    flex: 1,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    minWidth: 0,
  },
  rowFacts: { alignItems: 'baseline', flexDirection: 'row', gap: 6 },
  rowShare: { color: colors.accentBright, fontSize: 13, fontWeight: '800' },
  rowGames: { color: colors.textFaint, fontSize: 11 },
  track: {
    backgroundColor: colors.surface,
    borderRadius: radius.small,
    height: 10,
    overflow: 'hidden',
  },
  fill: { borderRadius: radius.small, flexDirection: 'row', height: '100%' },
  segment: { backgroundColor: players.Red.strong, height: '100%' },
  drawSegment: { backgroundColor: colors.textFaint },
  blueSegment: { backgroundColor: players.Blue.strong },
  rowResults: { color: colors.textFaint, fontSize: 10, fontVariant: ['tabular-nums'] },
  emptyState: { gap: 6 },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  emptyCopy: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
});
