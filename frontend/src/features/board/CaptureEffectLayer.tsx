import { memo, useEffect, useMemo, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import {
  CAPTURE_EFFECT_DURATION,
  CHOREOGRAPHY,
  keyframesFor,
  type AccentMotion,
  type Keyframes,
  type VictimMotion,
} from './captureEffect';
import PieceIcon from './PieceIcon';
import type { PieceLook } from './pieceLook';
import type { Capture, CaptureMatchup } from '@/engine/captureMatchup';
import { board, themedSheet } from '@/theme';

// The capture effect, drawn. What plays and when is decided in
// `./captureEffect.ts`; this file only turns that recipe into views.
//
// Plain views throughout, and no <Svg>: an Svg laid over the board claims every
// touch inside its box on iOS's new architecture whatever it is told, and this
// is drawn over the very squares the next move is played on. Every layer is a
// view that is inert in its style as well, so nothing here is ever hit-tested.
//
// Every style below is fixed for the life of an effect. An effect is a new
// mount, keyed by the move that made it, and nothing about it is restyled while
// it plays: on iOS, restyling a view mid-way through an animation the native
// driver is running can leave it stranded at the animation's first frame.

/** One capture effect, from the move that made it to the end of its clock. */
export interface CaptureEffectState {
  /** The board's own key for the move, which the effect lives and dies by. */
  key: string;
  matchup: CaptureMatchup;
  capture: Capture;
  /** When the taker meets its victim, in milliseconds from the start of the move. */
  impactMs: number;
  /**
   * Milliseconds since the move began, run on the native thread. Shared with
   * the board's moving piece, which draws the taker's half of the recipe.
   */
  clock: Animated.Value;
}

/** A value along an effect's clock, from a recipe's keyframes, at this move's meeting. */
export const along = (
  { clock, impactMs }: Pick<CaptureEffectState, 'clock' | 'impactMs'>,
  frames: Keyframes,
  scaleBy = 1,
): Animated.AnimatedInterpolation<number> => {
  const { times, values } = keyframesFor(frames, impactMs);
  return clock.interpolate({
    inputRange: times,
    outputRange: values.map((value) => value * scaleBy),
    extrapolate: 'clamp',
  });
};

/** The same, as a turn: `frames` run 0 to 1 and `degrees` is the whole turn. */
const turning = (
  { clock, impactMs }: Pick<CaptureEffectState, 'clock' | 'impactMs'>,
  frames: Keyframes,
  degrees: number,
  from = 0,
): Animated.AnimatedInterpolation<string> => {
  const { times, values } = keyframesFor(frames, impactMs);
  return clock.interpolate({
    inputRange: times,
    outputRange: values.map((value) => `${from + value * degrees}deg`),
    extrapolate: 'clamp',
  });
};

/**
 * Runs an effect's clock from the start of its move to its end, then says so.
 *
 * Started from the same commit as the move animation it rides on, so the two
 * clocks set off together.
 */
export const useCaptureEffectClock = (
  effect: CaptureEffectState | null,
  onComplete: (key: string) => void,
) => {
  useEffect(() => {
    if (!effect) return undefined;
    const animation = Animated.timing(effect.clock, {
      toValue: CAPTURE_EFFECT_DURATION,
      duration: CAPTURE_EFFECT_DURATION,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) onComplete(effect.key);
    });
    return () => animation.stop();
  }, [effect, onComplete]);
};

/** The square the capture happened on, and the board it is on, in pixels. */
interface EffectGeometry {
  /** The capture square's top left corner, from the board surface's. */
  left: number;
  top: number;
  squareSize: number;
  pieceSize: number;
  /** The way the taker travelled, on screen, as a unit vector. */
  headingX: number;
  headingY: number;
}

interface CaptureEffectLayerProps extends EffectGeometry {
  effect: CaptureEffectState;
  /**
   * Beneath the pieces — the piece that fell, the dust and the air — or above
   * them: the cut, which is drawn over the taker.
   */
  layer: 'beneath' | 'above';
  victimLook?: PieceLook;
}

/**
 * One of the effect's two layers.
 *
 * Two because the effect lives on both sides of the taker: what is left of the
 * victim belongs under the piece that took it, and the cut belongs over it. The
 * board places them either side of its pieces; both read the one clock.
 */
const CaptureEffectLayer = memo(function CaptureEffectLayer({
  effect,
  layer,
  victimLook,
  ...geometry
}: CaptureEffectLayerProps) {
  const { victim, accent } = CHOREOGRAPHY[effect.matchup];
  // Only the cut is drawn over the taker; the dust and the air come out from
  // under it.
  const accentBeneath = accent.kind !== 'cut';
  if (layer === 'above' && accentBeneath) return null;

  return (
    <View style={layer === 'beneath' ? styles.beneath : styles.above}>
      {layer === 'beneath' ? (
        <>
          {accentBeneath ? <Accent accent={accent} effect={effect} {...geometry} /> : null}
          <Victim effect={effect} look={victimLook} motion={victim} {...geometry} />
        </>
      ) : (
        <Accent accent={accent} effect={effect} {...geometry} />
      )}
    </View>
  );
});

