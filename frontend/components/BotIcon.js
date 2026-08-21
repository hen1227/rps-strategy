import { Image } from 'react-native';

// Static requires keep every portrait available to Metro on web and native.
const SOURCES = {
  pebble: require('../assets/bots/pebble.png'),
  napkin: require('../assets/bots/napkin.png'),
  snips: require('../assets/bots/snips.png'),
  boulder: require('../assets/bots/boulder.png'),
  crane: require('../assets/bots/crane.png'),
  obsidian: require('../assets/bots/obsidian.png'),
};

export default function BotIcon({ profileId, size = 52 }) {
  const source = SOURCES[profileId];
  if (!source) return null;

  return (
    <Image
      accessible={false}
      accessibilityIgnoresInvertColors
      resizeMode="contain"
      source={source}
      style={{ width: size, height: size }}
    />
  );
}
