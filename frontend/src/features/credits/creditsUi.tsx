import { Link } from 'expo-router';
import type { Href } from 'expo-router';
import type { ReactNode } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';

import { useStackProps } from '@/navigation/stack';
import { colors, radius, space, themedSheet, type } from '@/theme';

// The cards and headings the credits page and the open-source page share, so
// the page under Credits reads as part of it rather than as a new design.

/** One thing to open, somewhere that is not this site. */
export interface OutwardLink {
  title: string;
  detail: string;
  url: string;
  /** The mark in front of it: a play triangle for a video, a dot otherwise. */
  mark: string;
}

/**
 * Where a link goes, as a reader checks it: the site, not the whole address.
 * "youtube.com" says what pressing it does; the video's id after it said nothing.
 */
const siteOf = (url: string): string => {
  const match = /^[a-z]+:\/\/(?:www\.)?([^/?#]+)/i.exec(url);
  return match ? match[1]! : url;
};

/**
 * A card that opens something outside the app.
 *
 * `children` go between the description and the address, for a card with
 * something to show rather than only something to say.
 */
export function OutwardCard({ link, children }: { link: OutwardLink; children?: ReactNode }) {
  return (
    <Pressable
      accessibilityHint="Opens outside this site"
      accessibilityLabel={link.title}
      accessibilityRole="link"
      onPress={() => Linking.openURL(link.url)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <Text style={styles.cardMark}>{link.mark}</Text>
      <View style={styles.cardCopy}>
        <Text style={styles.cardTitle}>{link.title}</Text>
        <Text style={styles.cardDetail}>{link.detail}</Text>
        {children}
        {/*
          Where it goes, written out under the description. A link that hides
          where it goes is one people are right not to press, and these pages
          are mostly links off the site.
        */}
        <Text numberOfLines={1} style={styles.cardURL}>
          {siteOf(link.url)}
        </Text>
      </View>
      <Text style={styles.cardChevron}>↗</Text>
    </Pressable>
  );
}

/** A card that opens a page of this site, drawn like the ones that leave it. */
export function InwardCard({ title, detail, href }: { title: string; detail: string; href: Href }) {
  const stack = useStackProps(href);
  return (
    <Link asChild href={href} {...stack}>
      {/*
        One style object rather than OutwardCard's pressed-state array. On the
        web, Link asChild hands its child's style to a real anchor, and an array
        there takes the whole page down during hydration.
      */}
      <Pressable accessibilityLabel={title} accessibilityRole="link" style={styles.card}>
        <Text style={styles.cardMark}>◆</Text>
        <View style={styles.cardCopy}>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.cardDetail}>{detail}</Text>
        </View>
        <Text style={styles.cardChevron}>›</Text>
      </Pressable>
    </Link>
  );
}

export const ui = themedSheet(() => ({
  // No padding on top: `ScreenShell` already opens every page with the same room.
  hero: { paddingBottom: space.snug },
  heroEyebrow: { ...type.eyebrow, color: colors.textFaint, letterSpacing: 2.1 },
  heroTitle: {
    color: colors.textStrong,
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -1,
    marginTop: space.tight,
  },
  heroSubtitle: {
    ...type.bodyStrong,
    color: colors.textMuted,
    lineHeight: 20,
    marginTop: space.small,
  },

  section: { gap: space.small },
  sectionLabel: { ...type.eyebrow, color: colors.textFaint, letterSpacing: 1.4 },
  /** A line of fine print under a section's cards. */
  sectionNote: { ...type.body, color: colors.textMuted, paddingHorizontal: space.snug },
}));

const styles = themedSheet(() => ({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.medium,
    padding: space.medium,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  // Neutral: the marks say what kind of link a card is, and green is for the
  // one button on a page worth pressing.
  cardMark: { color: colors.textFaint, fontSize: 12, lineHeight: 20 },
  // `minWidth: 0` so a long description wraps instead of pushing the chevron
  // off the end of the card. See the note in MobileTopBar.
  cardCopy: { flex: 1, minWidth: 0, gap: space.hair },
  cardTitle: { ...type.rowTitle, color: colors.textStrong, fontSize: 13 },
  cardDetail: { ...type.body, color: colors.textMuted, marginTop: space.hair },
  cardURL: { ...type.meta, color: colors.textFaint, marginTop: space.tight },
  cardChevron: { color: colors.textFaint, fontSize: 13, lineHeight: 20 },

  pressed: { opacity: 0.7 },
}));