export default CaptureEffectLayer;

interface VictimProps extends EffectGeometry {
  effect: CaptureEffectState;
  look?: PieceLook;
  motion: VictimMotion;
}

/** The piece that fell, drawn from its own artwork so every piece set breaks the same way. */
function Victim({ effect, look, motion, ...geometry }: VictimProps) {
  const { victim } = effect.capture;
  const icon = (
    <PieceIcon color={victim.color} look={look} piece={victim.piece} size={geometry.pieceSize} />
  );
  if (motion.kind === 'shatter') {
    return <Shatter effect={effect} icon={icon} motion={motion} {...geometry} />;
  }
  if (motion.kind === 'split') {
    return <Split effect={effect} icon={icon} motion={motion} {...geometry} />;
  }
  return <Swallow effect={effect} icon={icon} motion={motion} {...geometry} />;
}

const QUADRANTS = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;

/**
 * How far each window onto the piece reaches past its edge into its
 * neighbour's, in pixels. Two clipped edges that meet exactly leave a hairline
 * of the square showing between them wherever the line falls between device
 * pixels, so a piece that has not come apart yet would already look cut.
 */
const SEAM_OVERLAP = 1;

/** Rock on scissors: the piece in four, thrown out along the diagonals. */
function Shatter({
  effect,
  icon,
  motion,
  left,
  top,
  squareSize,
  pieceSize,
}: EffectGeometry & {
  effect: CaptureEffectState;
  icon: ReactNode;
  motion: Extract<VictimMotion, { kind: 'shatter' }>;
}) {
  const inset = (squareSize - pieceSize) / 2;
  const half = pieceSize / 2;
  const reach = motion.drift * squareSize * Math.SQRT1_2;
  const pieces = useMemo(
    () =>
      QUADRANTS.map(([column, row]) => {
        const across = column ? 1 : -1;
        const down = row ? 1 : -1;
        // Where this window starts across the piece: the right and bottom
        // quarters reach back over the middle by the overlap.
        const windowLeft = column ? half - SEAM_OVERLAP : 0;
        const windowTop = row ? half - SEAM_OVERLAP : 0;
        return {
          column,
          row,
          artwork: { left: -windowLeft, top: -windowTop },
          style: {
            left: left + inset + windowLeft,
            top: top + inset + windowTop,
            width: half + SEAM_OVERLAP,
            height: half + SEAM_OVERLAP,
            opacity: along(effect, motion.opacity),
            transform: [
              { translateX: along(effect, motion.travel, across * reach) },
              { translateY: along(effect, motion.travel, down * reach) },
              // Neighbours turn opposite ways, so the four read as thrown apart
              // rather than as one piece rotating.
              { rotate: turning(effect, motion.travel, motion.spin * across * down) },
              { scale: along(effect, motion.scale) },
            ],
          },
        };
      }),
    [effect, half, inset, left, motion, reach, top],
  );

  return pieces.map(({ artwork, column, row, style }) => (
    <Animated.View key={`${column}${row}`} style={[styles.clip, style]}>
      <View style={[styles.artwork, artwork]}>{icon}</View>
    </Animated.View>
  ));
}

/** Scissors on paper: the piece cut in two along the scissors' path. */
function Split({
  effect,
  icon,
  motion,
  left,
  top,
  squareSize,
  pieceSize,
  headingX,
  headingY,
}: EffectGeometry & {
  effect: CaptureEffectState;
  icon: ReactNode;
  motion: Extract<VictimMotion, { kind: 'split' }>;
}) {
  // Each half is the piece seen through a window laid along the cut, so the
  // window is turned to the cut and the artwork inside is turned back. Long
  // enough along the cut and deep enough across it to hold half of the piece
  // at any angle, and reaching just over the cut into the other half's window.
  const width = pieceSize * 1.5;
  const depth = pieceSize * 0.75;
  const height = depth + SEAM_OVERLAP;
  const angle = Math.atan2(headingY, headingX);
  const degrees = (angle * 180) / Math.PI;
  const centreX = left + squareSize / 2;
  const centreY = top + squareSize / 2;
  const parting = motion.parting * squareSize;

  const halves = useMemo(
    () =>
      ([-1, 1] as const).map((side) => {
        // Off the cut, towards this half's side of it.
        const awayX = -side * Math.sin(angle);
        const awayY = side * Math.cos(angle);
        return {
          side,
          style: {
            left: centreX + (awayX * (depth - SEAM_OVERLAP)) / 2 - width / 2,
            top: centreY + (awayY * (depth - SEAM_OVERLAP)) / 2 - height / 2,
            width,
            height,
            opacity: along(effect, motion.opacity),
            transform: [
              { translateX: along(effect, motion.travel, awayX * parting) },
              { translateY: along(effect, motion.travel, awayY * parting) },
              { rotate: turning(effect, motion.travel, motion.tilt * side, degrees) },
            ],
          },
          // Where the piece's middle sits inside this half's window: on the
          // cut, which is the window's edge nearest the other half less the
          // overlap.
          artwork: {
            left: width / 2 - pieceSize / 2,
            top: (side < 0 ? depth : SEAM_OVERLAP) - pieceSize / 2,
            transform: [{ rotate: `${-degrees}deg` }],
          },
        };
      }),
    [angle, centreX, centreY, degrees, depth, effect, height, motion, parting, pieceSize, width],
  );

  return halves.map(({ side, style, artwork }) => (
    <Animated.View key={side} style={[styles.clip, style]}>
      <View style={[styles.artwork, artwork]}>{icon}</View>
    </Animated.View>
  ));
}

