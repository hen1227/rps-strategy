import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import PieceIcon from '@/features/board/PieceIcon';
import { predatorOf, squareLabel } from '@/engine/analysisGame';
import { UNREACHABLE, type PieceReading, type ReachAnalysis } from '@/engine/reach';
import type { ReachSettings } from './settings';
import { colors, players, radius, reach, space } from '@/theme';
import type { Position, SideColor } from '@/types/game';

// What the distances add up to, in words.
//
// The board says where the pieces can go; this says what that means for the
// race, and it is careful about the difference between the two things it knows.
// A piece with no predators left really cannot be stopped. A verdict about who
// arrives first is a *bound* — it holds the blockers still and credits the
// defender with doing nothing but intercepting — so it is labelled as one here
// rather than being dressed up as an evaluation. Anything stronger would need
// a search, and there is one of those on the analysis board already.

const moves = (value: number | null) =>
  value === null || value === UNREACHABLE ? '—' : String(value);

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, tone ? { color: tone } : null]}>{value}</Text>
    </View>
  );
}

function Tag({ label, tone }: { label: string; tone: string }) {
  return (
    <View style={[styles.tag, { borderColor: tone }]}>
      <Text style={[styles.tagText, { color: tone }]}>{label}</Text>
    </View>
  );
}

/** The one line at the top: who gets there first, and by how much. */
function Verdict({ analysis }: { analysis: ReachAnalysis }) {
  const { red, blue, toMove, winner, margin } = analysis.verdict;

  const side = (color: SideColor, reading: PieceReading | null) =>
    reading
      ? `${color} in ${reading.safeDistance} from ${squareLabel(reading.walker.from)}`
      : `${color} has no clear run`;

  const call =
    winner === null
      ? 'Neither side has a run nothing can cut off.'
      : margin === null
        ? `Only ${winner} has a run nothing can cut off.`
        : margin === 0
          ? `${winner} arrives first, on the move.`
          : `${winner} arrives first, ${margin} move${margin === 1 ? '' : 's'} to spare.`;

  return (
    <View style={styles.verdict}>
      <View style={styles.verdictHead}>
        <View
          style={[
            styles.verdictDot,
            { backgroundColor: winner ? players[winner].strong : colors.textFaint },
          ]}
        />
        <Text style={styles.verdictCall}>{call}</Text>
      </View>
      <Text style={styles.verdictDetail}>
        {side('Red', red)} · {side('Blue', blue)} · {toMove} to move
      </Text>
    </View>
  );
}

