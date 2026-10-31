import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { InwardCard, OutwardCard, ui } from './creditsUi';
import type { OutwardLink } from './creditsUi';
import { DATASET_URL, ENGINE_SOURCE_URL, SOURCE_URL, links } from '@/navigation/links';
import { up } from '@/navigation/upFrom';
import { getArchiveSummary } from '@/store/api/review';
import { colors, contentWidth, space, themedSheet, type } from '@/theme';
import BackLink from '@/ui/BackLink';
import ScreenShell from '@/ui/ScreenShell';

// What anybody may take from this project, each with its licence.
//
// The game data leads. It is the part nobody would find otherwise: the source
// has GitHub's mark in the sidebar, but the archive was a sentence in the
// privacy policy. The code follows, then the packages it is built on.

const archive: OutwardLink = {
  title: 'The game archive',
  detail: 'Every finished game played here, published daily on Hugging Face. CC0, so use it for anything.',
  url: DATASET_URL,
  mark: '◆',
};

const source: OutwardLink = {
  title: 'RPS Strategy',
  detail: 'The server, this site and the apps. AGPL-3.0.',
  url: SOURCE_URL,
  mark: '◆',
};

const engine: OutwardLink = {
  title: 'RPSFish',
  detail: 'The analysis engine. LGPL-3.0.',
  url: ENGINE_SOURCE_URL,
  mark: '◆',
};

export default function OpenSourceScreen() {
  const [games, setGames] = useState<number | null>(null);

  // After the first render, never during it: the pre-rendered page has no
  // count, so the first client render must not have one either.
  useEffect(() => {
    let live = true;
    getArchiveSummary()
      .then((summary) => {
        if (live) setGames(summary.games);
      })
      // The count decorates the card; without it the card still says what the
      // archive is and still opens it.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return (
    <ScreenShell width={contentWidth.reading}>
      <BackLink href={up.openSource.href} label={up.openSource.label} />

      <View style={ui.hero}>
        <Text style={ui.heroEyebrow}>OPEN SOURCE</Text>
        <Text style={ui.heroTitle}>Free to read and reuse</Text>
        <Text style={ui.heroSubtitle}>Every game played here, and the code that plays them.</Text>
      </View>

      <View style={ui.section}>
        <Text style={ui.sectionLabel}>THE GAMES</Text>
        <OutwardCard link={archive}>
          {/* A fixed-height slot, so the number arriving moves nothing. */}
          <View style={styles.figure}>
            <Text style={[styles.count, games === null && styles.countPending]}>
              {games === null ? '—' : games.toLocaleString()}
            </Text>
            <Text style={styles.countLabel}>GAMES</Text>
          </View>
        </OutwardCard>
      </View>

      <View style={ui.section}>
        <Text style={ui.sectionLabel}>THE CODE</Text>
        <OutwardCard link={source} />
        <OutwardCard link={engine} />
        <InwardCard
          detail="The client, the example engines and the protocol. MIT, so a bot built from them is yours to license."
          href={links.botGuide()}
          title="The bot kit"
        />
        {/*
          The same reason CONTRIBUTING.md gives for the CLA, in the same words:
          the store builds ship under separate terms, which only works for code
          the project's owner may license that way, and the CLA gives it that
          right for other people's contributions. The engine inside them is
          still LGPL either way.
        */}
        <Text style={ui.sectionNote}>
          The App Store and Google Play apps are built from this code but licensed separately,
          because Apple's terms add restrictions the AGPL forbids.
        </Text>
      </View>

      <View style={ui.section}>
        <Text style={ui.sectionLabel}>BUILT ON</Text>
        <InwardCard
          detail="The open-source packages this site and the app are built on, and the licence of each."
          href={links.licences()}
          title="Open-source licences"
        />
      </View>
    </ScreenShell>
  );
}

const styles = themedSheet(() => ({
  figure: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.snug,
    height: 40,
    marginTop: space.small,
  },
  count: { color: colors.textStrong, fontSize: 32, fontWeight: '800', lineHeight: 38 },
  countPending: { color: colors.textFaint },
  countLabel: { ...type.eyebrow, color: colors.textMuted, letterSpacing: 1.4 },
}));
