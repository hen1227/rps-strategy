import { useState, type ReactNode } from 'react';
import {
  Image,
  Platform,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
  type ImageStyle,
  type ViewStyle,
} from 'react-native';

import type { PieceLook } from './pieceLook';
import { pieceSetById, type PieceSet } from '@/appearance/pieceSets';
import { useAppearanceStore } from '@/appearance/store';
import { players, shadows, themedSheet } from '@/theme';
import type { Piece, PlayerColor, SideColor } from '@/types/game';

// Which artwork a piece is drawn from, and in what order it is looked for.
//
// The catalogue itself is `@/appearance/pieceSets` — data, and static `require`s,
// because Metro cannot resolve a dynamic path. That constraint is why the sets
// are curated rather than open: a set has to be in the bundle.
//
// Three tiers, in the order `artworkFor` tries them:
//
//  1. Bundled artwork the *mode* named, in the chosen set. `art` is a spec
//     field, so a mode may call its rock a Boulder and still draw it as a rock.
//  2. Artwork matching the kind's id, which is how the built-ins work with no
//     `pieceLooks` at all — their ids *are* the artwork names.
//  3. The letter disc.
//
// The last tier is the one that matters most: a picture that will not load
// falls all the way back to a letter rather than to a hole.

/** The artwork for a kind, or nothing, and whether it needs a ring behind it. */
interface Artwork {
  source: ImageSourcePropType;
  /** Whether the side's ring has to be drawn behind it. */
  overRing: boolean;
}

const artworkFor = (
  set: PieceSet,
  color: SideColor,
  piece: string,
  art: string | undefined,
): Artwork | null => {
  const bundled = set.raster[color][art ?? ''] ?? set.raster[color][piece.toLowerCase()];
  return bundled ? { source: bundled, overRing: false } : null;
};

/**
 * A source as a string, for comparing one render's to the last one's.
 *
 * A bundled `require` is a stable value — a number on native, a string or a
 * frozen object on web — so identity worked for it. A remote source is
 * `{ uri }`, built fresh every render, and identity on that is never equal: the
 * failed-artwork check below would never match, `onError` would fire again, and
 * a picture that 404s would retry for as long as the board is on screen. So the
 * comparison is on the value, not on the object.
 */
const sourceKey = (source: ImageSourcePropType): string =>
  typeof source === 'object' && source !== null && 'uri' in source
    ? String((source as { uri?: unknown }).uri)
    : String(source);

// The piece's drop shadow, split into the half that can move and the half that
// cannot.
//
// A theme may recolour the shadow — it is the scrim at 58% — but nothing here
// sets its geometry, which `buildTheme` fixes for every preset. So the padding
// the canvas needs is a constant, and the three style objects that carry the
// colour are built per render instead of once at import. Held as constants they
// would keep the first theme's shadow for the life of the app, on every piece
// on every board.
const shadowGeometry = shadows.piece[0];
if (!shadowGeometry) throw new Error('The piece shadow recipe is missing.');
const shadowPadding = Math.ceil(
  shadowGeometry.blurRadius * 3 +
    Math.max(Math.abs(shadowGeometry.offsetX), Math.abs(shadowGeometry.offsetY)),
);
const supportsAndroidDropShadow =
  Platform.OS === 'android' && Number(Platform.Version) >= 31;

/** The current recipe, colour included. */
const pieceShadow = () => shadows.piece[0] ?? shadowGeometry;

const alphaMaskShadow = (): ViewStyle | null => {
  const shadow = pieceShadow();
  return Platform.select<ViewStyle | null>({
    web: {
      filter: `drop-shadow(${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blurRadius}px ${shadow.color})`,
    },
    android: supportsAndroidDropShadow
      ? {
          filter: [
            {
              dropShadow: {
                offsetX: shadow.offsetX,
                offsetY: shadow.offsetY,
                standardDeviation: shadow.blurRadius,
                color: shadow.color,
              },
            },
          ],
        }
      : null,
    default: null,
  });
};