/** One piece's row of the table. */
function Row({
  reading,
  focused,
  onPress,
}: {
  reading: PieceReading;
  focused: boolean;
  onPress: (square: Position) => void;
}) {
  const { walker } = reading;
  return (
    <Pressable
      accessibilityLabel={`${walker.owner} ${walker.piece} on ${squareLabel(walker.from)}, ${
        reading.safeDistance === null
          ? 'no safe run'
          : `safe run in ${reading.safeDistance}`
      }`}
      accessibilityRole="button"
      accessibilityState={{ selected: focused }}
      onPress={() => onPress(walker.from)}
      style={({ pressed }) => [
        styles.row,
        focused && styles.rowFocused,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={styles.rowIcon}>
        <PieceIcon color={walker.owner} piece={walker.piece} size={13} />
      </View>
      <Text style={styles.rowSquare}>{squareLabel(walker.from)}</Text>
      <Text style={styles.rowNumber}>{moves(reading.openDistance)}</Text>
      <Text style={styles.rowNumber}>{moves(reading.blockedDistance)}</Text>
      <Text
        style={[
          styles.rowNumber,
          styles.rowSafe,
          reading.safeDistance === null && styles.rowSafeNone,
        ]}
      >
        {moves(reading.safeDistance)}
      </Text>
      <Text style={styles.rowNote} numberOfLines={1}>
        {reading.immortal
          ? 'immortal'
          : reading.attackedIn === 1
            ? 'en prise'
            : reading.cutOff
              ? `cut at ${squareLabel(reading.cutOff.at)}`
              : ''}
      </Text>
    </Pressable>
  );
}

export interface ReachSummaryProps {
  analysis: ReachAnalysis | null;
  focusReading: PieceReading | null;
  settings: ReachSettings;
  onFocus: (square: Position) => void;
}

export default function ReachSummary({
  analysis,
  focusReading,
  settings,
  onFocus,
}: ReachSummaryProps) {
  const [showAll, setShowAll] = useState(false);

  // Whoever is closest to finishing first, so the interesting pieces are the
  // ones you can see without opening the table.
  const ranked = useMemo(() => {
    if (!analysis) return [];
    const rank = (reading: PieceReading) =>
      reading.safeDistance ?? reading.blockedDistance + 100;
    return [...analysis.readings].sort((left, right) => rank(left) - rank(right));
  }, [analysis]);

  if (!analysis) return null;

  const listed = showAll ? ranked : ranked.slice(0, 6);
  const focus = focusReading;
  const predatorName = predatorOf(focus?.walker.piece ?? 'Rock');

  return (
    <View style={styles.card}>
      <Text style={styles.title}>RACE</Text>
      <Verdict analysis={analysis} />

      {focus && (
        <View style={styles.focus}>
          <View style={styles.focusHead}>
            <PieceIcon color={focus.walker.owner} piece={focus.walker.piece} size={15} />
            <Text style={styles.focusTitle}>
              {focus.walker.owner} {focus.walker.piece} on {squareLabel(focus.walker.from)}
            </Text>
            {settings.ghost && <Tag label="GHOST" tone={reach.ghostRing} />}
            {focus.immortal && <Tag label="IMMORTAL" tone={colors.accentBright} />}
            {!focus.immortal && focus.attackedIn === 1 && (
              <Tag label="EN PRISE" tone={colors.danger} />
            )}
          </View>
          <View style={styles.stats}>
            <Stat label="OPEN" value={moves(focus.openDistance)} />
            <Stat label="BLOCKED" value={moves(focus.blockedDistance)} />
            <Stat
              label="SAFE"
              value={moves(focus.safeDistance)}
              tone={focus.safeDistance === null ? colors.danger : colors.accentBright}
            />
            <Stat
              label={`${predatorName.toUpperCase()}S`}
              value={String(focus.predatorCount)}
            />
          </View>
          {focus.cutOff && (
            <Text style={styles.cutOff}>
              Quickest route dies on {squareLabel(focus.cutOff.at)}: you arrive on move{' '}
              {focus.cutOff.arrivalStep}, a {predatorName.toLowerCase()} is there in{' '}
              {focus.cutOff.threat}.
            </Text>
          )}
          {focus.immortal && (
            <Text style={styles.note}>
              No {predatorName.toLowerCase()} left on the board, so nothing can ever take this
              piece. Its blocked distance is a win in that many moves.
            </Text>
          )}
        </View>
      )}

      <View style={styles.tableHead}>
        <View style={styles.rowIcon} />
        <Text style={[styles.rowSquare, styles.headText]}>SQ</Text>
        <Text style={[styles.rowNumber, styles.headText]}>OPEN</Text>
        <Text style={[styles.rowNumber, styles.headText]}>BLKD</Text>
        <Text style={[styles.rowNumber, styles.headText]}>SAFE</Text>
        <Text style={[styles.rowNote, styles.headText]} />
      </View>
      {listed.map((reading) => (
        <Row
          focused={
            focus?.walker.from.x === reading.walker.from.x &&
            focus?.walker.from.y === reading.walker.from.y
          }
          key={`${reading.walker.from.x}-${reading.walker.from.y}`}
          onPress={onFocus}
          reading={reading}
        />
      ))}
      {ranked.length > 6 && (
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowAll((shown) => !shown)}
          style={({ pressed }) => [styles.more, pressed && styles.rowPressed]}
        >
          <Text style={styles.moreText}>
            {showAll ? 'SHOW FEWER' : `SHOW ALL ${ranked.length}`}
          </Text>
        </Pressable>
      )}

      <Text style={styles.caveat}>
        A bound, not a proof: blockers are held still and the defender is credited with doing
        nothing but intercepting. Only IMMORTAL is conclusive.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    gap: space.snug,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  title: { color: colors.textFaint, fontSize: 7, fontWeight: '900', letterSpacing: 1.1 },

  verdict: { gap: 3 },
  verdictHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  verdictDot: { width: 7, height: 7, borderRadius: 4 },
  verdictCall: { flex: 1, minWidth: 0, color: colors.text, fontSize: 11, fontWeight: '800' },
  verdictDetail: { color: colors.textMuted, fontSize: 9, lineHeight: 14 },

  focus: {
    gap: 5,
    padding: 7,
    borderRadius: radius.small,
    backgroundColor: colors.surfaceSunken,
  },
  focusHead: { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  focusTitle: { color: colors.textSoft, fontSize: 10, fontWeight: '800' },
  stats: { flexDirection: 'row', gap: 10 },
  stat: { gap: 1 },
  statLabel: { color: colors.textFaint, fontSize: 7, fontWeight: '900', letterSpacing: 0.7 },
  statValue: { color: colors.text, fontSize: 13, fontWeight: '900' },
  cutOff: { color: colors.dangerSoft, fontSize: 9, lineHeight: 14 },
  note: { color: colors.accentText, fontSize: 9, lineHeight: 14 },

  tag: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: radius.small - 3,
    borderWidth: 1,
  },
  tagText: { fontSize: 7, fontWeight: '900', letterSpacing: 0.6 },

  tableHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingTop: 3,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  headText: { color: colors.textFaint, fontSize: 7, fontWeight: '900', letterSpacing: 0.6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
    borderRadius: radius.small - 3,
  },
  rowFocused: { backgroundColor: colors.surfaceRaised },
  rowPressed: { opacity: 0.7 },
  rowIcon: { width: 15, alignItems: 'center' },
  rowSquare: { width: 20, color: colors.textSoft, fontSize: 9, fontWeight: '800' },
  rowNumber: { width: 26, textAlign: 'right', color: colors.textMuted, fontSize: 10 },
  rowSafe: { color: colors.text, fontWeight: '900' },
  rowSafeNone: { color: colors.textFaint },
  // `minWidth: 0` is what lets this shrink instead of pushing the numbers off
  // the side of a 310px panel — flex's default is `auto`, which never shrinks
  // below the longest word.
  rowNote: { flex: 1, minWidth: 0, color: colors.textFaint, fontSize: 8 },

  more: { alignSelf: 'flex-start', paddingVertical: 2 },
  moreText: { color: colors.accentText, fontSize: 8, fontWeight: '900', letterSpacing: 0.7 },

  caveat: { color: colors.textFaint, fontSize: 8, lineHeight: 12 },
});
