import { Text, View } from 'react-native';

import { InwardCard, OutwardCard, ui } from './creditsUi';
import type { OutwardLink } from './creditsUi';
import { links, webGoatGuy } from '@/navigation/links';
import { contentWidth } from '@/theme';
import ScreenShell from '@/ui/ScreenShell';

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

const videos: OutwardLink[] = [
  {
    title: "The original game designs",
    detail:
      "WebGoatGuy introduces Infiltration (V3) and Total War (V5).",
    url: webGoatGuy.originalVideoURL,
    mark: '▶',
  },
  {
    title: "Introducing Intransitive (V6)",
    detail:
      "WebGoatGuy introduces Intransitive, the official tournament mode.",
    url: webGoatGuy.intransitiveVideoURL,
    mark: '▶',
  },
];

const elsewhere: OutwardLink[] = [
  {
    title: 'Play the games where they came from',
    detail:
      "The official game and tournament site by WebGoatGuy.",
    url: webGoatGuy.playURL,
    mark: '◆',
  },
  {
    title: 'The Intransitive Discord',
    detail:
      "Join the community for game discussion and tournaments.",
    url: webGoatGuy.discordURL,
    mark: '◆',
  },
];

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
      <View style={ui.hero}>
        <Text style={ui.heroEyebrow}>CREDIT WHERE IT IS DUE</Text>
        <Text style={ui.heroTitle}>WebGoatGuy made this game</Text>
        <Text style={ui.heroSubtitle}>
          WebGoatGuy created every game mode here.
        </Text>
      </View>

      <View style={ui.section}>
        <Text style={ui.sectionLabel}>THE VIDEOS</Text>
        {videos.map((link) => (
          <OutwardCard key={link.url} link={link} />
        ))}
      </View>

      <View style={ui.section}>
        <Text style={ui.sectionLabel}>WHERE TO GO NEXT</Text>
        {elsewhere.map((link) => (
          <OutwardCard key={link.url} link={link} />
        ))}
      </View>

      {/*
        Last, under everything that is WebGoatGuy's: what this build is made of.
        The source, the engine, the game data and the licences of the packages
        underneath are a page of their own now, and this is the one way to it.
      */}
      <View style={ui.section}>
        <Text style={ui.sectionLabel}>THIS APP</Text>
        <InwardCard
          detail="The code, the engine, and every game played here."
          href={links.openSource()}
          title="RPS Strategy is open source"
        />
      </View>
    </ScreenShell>
  );
}
