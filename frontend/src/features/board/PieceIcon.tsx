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
import { players, shadows } from '@/theme';
import type { Piece, PlayerColor, SideColor } from '@/types/game';

// Static requires so Metro bundles the artwork; a dynamic path would not resolve.
//
// Keyed by the artwork's own name rather than by a kind, because the two are not
// the same thing: `art` is a spec field, so a mode may call its rock a Boulder
// and still draw it as a rock. The built-in kinds are named after their artwork,
// which is why looking a kind's id up in here works for them.
//
// Four tiers now, in the order `artworkFor` tries them:
//
//  1. An uploaded picture, when `art` is an `img:` reference. Drawn inside a
//     ring in the side's colour — see `SideDisc` — because a mode uploads *one*
//     drawing per kind and something still has to say whose piece it is.
//  2. Bundled artwork the mode named. Already drawn per side, so no ring.
//  3. Bundled artwork matching the kind's id, which is how the built-ins work
//     with no `pieceLooks` at all.
//  4. The letter disc.
//
// The last tier is the one that matters most, and it catches the uploaded case
// too: a picture that has been taken down, or that the network will not produce,
// falls all the way back to a letter rather than to a hole.
const SOURCES: Record<SideColor, Record<string, ImageSourcePropType | undefined>> = {
  Blue: {
    rock: require('../../../assets/pieces/blue_rock.png'),
    paper: require('../../../assets/pieces/blue_paper.png'),
    scissors: require('../../../assets/pieces/blue_scissors.png'),
  },
  Red: {
    rock: require('../../../assets/pieces/red_rock.png'),
    paper: require('../../../assets/pieces/red_paper.png'),
    scissors: require('../../../assets/pieces/red_scissors.png'),
  },
};

/**
 * The artwork for a kind, or nothing, and whether it needs a ring behind it.
 *
 * What the mode said first, then the kind's own name for the built-ins, whose
 * ids *are* the artwork names. Deliberately in that order: a mode that renames
 * Rock to Boulder and declares `art: "rock"` is telling us exactly what to draw,
 * and a mode that declares nothing is telling us to work it out.
 */
interface Artwork {
  source: ImageSourcePropType;
  /** Whether the side's ring has to be drawn behind it. */
  overRing: boolean;
}

const artworkFor = (color: SideColor, piece: string, art: string | undefined): Artwork | null => {
  const bundled = SOURCES[color][art ?? ''] ?? SOURCES[color][piece.toLowerCase()];
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

const pieceShadow = shadows.piece[0];
if (!pieceShadow) throw new Error('The piece shadow recipe is missing.');
const shadowPadding = Math.ceil(
  pieceShadow.blurRadius * 3 +
    Math.max(Math.abs(pieceShadow.offsetX), Math.abs(pieceShadow.offsetY)),
);
const supportsAndroidDropShadow =
  Platform.OS === 'android' && Number(Platform.Version) >= 31;

const alphaMaskShadow = Platform.select<ViewStyle | null>({
  web: {
    filter: `drop-shadow(${pieceShadow.offsetX}px ${pieceShadow.offsetY}px ${pieceShadow.blurRadius}px ${pieceShadow.color})`,
  },
  android: supportsAndroidDropShadow
    ? {
        filter: [
          {
            dropShadow: {
              offsetX: pieceShadow.offsetX,
              offsetY: pieceShadow.offsetY,
              standardDeviation: pieceShadow.blurRadius,
              color: pieceShadow.color,
            },
          },
        ],
      }
    : null,
  default: null,
});

const iosAlphaMaskShadow: ImageStyle | null = Platform.OS === 'ios'
  ? {
      shadowColor: pieceShadow.color,
      shadowOffset: { width: pieceShadow.offsetX, height: pieceShadow.offsetY },
      shadowOpacity: 1,
      shadowRadius: pieceShadow.blurRadius,
    }
  : null;

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

  if (color !== 'Red' && color !== 'Blue') return null;
  if (!piece || piece === 'Empty') return null;
  const artwork = artworkFor(color, piece, look?.art);
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

  if (dropShadow) {
    const shadowCanvas = {
      height: size + shadowPadding * 2,
      left: -shadowPadding,
      top: -shadowPadding,
      width: size + shadowPadding * 2,
    };

    return (
      <View pointerEvents="none" style={[styles.shadowSlot, dimensions]}>
        <View style={[styles.shadowCanvas, shadowCanvas, alphaMaskShadow]}>
          {!alphaMaskShadow && Platform.OS === 'android' ? (
            <View
              style={[
                styles.legacyAndroidShadow,
                {
                  height: Math.max(4, size * 0.16),
                  left: shadowPadding + size * 0.11,
                  top: shadowPadding + size * 0.75 + pieceShadow.offsetY,
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
                iosAlphaMaskShadow,
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

const styles = StyleSheet.create({
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
    backgroundColor: pieceShadow.color,
  },
  letterPiece: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  letterPieceText: { fontWeight: '900' },
});
