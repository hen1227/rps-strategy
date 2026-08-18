import Svg, { Circle, Path, Polygon } from 'react-native-svg';

export default function PieceIcon({ piece, color, size = 28 }) {
  const fill = color === 'Red' ? '#ff6b6b' : '#5aa9ff';
  const stroke = color === 'Red' ? '#ffd0d0' : '#d1e8ff';

  if (piece === 'Rock') {
    return (
      <Svg width={size} height={size} viewBox="0 0 32 32">
        <Polygon
          points="5,23 3,14 10,5 22,4 29,13 26,25 15,29"
          fill={fill}
          stroke={stroke}
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <Path d="M9 13L15 8L23 10L26 17L20 24L11 23L7 18Z" fill="none" stroke={stroke} />
      </Svg>
    );
  }

  if (piece === 'Paper') {
    return (
      <Svg width={size} height={size} viewBox="0 0 32 32">
        <Path
          d="M7 3H20L27 10V29H7Z"
          fill={fill}
          stroke={stroke}
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <Path d="M20 3V10H27M11 16H23M11 21H23" fill="none" stroke={stroke} strokeWidth="2" />
      </Svg>
    );
  }

  if (piece === 'Scissors') {
    return (
      <Svg width={size} height={size} viewBox="0 0 32 32">
        <Circle cx="9" cy="23" r="5" fill={fill} stroke={stroke} strokeWidth="2" />
        <Circle cx="23" cy="23" r="5" fill={fill} stroke={stroke} strokeWidth="2" />
        <Path d="M12 19L25 4M20 19L7 4" fill="none" stroke={stroke} strokeWidth="3" strokeLinecap="round" />
      </Svg>
    );
  }

  return null;
}
