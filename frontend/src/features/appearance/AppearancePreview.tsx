import { useMemo } from 'react';
import { Text, View } from 'react-native';

import { gridFromRows } from '@/engine/analysisGame';
import MiniBoard from '@/features/board/MiniBoard';
import TitleTag from '@/ui/TitleTag';
import { Badge, GhostButton, Panel, PrimaryButton, SectionHeading } from '@/ui/primitives';
import { clock, colors, radius, space, themedSheet, type } from '@/theme';

// What the choices above actually do, on screen, while they are being made.
//
// Built out of the real components rather than out of coloured rectangles —
// `Panel`, `Badge`, `PrimaryButton`, `TitleTag`, and the same `MiniBoard` the
// lobby draws — because a preview assembled by hand is a second opinion about
// how this app looks, and the first thing it will do is go quietly out of date.
//
// It shows a board mid-game rather than a starting position, so the marks a
// theme moves are all on it at once: a last move, a capture, both sides'
// pieces, and the frame and squares underneath them.

const ROWS = [
  'R.P.S.P.R',
  '.S.R.....',
  '....p....',
  '.....s...',
  '...r.....',
  '.........',
  '.....p.s.',
  '.s.p.r...',
  'r.p.s.p.r',
];

/** The move drawn on the preview: a capture, so the destination gets its ring. */
const PREVIEW_MOVE = { from: { x: 4, y: 3 }, to: { x: 4, y: 2 } };

export default function AppearancePreview({ size = 190 }: { size?: number }) {
  const grid = useMemo(() => gridFromRows(ROWS), []);

  return (
    <Panel style={styles.panel}>
      <SectionHeading
        eyebrow="Preview"
        title="How it looks"
        trailing={<Badge label="Live" tone="live" />}
      />
      <View style={styles.body}>
        <MiniBoard capture grid={grid} modeId="V6" move={PREVIEW_MOVE} mover="Blue" size={size} />
        <View style={styles.sample}>
          <View style={styles.nameRow}>
            <TitleTag title="GM" />
            <Text style={styles.name}>Blue</Text>
            <View style={styles.clockActive}>
              <Text style={styles.clockActiveText}>2:41</Text>
            </View>
          </View>
          <View style={styles.nameRow}>
            <Text style={styles.name}>Red</Text>
            <View style={styles.clockIdle}>
              <Text style={styles.clockIdleText}>3:07</Text>
            </View>
          </View>

          <View style={styles.badges}>
            <Badge label="Ranked" tone="accent" />
            <Badge label="Champion" tone="gold" />
          </View>

          <Text style={styles.copy}>
            Preview your theme and board colours.
          </Text>

          <View style={styles.buttons}>
            <PrimaryButton label="Play" onPress={() => {}} />
            <GhostButton label="Resign" onPress={() => {}} />
          </View>
        </View>
      </View>
    </Panel>
  );
}

const styles = themedSheet(() => ({
  panel: { gap: space.medium },
  body: { flexDirection: 'row', flexWrap: 'wrap', gap: space.large, alignItems: 'flex-start' },
  sample: { flex: 1, minWidth: 190, gap: space.small },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  name: { ...type.rowTitle, color: colors.text, flex: 1 },
  clockActive: {
    paddingHorizontal: space.small,
    paddingVertical: space.tight,
    borderRadius: radius.small,
    backgroundColor: clock.activeSurface,
  },
  clockActiveText: { ...type.rowTitle, color: clock.activeText },
  clockIdle: {
    paddingHorizontal: space.small,
    paddingVertical: space.tight,
    borderRadius: radius.small,
    backgroundColor: clock.idleSurface,
  },
  clockIdleText: { ...type.rowTitle, color: clock.idleText },
  badges: { flexDirection: 'row', gap: space.snug },
  copy: { ...type.body, color: colors.textMuted },
  buttons: { flexDirection: 'row', gap: space.small, flexWrap: 'wrap' },
}));