const iosAlphaMaskShadow = (): ImageStyle | null => {
  const shadow = pieceShadow();
  return Platform.OS === 'ios'
    ? {
        shadowColor: shadow.color,
        shadowOffset: { width: shadow.offsetX, height: shadow.offsetY },
        shadowOpacity: 1,
        shadowRadius: shadow.blurRadius,
      }
    : null;
};

export interface PieceIconProps {
  piece: Piece | undefined;
  color: PlayerColor | undefined;
  /**
   * How this kind is drawn, for a mode that declared its own kinds.
   *
   * `art` names the bundled artwork to borrow; `symbol` is the letter to fall
   * back to without one. The mode's own symbol, not the kind's initial: symbols
   * are unique within a mode and initials are not, so a Menagerie drawing Spock
   * from its initial would put an `S` next to Scissors' `S`.
   */
  look?: PieceLook;
  /** Lift the piece off the board while it is being dragged. */
  dropShadow?: boolean;
  /**
   * That this piece is one that *can* be lifted, whether or not it is being
   * lifted right now.
   *
   * Separate from `dropShadow` because the shadow is drawn on a canvas around
   * the artwork, and growing that canvas when the drag starts means swapping
   * one tree for another under React — which throws the `Image` away and mounts
   * a new one. A new image view on a phone paints nothing until the picture is
   * handed back to it, so every tap on a piece blinked it out and back twice:
   * once on the touch, once on the release. Told in advance, the canvas is
   * already there and turning the shadow on is a change of style.
   *
   * Only the board's own pieces pass it. Everything else here — the capture
   * tray, the mini boards, the how-to-play diagram — never lifts a piece, and
   * would be paying two extra views apiece for a shadow it cannot draw.
   */
  liftable?: boolean;
  size?: number;
}

/**
 * A piece with no bundled artwork: a filled disc carrying its initial, in the
 * side's own colour.
 *
 * Deliberately plain. It has to read at 20 points on a phone board and it has to
 * be obviously a piece rather than a decoration, and anything more elaborate
 * would be inventing a look for a kind whose author already told us what it is
 * called.
 */
function SideDisc({
  color,
  size,
  filled,
  children,
}: {
  color: SideColor;
  size: number;
  /** Filled for a letter, hollow for a picture drawn inside it. */
  filled: boolean;
  children?: ReactNode;
}) {
  const palette = players[color];
  return (
    <View
      style={[
        styles.letterPiece,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: filled ? palette.strong : 'transparent',
          borderColor: palette.border,
        },
      ]}
    >
      {children}
    </View>
  );
}

function LetterPiece({ letter, color, size }: { letter: string; color: SideColor; size: number }) {
  const palette = players[color];
  return (
    <SideDisc color={color} size={size} filled>
      <Text style={[styles.letterPieceText, { color: palette.contrast, fontSize: size * 0.56 }]}>
        {letter}
      </Text>
    </SideDisc>
  );
}

