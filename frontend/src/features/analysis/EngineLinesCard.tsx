import { StyleSheet, Text, View } from 'react-native';

import { formatScore } from './EvalBar';
import { moveLabel } from '@/engine/analysisGame';
import type { Analysis, EngineLine } from '@/engine/rpsfish/protocol';
import { board, colors, radius, themedSheet } from '@/theme';
import type { PlayerColor } from '@/types/game';

const variationLabel = (line: EngineLine) =>
  line.principalVariation
    ?.slice(1, 5)
    .map(moveLabel)
    .join(' · ');

// One rendering of RPSFish's ranked lines for self-analysis, game review, and
// autonomous matches. Callers supply only the small bit of screen-specific
// metadata that belongs in the header.
export interface EngineLinesCardProps {
  analysis: Analysis | null | undefined;
  emptyMessage?: string;
  /** Replaces the default depth-and-nodes line in the header. */
  meta?: string | null;
  turn: PlayerColor;
}

export default function EngineLinesCard({
  analysis,
  emptyMessage = 'No legal continuation.',
  meta,
  turn,
}: EngineLinesCardProps) {
  const defaultMeta = analysis
    ? `DEPTH ${analysis.depth}/${analysis.selectiveDepth} · ${analysis.nodes.toLocaleString()} NODES`
    : null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>TOP MOVES FOR {turn.toUpperCase()}</Text>
        {analysis ? <Text style={styles.meta}>{meta ?? defaultMeta}</Text> : null}
      </View>
      {analysis?.lines?.length ? (
        analysis.lines.map((line, index) => (
          <View
            key={`${line.from.x}:${line.from.y}-${line.to.x}:${line.to.y}`}
            style={styles.lineRow}
          >
            <View
              style={[
                styles.lineRank,
                { backgroundColor: board.analysisArrows[index] ?? board.analysisArrows[0] },
              ]}
            >
              <Text style={styles.lineRankText}>{index + 1}</Text>
            </View>
            <View style={styles.lineCopy}>
              <Text style={styles.lineMove}>{moveLabel(line)}</Text>
              {variationLabel(line) ? (
                <Text numberOfLines={1} style={styles.lineVariation}>
                  then {variationLabel(line)}
                </Text>
              ) : null}
            </View>
            <Text style={styles.lineScore}>{formatScore(line.score)}</Text>
          </View>
        ))
      ) : (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>{emptyMessage}</Text>
        </View>
      )}
    </View>
  );
}

const styles = themedSheet(() => ({
  card: {
    overflow: 'hidden',
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  header: { paddingHorizontal: 13, paddingTop: 12, paddingBottom: 9 },
  eyebrow: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  meta: { color: colors.textFaint, fontSize: 7, fontWeight: '800', marginTop: 4 },
  lineRow: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  lineRank: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.small,
  },
  lineRankText: { color: colors.textInverse, fontSize: 9, fontWeight: '900' },
  lineCopy: { flex: 1, minWidth: 0 },
  lineMove: { color: colors.textStrong, fontSize: 12, fontWeight: '900' },
  lineVariation: { color: colors.textFaint, fontSize: 8, marginTop: 2 },
  lineScore: {
    color: colors.textSoft,
    fontSize: 11,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  empty: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  emptyText: { color: colors.textFaint, fontSize: 9 },
}));
