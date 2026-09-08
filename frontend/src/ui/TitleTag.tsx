import { StyleSheet, Text } from 'react-native';

import { colors, radius, space, titleTone } from '@/theme';
import type { TitleID } from '@/types/protocol';

// The tag that sits in front of a name: `GM`, `BSL`, `DEV`.
//
// One component for every place a player is named — the board, the chat
// transcript, the ladder, the account page — because the tag is an identity
// mark and identity marks that differ by screen stop reading as the same thing.
//
// The colour belongs to the title rather than to this component: the rating
// ladder is a ramp, each achievement has a hue of its own, and the granted ones
// are the muted end. `titleTone` holds the whole scheme, and decides what
// an id this build has never heard of looks like. Never the accent green, which
// everywhere else in this app means "your turn" or "this is live", neither of
// which a title is.
//
// It renders nothing at all when there is no title, so a caller can put it in
// the row unconditionally rather than guarding at every call site. That is what
// keeps it out of the layout of the great majority of players, who wear none.

export interface TitleTagProps {
  title?: TitleID | null;
  /**
   * Matched to the name it sits beside. `small` is a list row or a chat line,
   * `medium` a player bar, `large` a profile heading.
   */
  size?: 'small' | 'medium' | 'large';
}

export default function TitleTag({ title, size = 'small' }: TitleTagProps) {
  const tag = title?.trim();
  if (!tag) return null;
  const tone = titleTone(tag);
  return (
    <Text
      // Read out as the word rather than the letters, which a screen reader
      // would otherwise spell as an acronym in the middle of a name.
      accessibilityLabel={`Title: ${tag}`}
      style={[
        styles.tag,
        { backgroundColor: tone.background, color: tone.text },
        size === 'medium' && styles.medium,
        size === 'large' && styles.large,
      ]}
    >
      {tag}
    </Text>
  );
}

const styles = StyleSheet.create({
  tag: {
    // Colour is the title's, applied above. What is left here is the shape,
    // which every tag shares whatever it says.
    borderWidth: 1,
    borderColor: colors.titleBorder,
    borderRadius: radius.small,
    overflow: 'hidden',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.6,
    paddingHorizontal: 4,
    paddingVertical: 1,
    // Never squeezed by the name beside it: three characters is the whole
    // point, and a tag that wraps or ellipsises is worse than none.
    flexShrink: 0,
  },
  medium: { fontSize: 9, paddingHorizontal: 5, paddingVertical: space.hair },
  large: { fontSize: 11, paddingHorizontal: 6, paddingVertical: 2, letterSpacing: 1 },
});
