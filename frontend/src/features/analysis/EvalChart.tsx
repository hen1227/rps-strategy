import { useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';

import MoveQualityBadge from './MoveQualityBadge';
import { chartMarks, markBudget } from './chartMarks';
import type { ExpectedScorePoint, GradableMove, ReviewMove } from '@/engine/gameReview';
import { colors, evaluationChart, moveQuality, players, themedSheet } from '@/theme';

const FALLBACK_WIDTH = 360;
const PLOT_INSET = { top: 17, right: 10, bottom: 17, left: 10 };
const BADGE_SIZE = 21;
const BADGE_GAP = 7;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

/**
 * The evaluation over a whole game, Red above the line and Blue below.
 *
 * The vertical axis is expected score, not centipawns. A chart of raw
 * evaluation is mostly a chart of one forced sequence at the end: the moment
 * a mate appears the axis rescales and everything that happened before it
 * flattens into a straight line. Expected score keeps every phase of the game
 * legible at the same size, which is the only reason to draw the curve at all.
 */
export interface EvalChartProps<TMove extends GradableMove = GradableMove> {
  /** The position the viewer is standing on, marked with a rule and a dot. */
  currentIndex: number;
  height?: number;
  /** Graded moves, for the badges over the notable ones. */
  moves: ReviewMove<TMove>[];
  onSelect: (positionIndex: number) => void;
  points: ExpectedScorePoint[];
  /** Positions in the whole game, so a partial curve is drawn to scale. */
  total: number;
}

export default function EvalChart<TMove extends GradableMove>({
  currentIndex,
  height = 136,
  moves,
  onSelect,
  points,
  total,
}: EvalChartProps<TMove>) {
  const [plotWidth, setPlotWidth] = useState(FALLBACK_WIDTH);

  const geometry = useMemo(() => {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) return null;
    const span = Math.max(1, total - 1);
    const usableWidth = Math.max(1, plotWidth - PLOT_INSET.left - PLOT_INSET.right);
    const usableHeight = Math.max(1, height - PLOT_INSET.top - PLOT_INSET.bottom);
    const x = (index: number) => PLOT_INSET.left + (index / span) * usableWidth;
    const y = (percent: number) =>
      PLOT_INSET.top + (1 - clamp(percent, 0, 100) / 100) * usableHeight;

    // Red fills from the floor up to the evaluation line and Blue occupies
    // the space above it, the same way round as the eval bar by the board.
    const firstY = y(first.redPercent);
    const lastY = y(last.redPercent);
    let area = `M 0 ${height.toFixed(2)} L 0 ${firstY.toFixed(2)}`;
    let line = `M 0 ${firstY.toFixed(2)}`;
    points.forEach((point) => {
      const position = `${x(point.index).toFixed(2)} ${y(point.redPercent).toFixed(2)}`;
      line += ` L ${position}`;
      area += ` L ${position}`;
    });
    line += ` L ${plotWidth.toFixed(2)} ${lastY.toFixed(2)}`;
    area += ` L ${plotWidth.toFixed(2)} ${lastY.toFixed(2)}`;
    area += ` L ${plotWidth.toFixed(2)} ${height.toFixed(2)} Z`;
    return { area, line, x, y };
  }, [height, plotWidth, points, total]);

  // Which mistakes get a badge is a policy, and it lives in `chartMarks.ts`
  // with its own test. Everything here is where to draw the ones it chose.
  const marks = useMemo(() => {
    if (!geometry) return [];
    const chosen = chartMarks({
      candidates: moves.map((move) => ({
        index: move.index,
        gradeKey: move.pending ? null : move.grade.key,
        grade: move.pending ? null : move.grade,
        lossPercent: move.pending ? 0 : move.lossPercent,
        isBook: move.isBook,
      })),
      x: (index) => geometry.x(index + 1),
      budget: markBudget(plotWidth),
      // Two badges closer than their own width overlap, and an overlapped
      // badge hides one verdict while misreading the one on top of it.
      minimumGap: BADGE_SIZE + BADGE_GAP,
    });
    return chosen.flatMap((mark) => {
      if (!mark.grade) return [];
      const cx = geometry.x(mark.index + 1);
      const cy = geometry.y(
        points.find((point) => point.index === mark.index + 1)?.redPercent ?? 50,
      );
      const placeBelow = cy < height / 2;
      const badgeTop = clamp(
        placeBelow ? cy + BADGE_GAP : cy - BADGE_SIZE - BADGE_GAP,
        2,
        height - BADGE_SIZE - 2,
      );
      return [
        {
          key: mark.index,
          grade: mark.grade,
          cx,
          cy,
          badgeLeft: clamp(cx - BADGE_SIZE / 2, 2, plotWidth - BADGE_SIZE - 2),
          badgeTop,
          connectorY: placeBelow ? badgeTop : badgeTop + BADGE_SIZE,
        },
      ];
    });
  }, [geometry, height, moves, plotWidth, points]);

  const selectedPoint = useMemo(() => {
    if (!geometry) return null;
    const point = points.find((candidate) => candidate.index === currentIndex);
    return point
      ? { cx: geometry.x(currentIndex), cy: geometry.y(point.redPercent) }
      : null;
  }, [currentIndex, geometry, points]);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>EVALUATION</Text>
        <Text style={styles.legend}>
          <Text style={styles.legendRed}>Red</Text> above · <Text style={styles.legendBlue}>Blue</Text> below
        </Text>
      </View>
      <View
        // The whole plot is one press target: a chart you cannot scrub is a
        // picture, and the point of it is to get to the move it is showing.
        accessibilityLabel={
          marks.length > 0
            ? `Evaluation over the game, with the ${marks.length} costliest mistakes ` +
              "marked. Every move's grade is in the move list. Press to jump to a move."
            : 'Evaluation over the game. Press to jump to a move.'
        }
        accessibilityRole="adjustable"
        onLayout={(event) => {
          const measured = Math.round(event.nativeEvent.layout.width);
          if (measured > 0 && measured !== plotWidth) setPlotWidth(measured);
        }}
        style={[styles.plot, { height }]}
      >
        {geometry ? (
          <Svg
            height={height}
            pointerEvents="none"
            viewBox={`0 0 ${plotWidth} ${height}`}
            width="100%"
          >
            <Defs>
              <LinearGradient id="blueEvaluation" x1="0%" x2="0%" y1="0%" y2="100%">
                <Stop offset="0%" stopColor={evaluationChart.blueHighlight} stopOpacity={0.58} />
                <Stop offset="100%" stopColor={evaluationChart.blueArea} stopOpacity={0.92} />
              </LinearGradient>
              <LinearGradient id="redEvaluation" x1="0%" x2="0%" y1="0%" y2="100%">
                <Stop offset="0%" stopColor={evaluationChart.redArea} stopOpacity={0.92} />
                <Stop offset="100%" stopColor={evaluationChart.redHighlight} stopOpacity={0.58} />
              </LinearGradient>
            </Defs>
            <Rect fill={evaluationChart.background} height={height} width={plotWidth} x={0} y={0} />
            <Rect fill="url(#blueEvaluation)" height={height} width={plotWidth} x={0} y={0} />
            <Path d={geometry.area} fill="url(#redEvaluation)" />
            <Rect
              fill={evaluationChart.selectionWash}
              height={height}
              width={8}
              x={clamp(geometry.x(currentIndex) - 4, 0, plotWidth - 8)}
              y={0}
            />
            <Path
              d={geometry.line}
              fill="none"
              stroke={evaluationChart.lineGlow}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={5}
            />
            <Path
              d={geometry.line}
              fill="none"
              stroke={evaluationChart.line}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.15}
            />
            {marks.map((mark) => (
              <Line
                key={`connector-${mark.key}`}
                stroke={moveQuality[mark.grade.key]}
                strokeOpacity={0.8}
                strokeWidth={1.25}
                x1={mark.cx}
                x2={mark.cx}
                y1={mark.cy}
                y2={mark.connectorY}
              />
            ))}
            {marks.map((mark) => (
              <Circle
                cx={mark.cx}
                cy={mark.cy}
                fill={moveQuality[mark.grade.key]}
                key={`anchor-${mark.key}`}
                r={3.4}
                stroke={evaluationChart.background}
                strokeWidth={1.4}
              />
            ))}
            <Line
              stroke={evaluationChart.selection}
              strokeWidth={2}
              x1={geometry.x(currentIndex)}
              x2={geometry.x(currentIndex)}
              y1={0}
              y2={height}
            />
            {selectedPoint ? (
              <Circle
                cx={selectedPoint.cx}
                cy={selectedPoint.cy}
                fill={evaluationChart.line}
                r={4.3}
                stroke={evaluationChart.selection}
                strokeWidth={2.2}
              />
            ) : null}
          </Svg>
        ) : (
          <View style={styles.pending}>
            <Text style={styles.pendingText}>Waiting for the first evaluations…</Text>
          </View>
        )}
        <View style={styles.scrubber}>
          {Array.from({ length: total }, (_, index) => (
            <Pressable
              accessible={false}
              focusable={false}
              key={index}
              onFocus={(event) => event.currentTarget?.blur?.()}
              onPress={() => onSelect(index)}
              style={styles.scrubberCell}
              tabIndex={-1}
            />
          ))}
        </View>
        {marks.map((mark) => (
          <View
            key={`badge-${mark.key}`}
            pointerEvents="none"
            style={[styles.qualityMark, { left: mark.badgeLeft, top: mark.badgeTop }]}
          >
            <MoveQualityBadge
              accessible={false}
              compact
              grade={mark.grade}
              showLabel={false}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = themedSheet(() => ({
  card: {
    overflow: 'hidden',
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 42,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  eyebrow: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.35 },
  legend: { color: colors.textDim, fontSize: 8, fontWeight: '800' },
  legendRed: { color: players.Red.soft, fontWeight: '900' },
  legendBlue: { color: players.Blue.soft, fontWeight: '900' },
  plot: {
    position: 'relative',
    width: '100%',
    overflow: 'hidden',
    borderTopWidth: 1,
    borderTopColor: colors.borderStrong,
    backgroundColor: evaluationChart.background,
  },
  pending: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pendingText: { color: colors.textFaint, fontSize: 9 },
  scrubber: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, flexDirection: 'row' },
  scrubberCell: {
    flex: 1,
    height: '100%',
    outlineColor: 'transparent',
    outlineWidth: 0,
    // The scrubber cells are a click target, never a focus stop: the chart is
    // navigated with the arrow keys. `outlineStyle` is web-only, which React
    // Native's `ViewStyle` has no name for.
    ...Platform.select<ViewStyle>({
      web: { outlineStyle: 'none' } as unknown as ViewStyle,
      default: {},
    }),
  },
  qualityMark: { position: 'absolute', width: BADGE_SIZE, height: BADGE_SIZE },
}));
