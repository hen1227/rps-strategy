import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { links, webGoatGuy } from '@/navigation/links';
import { colors, contentWidth, radius, space, type } from '@/theme';
import ScreenShell from '@/ui/ScreenShell';
import LinkRow from '@/ui/LinkRow';
import { Panel, SectionHeading } from '@/ui/primitives';

// Where this game came from, and who it came from.
//
// The sidebar has carried a single link to one YouTube video since the app was
// written, labelled "the video behind this game". That was true and it was not
// enough: there are two videos now, the modes on this site were invented across
// both of them, there is an official site to play the same games on, and there
// is a Discord where the people who made them are. A link is not a credit.
//
// This page is deliberately the *first* thing under the fold on a fan build: it
// says plainly that the games are not mine, names who made them, and sends
// people to his site rather than trying to keep them here. That is the whole
// reason it exists — the rest of this app is the fan part.

/** One thing to open, somewhere that is not this site. */
interface OutwardLink {
  eyebrow: string;
  title: string;
  detail: string;
  url: string;
  /** The mark in front of it: a play triangle for a video, a dot otherwise. */
  mark: string;
}

const videos: OutwardLink[] = [
  {
    eyebrow: 'THE ORIGINAL',
    title: 'The video this whole game came out of',
    detail:
      'WebGoatGuy invents several games in one sitting, v3 and v5 among them. Everything on this site starts here.',
    url: webGoatGuy.originalVideoURL,
    mark: '▶',
  },
  {
    eyebrow: 'THE SEQUEL',
    title: 'Intransitive — the video that introduced v6',
    detail:
      'The later video, where Intransitive is designed and shown off. It is the newest mode here and the one the official tournament is played in.',
    url: webGoatGuy.intransitiveVideoURL,
    mark: '▶',
  },
];

const elsewhere: OutwardLink[] = [
  {
    eyebrow: 'THE OFFICIAL SITE',
    title: 'Play the games where they came from',
    detail:
      'WebGoatGuy’s own implementation at meaf.us/rps2 — the official place to play, and where the tournaments are held.',
    url: webGoatGuy.playURL,
    mark: '◆',
  },
  {
    eyebrow: 'THE COMMUNITY',
    title: 'The Intransitive Discord',
    detail:
      'Where the games are discussed, the tournaments are organised, and the people who invented all of this actually are.',
    url: webGoatGuy.discordURL,
    mark: '◆',
  },
];

/** A card that opens something outside the app. */
function OutwardCard({ link }: { link: OutwardLink }) {
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
        <Text style={styles.cardEyebrow}>{link.eyebrow}</Text>
        <Text style={styles.cardTitle}>{link.title}</Text>
        <Text style={styles.cardDetail}>{link.detail}</Text>
        {/*
          The address written out under the description. A link that hides where
          it goes is one people are right not to press, and this page is nothing
          but links off the site.
        */}
        <Text numberOfLines={1} style={styles.cardURL}>
          {link.url}
        </Text>
      </View>
      <Text style={styles.cardChevron}>↗</Text>
    </Pressable>
  );
}

export default function CreditsScreen() {
  // No back button: this page sits inside the app shell, whose sidebar or tab
  // bar is already the way out. Same reasoning as the policy page.
  return (
    <ScreenShell width={contentWidth.reading}>
      <View style={styles.hero}>
        <Text style={styles.heroEyebrow}>CREDIT WHERE IT IS DUE</Text>
        <Text style={styles.heroTitle}>WebGoatGuy made this game</Text>
        <Text style={styles.heroSubtitle}>
          Not this website — the game. Every mode you can play here was invented by WebGoatGuy
          and published in the videos below.
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>THE VIDEOS</Text>
        {videos.map((link) => (
          <OutwardCard key={link.url} link={link} />
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>WHERE TO GO NEXT</Text>
        {elsewhere.map((link) => (
          <OutwardCard key={link.url} link={link} />
        ))}
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  hero: { paddingTop: space.xlarge, paddingBottom: space.snug },
  heroEyebrow: { ...type.eyebrow, color: colors.accent, letterSpacing: 2.1 },
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

  body: { ...type.bodyStrong, color: colors.textMuted, lineHeight: 19, marginTop: space.small },
  tagInline: { color: colors.goldBright, fontWeight: '900' },

  section: { gap: space.small },
  sectionLabel: { ...type.eyebrow, color: colors.textFaint, letterSpacing: 1.4 },

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
  cardMark: { color: colors.accentBright, fontSize: 12, lineHeight: 20 },
  // `minWidth: 0` so a long description wraps instead of pushing the chevron
  // off the end of the card. See the note in MobileTopBar.
  cardCopy: { flex: 1, minWidth: 0, gap: space.hair },
  cardEyebrow: { ...type.eyebrow, color: colors.textFaint },
  cardTitle: { ...type.rowTitle, color: colors.textStrong, fontSize: 13 },
  cardDetail: { ...type.body, color: colors.textMuted, marginTop: space.hair },
  cardURL: { ...type.meta, color: colors.textFaint, marginTop: space.tight },
  cardChevron: { color: colors.textFaint, fontSize: 13, lineHeight: 20 },

  rows: { marginTop: space.small },

  pressed: { opacity: 0.7 },
});
