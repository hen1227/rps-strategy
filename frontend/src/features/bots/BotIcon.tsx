import { useState } from 'react';
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
 * Three kinds, in order of preference. The six built-in browser bots have drawn
 * ones. An engine somebody connected from their own machine has whatever PNG its
 * owner shipped with `rpsbot.py`, fetched from the server — see `botIconUrl`.
 * Anything else falls back to a monogram, which is also where a picture that
 * fails to load lands, rather than the blank square this component used to
 * return.
 */
export interface BotIconProps {
  /** One of the six built-in bots, which have drawn portraits. */
  profileId?: string;
  /** A connected engine's name, used for the monogram fallback. */
  name?: string;
  /** An owner-supplied icon, from `botIconUrl`. */
  uri?: string;
  size?: number;
}

export default function BotIcon({ profileId, name, uri, size = 52 }: BotIconProps) {
  // The URL that failed, rather than a flag: an owner who has just replaced a
  // broken PNG gets a new URL, and that has to be tried rather than written off
  // because the previous one was bad.
  const [failedUri, setFailedUri] = useState<string | null>(null);

  if (uri && uri !== failedUri) {
    return (
      <Image
        accessible={false}
        accessibilityIgnoresInvertColors
        onError={() => setFailedUri(uri)}
        resizeMode="contain"
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: radius.small }}
      />
    );
  }

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
