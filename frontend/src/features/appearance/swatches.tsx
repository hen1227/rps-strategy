import { Image, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { pieceSetById, type PieceSet } from '@/appearance/pieceSets';
import { SOUND_WAVEFORMS } from '@/appearance/soundWaveforms';
import { boardById, buildTheme, type BoardSpec, type ThemeSpec } from '@/theme';

// The little drawings inside the picker chips.
//
// Each one is built from the preset it stands for rather than from the theme
// that happens to be showing, which is the whole point: a player choosing
// Parchment should see Parchment in the chip, not Parchment's name written in
// Forest's colours. `buildTheme` is called per chip for that — five themes by
// one board is nothing, and it means a swatch cannot drift from what picking it
// actually does.

const THEME_SWATCH = 52;

/**
 * A theme, as the four things a player will notice first: the page, a card on
 * it, the accent, and the two sides.
 */
export function ThemeSwatch({ spec }: { spec: ThemeSpec }) {
  const tokens = buildTheme(spec, boardById('forest'));
  return (
    <View
      style={{
        width: 96,
        height: THEME_SWATCH,
        borderRadius: 8,
        overflow: 'hidden',
        backgroundColor: tokens.colors.background,
        borderWidth: 1,
        borderColor: tokens.colors.border,
        padding: 6,
        gap: 4,
      }}
    >
      <View
        style={{
          height: 14,
          borderRadius: 4,
          backgroundColor: tokens.colors.surface,
          borderWidth: 1,
          borderColor: tokens.colors.borderSoft,
        }}
      />
      <View style={{ flexDirection: 'row', gap: 4 }}>
        <View style={{ flex: 2, height: 12, borderRadius: 3, backgroundColor: tokens.colors.accent }} />
        <View
          style={{ flex: 1, height: 12, borderRadius: 3, backgroundColor: tokens.players.Red.strong }}
        />
        <View
          style={{ flex: 1, height: 12, borderRadius: 3, backgroundColor: tokens.players.Blue.strong }}
        />
      </View>
    </View>
  );
}

/** A board, as four of its squares and the frame around them. */
export function BoardSwatch({ spec }: { spec: BoardSpec }) {
  const cell = 22;
  const squares = [
    [spec.lightTile, spec.darkTile],
    [spec.darkTile, spec.lightTile],
  ];
  return (
    <View
      style={{
        padding: 4,
        borderRadius: 8,
        backgroundColor: spec.frame,
      }}
    >
      {squares.map((row, y) => (
        <View key={y} style={{ flexDirection: 'row' }}>
          {row.map((tile, x) => (
            <View key={x} style={{ width: cell, height: cell, backgroundColor: tile }} />
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * A piece set, as one piece per side.
 *
 * Drawn with a plain `Image` rather than through `PieceIcon`, because
 * `PieceIcon` draws whichever set is *chosen* and this chip has to show the one
 * it is offering.
 */
export function PieceSwatch({ set }: { set: PieceSet }) {
  const resolved = pieceSetById(set.id);
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      <RasterPiece set={resolved} art="rock" color="Red" size={34} />
      <RasterPiece set={resolved} art="scissors" color="Blue" size={34} />
    </View>
  );
}

function RasterPiece({
  set,
  art,
  color,
  size,
}: {
  set: PieceSet;
  art: string;
  color: 'Red' | 'Blue';
  size: number;
}) {
  const source = set.raster[color][art];
  if (!source) return <View style={{ width: size, height: size }} />;
  return (
    <Image
      accessibilityIgnoresInvertColors
      resizeMode="contain"
      source={source}
      style={{ width: size, height: size }}
    />
  );
}

const SOUND_SWATCH_W = 96;
const SOUND_SWATCH_H = 48;
/** Half the height, less a margin, so a full-scale pack does not touch the edge. */
const SOUND_SWATCH_AMP = 20;

/**
 * One pack's move clip, drawn.
 *
 * A speaker icon is what this used to be, and with one audible pack it was
 * enough. With four it was the worst kind of preview: the same picture beside
 * every name, in a row whose entire job is to tell them apart. So the chip
 * draws the waveform of the clip that choosing it plays — see
 * `appearance/soundWaveforms.ts`, which the sound generator writes from the
 * rendered audio, so this cannot drift from what you actually hear.
 *
 * Both axes are shared across the packs, which is what makes the row readable
 * at a glance rather than merely decorated: Glass runs nearly the full width
 * because it rings for a third of a second, Wood is a stub because it does not,
 * and Felt is visibly *shorter* than the rest because it is genuinely quieter.
 *
 * The baseline is drawn first and full width, so the part of the window where a
 * pack has gone quiet still reads as time passing. Without it a short pack is a
 * small blob in the corner of an empty box, which looks like a drawing that
 * failed rather than like a sound that stopped — and Silent, whose waveform is
 * flat by definition, would have nothing to show at all.
 */
export function SoundSwatch({ packId, color }: { packId: string; color: string }) {
  const envelope = SOUND_WAVEFORMS[packId];
  return (
    <Svg height={SOUND_SWATCH_H} viewBox={`0 0 ${SOUND_SWATCH_W} ${SOUND_SWATCH_H}`} width={SOUND_SWATCH_W}>
      <Path
        d={`M0 ${SOUND_SWATCH_H / 2} H${SOUND_SWATCH_W}`}
        stroke={color}
        strokeLinecap="round"
        strokeOpacity={0.35}
        strokeWidth={1.5}
      />
      {envelope ? (
        <Path d={waveformPath(envelope)} fill={color} fillOpacity={0.85} />
      ) : null}
    </Svg>
  );
}

/**
 * The envelope as one closed shape, mirrored about the baseline.
 *
 * Mirrored because that is what a waveform looks like and so needs no learning;
 * a single-sided hump would read as a chart. Spanning `n - 1` steps rather than
 * `n` so the first sample sits on the left edge and the last on the right —
 * divide by `n` instead and the shape stops a bucket short of the box, which at
 * this size looks like a rendering bug.
 */
function waveformPath(envelope: readonly number[]): string {
  const step = SOUND_SWATCH_W / Math.max(1, envelope.length - 1);
  const mid = SOUND_SWATCH_H / 2;
  const x = (i: number) => (i * step).toFixed(2);
  const top = envelope.map((v, i) => `${x(i)} ${(mid - v * SOUND_SWATCH_AMP).toFixed(2)}`);
  const bottom = envelope
    .map((v, i) => `${x(i)} ${(mid + v * SOUND_SWATCH_AMP).toFixed(2)}`)
    .reverse();
  return `M${top.join(' L')} L${bottom.join(' L')} Z`;
}
