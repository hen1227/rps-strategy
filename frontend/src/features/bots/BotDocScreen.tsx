import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { failureMessage } from '@/errors';
import { links } from '@/navigation/links';
import { botGuide, loadedBotGuide, type BotGuide } from '@/store/api/bots';
import { colors, contentWidth, space, themedSheet, type } from '@/theme';
import Markdown from '@/ui/Markdown';
import PageHeading from '@/ui/PageHeading';
import ScreenShell from '@/ui/ScreenShell';
import TabBar from '@/ui/TabBar';
import { docSections, sectionSource, type DocSection } from '@/ui/markdownSections';
import { Banner, GhostButton, Panel } from '@/ui/primitives';

// One of the documents the server ships, as a page of its own.
//
// The first two used to be unrolled at the bottom of the Bots page, one after
// the other, which is how a page about playing a bot came to be twelve screens
// long. They are reference material: worth having in full, worth arriving at on
// purpose, and worth a link somebody can hand to somebody else.
//
// The text is still the file in `docs/` — fetched, not retyped — but it is laid
// out here rather than poured out. Each `##` section gets its own card, so the
// page has a shape at a glance, and the index at the top jumps between them.
//
// The three of them are one page with three addresses, and the tabs at the top
// are how you get between them. They used to be three rows of the navigation —
// three of the five under Bots, which made a menu about one subject look like
// the site's largest section, and on a phone wrapped the strip onto a second
// line. What they are is one document set: you arrive to write an engine, and
// the protocol is the reference you keep open while following the handout.
//
// Each keeps its own address rather than becoming `?doc=` on one route. They
// are handouts — the README hands two of them out, and the protocol reference
// is a link people paste at each other — so each stays a page that can be
// linked to, pre-rendered and crawled on its own. The cost of that is a route
// change per tab press, which remounts this screen; `botGuide` is fetched once
// and held for exactly that reason, so a press swaps the text rather than
// showing a loading state.
//
// The index is web-only, deliberately. It works by anchor: `nativeID` becomes a
// real `id` in the browser, and `scrollIntoView` is the browser's own job. On a
// phone the same trick needs the page's scroll view by ref and every section
// measured, which is a lot of machinery for a document nobody reads on a phone —
// so there the sections simply run in order.

export interface BotDocScreenProps {
  /** Which of the documents the server sends. */
  doc: 'guide' | 'protocol' | 'notation';
}

/**
 * The three documents: what the tab is called, and where it lives.
 *
 * `eyebrow` and `title` are how a document introduces itself before its own
 * text arrives — the heading inside the Markdown is the real title, and this is
 * what stands in for it while the fetch is in the air, so the page does not
 * change shape when it lands.
 */
const DOCS = [
  {
    doc: 'guide',
    label: 'Connect',
    href: links.botGuide(),
    eyebrow: "GUIDE",
    title: 'Connect your bot',
  },
  {
    doc: 'protocol',
    label: 'Protocol',
    href: links.botProtocol(),
    eyebrow: 'REFERENCE',
    title: 'The engine protocol',
  },
  {
    doc: 'notation',
    label: 'Notation',
    href: links.botNotation(),
    eyebrow: 'REFERENCE',
    title: 'Records and notation',
  },
] as const;

const jumpTo = (id: string) => {
  if (Platform.OS !== 'web') return;
  globalThis.document?.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/** Chip lettering: a heading's backticks are markup, not a name. */
const chipLabel = (section: DocSection) => section.title.replace(/`/g, '');

export default function BotDocScreen({ doc }: BotDocScreenProps) {
  const router = useRouter();
  // Seeded with the document set if it has already been fetched, so arriving
  // here again — the next tab, or back from the registry — is not a page that
  // says "Loading…" first. See `loadedBotGuide`.
  const [guide, setGuide] = useState<BotGuide | null>(loadedBotGuide);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    botGuide()
      .then((next) => {
        if (!cancelled) setGuide(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(failureMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = DOCS.find((entry) => entry.doc === doc) ?? DOCS[0];
  const source = guide ? guide[doc === 'guide' ? 'guide' : doc] : null;
  const sections = docSections(source, 2);
  // The document's own `#` heading titles the page, so it is not also a card.
  const lead = sections.find((section) => section.level === 1) ?? null;
  const body = sections.filter((section) => section.level > 1);

  return (
    <ScreenShell width={contentWidth.reading}>
      {/*
        No trail out. This page is a row of the navigation — see `useUpTarget` —
        so the way back to your bots is a chip in the strip above on a phone and
        a row in the sidebar on a desktop, and a button repeating it would sit
        directly under the one that already goes there.
      */}
      <PageHeading eyebrow={current.eyebrow} title={lead?.title ?? current.title} />

      {/*
        `replace`, so reading all three does not leave three entries in the back
        stack between here and wherever you came from — the reasoning the admin
        screen's tabs already give. Pressing the open tab navigates nowhere: it
        is the same address, and going there again would remount the page.
      */}
      <TabBar
        accessibilityLabel="Engine documentation"
        fill
        onChange={(next) => {
          const entry = DOCS.find((candidate) => candidate.doc === next);
          if (entry && next !== doc) router.replace(entry.href);
        }}
        options={DOCS.map((entry) => ({ value: entry.doc, label: entry.label }))}
        value={doc}
      />

      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}

      {source === null ? (
        <Panel>
          <Text style={styles.help}>{error ? 'Nothing to show.' : 'Loading…'}</Text>
        </Panel>
      ) : (
        <>
          {lead ? (
            <Panel tone="accent">
              <Markdown source={lead.body} />
            </Panel>
          ) : null}

          {Platform.OS === 'web' && body.length > 1 ? (
            <View style={styles.index}>
              <Text style={styles.indexLabel}>ON THIS PAGE</Text>
              <View style={styles.indexRow}>
                {body.map((section) => (
                  <GhostButton
                    compact
                    key={section.id}
                    label={chipLabel(section)}
                    onPress={() => jumpTo(section.id)}
                  />
                ))}
              </View>
            </View>
          ) : null}

          {body.map((section) => (
            <View key={section.id} nativeID={section.id}>
              <Panel>
                <Markdown source={sectionSource(section)} />
              </Panel>
            </View>
          ))}
        </>
      )}
    </ScreenShell>
  );
}

const styles = themedSheet(() => ({
  help: { ...type.body, color: colors.textMuted },
  index: { gap: space.small },
  indexLabel: { ...type.eyebrow, color: colors.textFaint },
  indexRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.snug },
}));