export default function PieceIcon({
  piece,
  color,
  look,
  dropShadow = false,
  liftable = false,
  size = 28,
}: PieceIconProps) {
  // Artwork that will not load draws as its letter rather than as nothing.
  //
  // Not defensiveness for its own sake: an `Image` whose source fails paints an
  // empty square, and eighteen empty squares on a board that is otherwise
  // working reads as a broken renderer rather than as a missing file. The Lab
  // found this the hard way — the pieces vanished and everything else, move
  // dots included, kept working.
  //
  // Keyed by the source so a piece that failed once tries again for a different
  // picture, which is what happens when a mode's `art` changes under it.
  const [failed, setFailed] = useState<string | null>(null);
  // Read here rather than threaded down as a prop: four of this component's six
  // call sites do not go through the board at all — the capture tray, the
  // how-to-play diagram, the reach summary, the position editor — so a prop
  // would reach two of them and quietly leave the other four on the old set.
  const setId = useAppearanceStore((state) => state.appearance.pieces);

  if (color !== 'Red' && color !== 'Blue') return null;
  if (!piece || piece === 'Empty') return null;
  const artwork = artworkFor(pieceSetById(setId), color, piece, look?.art);
  if (!artwork || sourceKey(artwork.source) === failed) {
    const letter = (look?.symbol ?? piece.charAt(0)).toUpperCase();
    return <LetterPiece letter={letter} color={color} size={size} />;
  }
  const { source, overRing } = artwork;
  const onError = () => setFailed(sourceKey(source));
  const dimensions = { width: size, height: size };

  // An uploaded picture is one drawing for both sides, so the ring is what says
  // whose it is. Inset, because a picture that covered the rim would take the
  // ring's only job away from it.
  const drawn = overRing ? (
    <SideDisc color={color} size={size} filled={false}>
      <Image
        accessibilityIgnoresInvertColors
        onError={onError}
        resizeMode="contain"
        source={source}
        style={{ width: size * 0.74, height: size * 0.74 }}
      />
    </SideDisc>
  ) : null;

  // The canvas the shadow is drawn on, which a piece that can be lifted keeps
  // whether or not it is lifted right now.
  //
  // Only the styles below change when the drag starts: the canvas is already
  // the larger size, the `Image` inside it is already where it will stay, and
  // all that arrives is the shadow itself. That is the whole point of
  // `liftable` — see the prop. The canvas costs two views, so a caller that
  // never lifts anything skips it entirely and draws the bare image below.
  if (dropShadow || liftable) {
    const maskShadow = dropShadow ? alphaMaskShadow() : null;
    const shadowCanvas = {
      height: size + shadowPadding * 2,
      left: -shadowPadding,
      top: -shadowPadding,
      width: size + shadowPadding * 2,
    };

    return (
      <View pointerEvents="none" style={[styles.shadowSlot, dimensions]}>
        <View style={[styles.shadowCanvas, shadowCanvas, maskShadow]}>
          {/*
            The blurless stand-in for Android before 12, which has no drop
            shadow filter to apply above. A slot rather than a bare `&&`, so
            that the image below keeps its place in the children list when this
            comes and goes — a sibling that changes the index of the `Image` is
            the same remount this whole branch exists to avoid.
          */}
          {dropShadow && !maskShadow && Platform.OS === 'android' ? (
            <View
              style={[
                styles.legacyAndroidShadow,
                {
                  height: Math.max(4, size * 0.16),
                  left: shadowPadding + size * 0.11,
                  top: shadowPadding + size * 0.75 + pieceShadow().offsetY,
                  width: size * 0.78,
                },
              ]}
            />
          ) : null}
          {drawn ? (
            <View
              style={[styles.shadowedImage, dimensions, { left: shadowPadding, top: shadowPadding }]}
            >
              {drawn}
            </View>
          ) : (
            <Image
              accessibilityIgnoresInvertColors
              onError={onError}
              resizeMode="contain"
              source={source}
              style={[
                dimensions,
                styles.shadowedImage,
                { left: shadowPadding, top: shadowPadding },
                dropShadow ? iosAlphaMaskShadow() : null,
              ]}
            />
          )}
        </View>
      </View>
    );
  }

  if (drawn) return drawn;

  return (
    <Image
      accessibilityIgnoresInvertColors
      onError={onError}
      resizeMode="contain"
      source={source}
      style={dimensions}
    />
  );
}

const styles = themedSheet(() => ({
  shadowSlot: {
    overflow: 'visible',
  },
  shadowCanvas: {
    position: 'absolute',
    overflow: 'visible',
  },
  shadowedImage: {
    position: 'absolute',
  },
  legacyAndroidShadow: {
    position: 'absolute',
    borderRadius: 999,
    backgroundColor: pieceShadow().color,
  },
  letterPiece: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  letterPieceText: { fontWeight: '900' },
}));
