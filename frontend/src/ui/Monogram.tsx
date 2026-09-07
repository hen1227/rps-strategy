import { StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/theme';

// Two letters in a coloured square, for anybody who has no picture.
//
// This was inside `BotIcon`, as the last of its three fallbacks. It came out
// when the ladder's podium needed the same art for *people*, who have no
// portrait at all: the alternative was calling a component named `BotIcon` to
// draw a human, which is the kind of thing that reads as a mistake for as long
// as it survives. `BotIcon` still owns the order of preference — drawn portrait,
// owner-supplied PNG, then this.

// Hues spread far enough apart that two names in the same list are easy to tell
// apart at a glance.
const HUES = ['#5b8266', '#7a5c9e', '#b5763f', '#3f7b91', '#9e5c6b', '#6b7a3f'];

/** A stable colour per name, so a given player always looks the same. */
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

export interface MonogramProps {
  /** The name the letters and the colour are taken from. */
  name: string;
  size?: number;
  /** Round rather than square, which is how a person is drawn. */
  round?: boolean;
}

export default function Monogram({ name, size = 52, round = false }: MonogramProps) {
  return (
    <View
      accessible={false}
      style={[
        styles.monogram,
        {
          width: size,
          height: size,
          borderRadius: round ? size / 2 : radius.small,
          backgroundColor: hueFor(name),
        },
      ]}
    >
      {/*
        Proportional down to the point where two capitals stop being letters.
        The score table's own icons are 16px, and 0.36 of that is a 6px smudge:
        below the floor the monogram is only a coloured square, which is the one
        thing it exists not to be.
      */}
      <Text style={[styles.monogramText, { fontSize: Math.max(8, Math.round(size * 0.36)) }]}>
        {monogramOf(name)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  monogram: { alignItems: 'center', justifyContent: 'center' },
  monogramText: {
    color: colors.textStrong,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
