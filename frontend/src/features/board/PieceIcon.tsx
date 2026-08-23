import { Image, Platform, StyleSheet, View, type ImageStyle, type ViewStyle } from 'react-native';

import { shadows } from '@/theme';
import type { Piece, PlayerColor } from '@/types/game';

// Static requires so Metro bundles the artwork; a dynamic path would not resolve.
const SOURCES = {
  Blue: {
    Rock: require('../../../assets/pieces/blue_rock.png'),
    Paper: require('../../../assets/pieces/blue_paper.png'),
    Scissors: require('../../../assets/pieces/blue_scissors.png'),
  },
  Red: {
    Rock: require('../../../assets/pieces/red_rock.png'),
    Paper: require('../../../assets/pieces/red_paper.png'),
    Scissors: require('../../../assets/pieces/red_scissors.png'),
  },
};

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
  /** Lift the piece off the board while it is being dragged. */
  dropShadow?: boolean;
  size?: number;
}

export default function PieceIcon({ piece, color, dropShadow = false, size = 28 }: PieceIconProps) {
  const source =
    color === 'Red' || color === 'Blue'
      ? piece === 'Rock' || piece === 'Paper' || piece === 'Scissors'
        ? SOURCES[color][piece]
        : null
      : null;
  if (!source) return null;
  const dimensions = { width: size, height: size };

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
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="contain"
            source={source}
            style={[
              dimensions,
              styles.shadowedImage,
              { left: shadowPadding, top: shadowPadding },
              iosAlphaMaskShadow,
            ]}
          />
        </View>
      </View>
    );
  }

  return (
    <Image
      accessibilityIgnoresInvertColors
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
});
