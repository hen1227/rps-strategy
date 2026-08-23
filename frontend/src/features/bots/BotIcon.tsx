import { Image, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/theme';

// Static requires keep every portrait available to Metro on web and native.
const SOURCES: Record<string, unknown> = {
  pebble: require('../../../assets/bots/pebble.png'),
  napkin: require('../../../assets/bots/napkin.png'),
  snips: require('../../../assets/bots/snips.png'),
  boulder: require('../../../assets/bots/boulder.png'),
  crane: require('../../../assets/bots/crane.png'),
  obsidian: require('../../../assets/bots/obsidian.png'),
};

// Hues for the monogram fallback, spread far enough apart that two bots in the
// same list are easy to tell apart at a glance.
const HUES = ['#5b8266', '#7a5c9e', '#b5763f', '#3f7b91', '#9e5c6b', '#6b7a3f'];

/** A stable colour per name, so a given bot always looks the same. */
const hueFor = (seed: string) => {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100003;
  }
  return HUES[hash % HUES.length];
};

const monogramOf = (name: string) => {
  const letters = name.replace(/[^A-Za-z0-9]/g, '');
  return (letters.slice(0, 2) || '??').toUpperCase();
};

/**
 * A bot's portrait.
 *
 * The six built-in browser bots have drawn ones. An engine somebody connected
 * from their own machine has no artwork and never will, so it gets a monogram
 * rather than the blank square this component used to return.
 */
export interface BotIconProps {
  /** One of the six built-in bots, which have drawn portraits. */
  profileId?: string;
  /** A connected engine's name, used for the monogram fallback. */
  name?: string;
  size?: number;
}

export default function BotIcon({ profileId, name, size = 52 }: BotIconProps) {
  const source = profileId ? SOURCES[profileId] : undefined;
  if (source) {
    return (
      <Image
        accessible={false}
        accessibilityIgnoresInvertColors
        resizeMode="contain"
        source={source as never}
        style={{ width: size, height: size }}
      />
    );
  }

  const label = name ?? profileId;
  if (!label) return null;
  return (
    <View
      accessible={false}
      style={[
        styles.monogram,
        {
          width: size,
          height: size,
          borderRadius: radius.small,
          backgroundColor: hueFor(label),
        },
      ]}
    >
      <Text style={[styles.monogramText, { fontSize: Math.round(size * 0.36) }]}>
        {monogramOf(label)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  monogram: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogramText: {
    color: colors.textStrong,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