/** Paper on rock: the piece shrinks away under the sheet that landed on it. */
function Swallow({
  effect,
  icon,
  motion,
  left,
  top,
  squareSize,
  pieceSize,
}: EffectGeometry & {
  effect: CaptureEffectState;
  icon: ReactNode;
  motion: Extract<VictimMotion, { kind: 'swallow' }>;
}) {
  const inset = (squareSize - pieceSize) / 2;
  const style = useMemo(
    () => ({
      left: left + inset,
      top: top + inset,
      width: pieceSize,
      height: pieceSize,
      opacity: along(effect, motion.opacity),
      transform: [{ scale: along(effect, motion.scale) }],
    }),
    [effect, inset, left, motion, pieceSize, top],
  );
  return <Animated.View style={[styles.piece, style]}>{icon}</Animated.View>;
}

/**
 * The dust, the cut or the air. The ring and the cut are the board's paper
 * edged in its ink, so they separate from either colour of square; the air is
 * the paper alone, and faint.
 */
function Accent({
  accent,
  effect,
  left,
  top,
  squareSize,
  headingX,
  headingY,
}: EffectGeometry & { accent: AccentMotion; effect: CaptureEffectState }) {
  const stroke = Math.max(2, Math.round(squareSize * 0.05));
  const centreX = left + squareSize / 2;
  const centreY = top + squareSize / 2;

  const frame = useMemo(() => {
    if (accent.kind === 'cut') {
      const length = accent.length * squareSize;
      const thickness = stroke + 2;
      const degrees = (Math.atan2(headingY, headingX) * 180) / Math.PI;
      return {
        style: {
          left: centreX - length / 2,
          top: centreY - thickness / 2,
          width: length,
          height: thickness,
          borderRadius: thickness / 2,
          opacity: along(effect, accent.opacity),
          // Turned to the path first, then drawn out along it.
          transform: [{ rotate: `${degrees}deg` }, { scaleX: along(effect, accent.reach) }],
        },
        inner: { borderRadius: stroke / 2 },
      };
    }
    const round = {
      left,
      top,
      width: squareSize,
      height: squareSize,
      borderRadius: squareSize / 2,
      opacity: along(effect, accent.opacity),
      transform: [{ scale: along(effect, accent.scale) }],
    };
    if (accent.kind === 'puff') return { style: round, inner: null };
    return {
      style: { ...round, borderWidth: 1 },
      inner: { borderRadius: squareSize / 2 - 1, borderWidth: stroke },
    };
  }, [accent, centreX, centreY, effect, headingX, headingY, left, squareSize, stroke, top]);

  const outer = { cut: styles.cut, ring: styles.ring, puff: styles.puff }[accent.kind];
  return (
    <Animated.View style={[outer, frame.style]}>
      {frame.inner ? (
        <View style={[accent.kind === 'cut' ? styles.cutStroke : styles.ringStroke, frame.inner]} />
      ) : null}
    </Animated.View>
  );
}

const styles = themedSheet(() => ({
  // The two layers, either side of the board's settled pieces (3) and the one
  // in motion (6). Inert in their style, so neither is ever hit-tested.
  beneath: { ...StyleSheet.absoluteFill, zIndex: 3, pointerEvents: 'none' },
  above: { ...StyleSheet.absoluteFill, zIndex: 6, pointerEvents: 'none' },
  clip: { position: 'absolute', overflow: 'hidden' },
  artwork: { position: 'absolute' },
  piece: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  // The edge is the outer view's own border or fill, and the paper stroke sits
  // inside it, a pixel in from each side.
  ring: { position: 'absolute', borderColor: board.captureEdge },
  ringStroke: { ...StyleSheet.absoluteFill, borderColor: board.captureStroke },
  puff: { position: 'absolute', backgroundColor: board.captureStroke },
  cut: { position: 'absolute', backgroundColor: board.captureEdge },
  cutStroke: {
    position: 'absolute',
    top: 1,
    right: 1,
    bottom: 1,
    left: 1,
    backgroundColor: board.captureStroke,
  },
}));
