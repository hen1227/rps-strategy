import { Image } from 'react-native';

// Static requires so Metro bundles the artwork; a dynamic path would not resolve.
const SOURCES = {
  Blue: {
    Rock: require('../assets/pieces/blue_rock.png'),
    Paper: require('../assets/pieces/blue_paper.png'),
    Scissors: require('../assets/pieces/blue_scissors.png'),
  },
  Red: {
    Rock: require('../assets/pieces/red_rock.png'),
    Paper: require('../assets/pieces/red_paper.png'),
    Scissors: require('../assets/pieces/red_scissors.png'),
  },
};

export default function PieceIcon({ piece, color, size = 28 }) {
  const source = SOURCES[color]?.[piece];
  if (!source) return null;

  return (
    <Image
      source={source}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
    />
  );
}
