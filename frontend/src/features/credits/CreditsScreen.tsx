import { Link } from 'expo-router';
import type { Href } from 'expo-router';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { SOURCE_URL, links, webGoatGuy } from '@/navigation/links';
import { useStackProps } from '@/navigation/stack';
import { colors, contentWidth, radius, space, themedSheet, type } from '@/theme';
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
    title: "The original game designs",
    detail:
      "WebGoatGuy introduces Infiltration (v3) and Total War (v5).",
    url: webGoatGuy.originalVideoURL,
    mark: '▶',
  },
  {
    eyebrow: 'THE SEQUEL',
    title: "Introducing Intransitive (v6)",
    detail:
      "WebGoatGuy introduces Intransitive, the official tournament mode.",
    url: webGoatGuy.intransitiveVideoURL,
    mark: '▶',
  },
];

const elsewhere: OutwardLink[] = [
  {
    eyebrow: 'THE OFFICIAL SITE',
    title: 'Play the games where they came from',
    detail:
      "The official game and tournament site by WebGoatGuy.",
    url: webGoatGuy.playURL,
    mark: '◆',
  },
  {
    eyebrow: 'THE COMMUNITY',
    title: 'The Intransitive Discord',
    detail:
      "Join the community for game discussion and tournaments.",
    url: webGoatGuy.discordURL,
    mark: '◆',
  },
];

// Last, under everything that is WebGoatGuy's: the code this build is made of,
// and the licences of the packages it is built on. The AGPL expects a network
// service to offer its source to the people using it, and most of those
// licences ask for their notice to travel with the app, so both need a place a
// player can find, and a credits page is where people look for them.
const source: OutwardLink = {
  eyebrow: 'THE SOURCE',
  title: 'RPS Strategy is open source',
  detail:
    'The code behind this site and the app, under the AGPL-3.0. The bot kit and its protocol documents are MIT, so a bot built from them is yours to license.',
  url: SOURCE_URL,
  mark: '◆',
};

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

/** A card that opens a page of this site, drawn like the ones that leave it. */
function InwardCard({ eyebrow, title, detail, href }: { eyebrow: string; title: string; detail: string; href: Href }) {
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
          <Text style={styles.cardEyebrow}>{eyebrow}</Text>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.cardDetail}>{detail}</Text>
        </View>
        <Text style={styles.cardChevron}>›</Text>
      </Pressable>
    </Link>
  );
}

// No back button, like every other *section* of the shell.
//
// It carried one for as long as it was not a section: the sidebar was there,
// but nothing in it lit up for this page, because the only ways here were a
// link in the sidebar's foot and the tab bar's More menu. Both of those are
// gone — this is a row of the You group on either surface now, and the row
// lights up — so the button was pointing at the lobby from a page one press
// from the lobby. Same story as the privacy page.
export default function CreditsScreen() {
  return (
    <ScreenShell width={contentWidth.reading}>
      <View style={styles.hero}>
        <Text style={styles.heroEyebrow}>CREDIT WHERE IT IS DUE</Text>
        <Text style={styles.heroTitle}>WebGoatGuy made this game</Text>
        <Text style={styles.heroSubtitle}>
          WebGoatGuy created every game mode here. Watch the original videos below.
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

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>THIS APP</Text>
        <OutwardCard link={source} />
        <InwardCard
          detail="The open-source packages this site and the app are built on, and the licence of each."
          eyebrow="THE LICENCES"
          href={links.licences()}
          title="Open-source licences"
        />
      </View>
    </ScreenShell>
  );
}

const styles = themedSheet(() => ({
  // No padding on top: the trail that used to sit above this is gone, and
  // `ScreenShell` already opens every page with the same room.
  hero: { paddingBottom: space.snug },
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
}));
