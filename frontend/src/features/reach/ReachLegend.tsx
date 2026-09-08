import { StyleSheet, Text, View } from 'react-native';

import type { ReachSettings } from './settings';
import { REACH_BANDS, board, colors, players, radius, reach } from '@/theme';
import type { SideColor } from '@/types/game';

// What the colours on the board mean, in the space of two rows.
//
// The ramp is drawn from the same array the board paints with, so a swatch here
// can never disagree with a square there. Of the two ramps it shows the light
// tile's, over the light tile: the sand square carries far more of the hue than
// the green one does, so that is the version a key can actually be read from.

const swatchCount = 5;

function Ramp({ color, upTo }: { color: SideColor; upTo: number }) {
  const ramp = players[color].reachOnLight;
  const last = upTo > 0 ? Math.min(upTo, REACH_BANDS - 1) : REACH_BANDS - 1;
  const steps = Array.from({ length: swatchCount }, (_unusedStep, index) =>
    Math.round((last * index) / (swatchCount - 1)),
  );

  return (
    <View style={styles.ramp}>
      {steps.map((moves, index) => (
        <View key={`${moves}-${index}`} style={styles.rampCell}>
          {/* Over the board's own tile colour, so a swatch shows the colour the
              square will actually be rather than the colour of the wash. */}
          <View style={styles.swatch}>
            <View style={[styles.swatchWash, { backgroundColor: ramp[moves] }]} />
          </View>
          <Text style={styles.rampNumber}>{moves}</Text>
        </View>
      ))}
    </View>
  );
}

function Key({ color, label, ring }: { color: string; label: string; ring?: boolean }) {
  return (
    <View style={styles.keyItem}>
      <View
        style={[
          styles.keySwatch,
          ring
            ? { borderColor: color, borderWidth: 1.5 }
            : { backgroundColor: color },
        ]}
      />
      <Text style={styles.keyLabel}>{label}</Text>
    </View>
  );
}

export interface ReachLegendProps {
  settings: ReachSettings;
  /** The focused piece's colour, which the single-piece views are drawn in. */
  focusColor?: SideColor | null;
}

export default function ReachLegend({ settings, focusColor }: ReachLegendProps) {
  const contested = settings.view === 'contest';
  const rampColor = settings.view === 'side' ? settings.side : focusColor ?? settings.side;

  return (
    <View style={styles.root}>
      {contested ? (
        <View style={styles.contestRow}>
          <Ramp color="Red" upTo={settings.maxMoves} />
          <Ramp color="Blue" upTo={settings.maxMoves} />
        </View>
      ) : (
        <Ramp color={rampColor} upTo={settings.maxMoves} />
      )}
      <Text style={styles.notation}>
        Squares read <Text style={styles.notationStrong}>R3</Text>,{' '}
        <Text style={styles.notationStrong}>P4</Text>,{' '}
        <Text style={styles.notationStrong}>S5</Text> — the kind, then the moves it
        needs. One line per kind that can get there.
      </Text>
      <View style={styles.keys}>
        <Text style={styles.keysLabel}>MOVES AWAY</Text>
        {contested && <Key color={reach.contestedTie} label="dead heat" />}
        {settings.showDanger && !contested && <Key color={reach.danger} label="predator first" />}
        {settings.showPath && <Key color={reach.path} label="safe run" />}
        {settings.showFrontier && settings.maxMoves > 0 && (
          <Key color={reach.frontierRing} label="frontier" ring />
        )}
        {settings.ghost && <Key color={reach.ghostRing} label="ghost" ring />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 5 },
  contestRow: { gap: 3 },
  ramp: { flexDirection: 'row', gap: 2 },
  rampCell: { flex: 1, alignItems: 'center', gap: 1 },
  swatch: {
    width: '100%',
    height: 12,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: board.lightTile,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSoft,
  },
  swatchWash: { ...StyleSheet.absoluteFill },
  rampNumber: { color: colors.textFaint, fontSize: 7, fontWeight: '800' },
  notation: { color: colors.textMuted, fontSize: 8, lineHeight: 12 },
  notationStrong: { color: colors.textSoft, fontWeight: '900' },
  keys: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 9 },
  keysLabel: { color: colors.textFaint, fontSize: 7, fontWeight: '900', letterSpacing: 1 },
  keyItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  keySwatch: { width: 11, height: 11, borderRadius: radius.small - 3 },
  keyLabel: { color: colors.textMuted, fontSize: 8, fontWeight: '700' },
});
