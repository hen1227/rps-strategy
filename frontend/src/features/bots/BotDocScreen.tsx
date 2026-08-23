import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { failureMessage } from '@/errors';
import { links } from '@/navigation/links';
import { botGuide, type BotGuide } from '@/store/api/bots';
import { colors, contentWidth, space, type } from '@/theme';
import Markdown from '@/ui/Markdown';
import PageHeading from '@/ui/PageHeading';
import ScreenShell from '@/ui/ScreenShell';
import { docSections, sectionSource, type DocSection } from '@/ui/markdownSections';
import { Banner, GhostButton, Panel } from '@/ui/primitives';

// One of the two documents the server ships, as a page of its own.
//
// Both of these used to be unrolled at the bottom of the Bots page, one after
// the other, which is how a page about playing a bot came to be twelve screens
// long. They are reference material: worth having in full, worth arriving at on
// purpose.
//
// The text is still the file in `docs/` — fetched, not retyped — but it is laid
// out here rather than poured out. Each `##` section gets its own card, so the
// page has a shape at a glance, and the index at the top jumps between them.
//
// The index is web-only, deliberately. It works by anchor: `nativeID` becomes a
// real `id` in the browser, and `scrollIntoView` is the browser's own job. On a
// phone the same trick needs the page's scroll view by ref and every section
// measured, which is a lot of machinery for a document nobody reads on a phone —
// so there the sections simply run in order.

export interface BotDocScreenProps {
  /** Which of the two the server sends. */
  doc: 'guide' | 'protocol';
}

/** How the two documents introduce themselves before their own title arrives. */
const FALLBACK = {
  guide: { eyebrow: 'HANDOUT', title: 'Connect your bot' },
  protocol: { eyebrow: 'REFERENCE', title: 'The engine protocol' },
} as const;

const jumpTo = (id: string) => {
  if (Platform.OS !== 'web') return;
  globalThis.document?.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/** Chip lettering: a heading's backticks are markup, not a name. */
const chipLabel = (section: DocSection) => section.title.replace(/`/g, '');

export default function BotDocScreen({ doc }: BotDocScreenProps) {
  const [guide, setGuide] = useState<BotGuide | null>(null);
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

  const source = guide ? (doc === 'guide' ? guide.guide : guide.protocol) : null;
  const sections = docSections(source, 2);
  // The document's own `#` heading titles the page, so it is not also a card.
  const lead = sections.find((section) => section.level === 1) ?? null;
  const body = sections.filter((section) => section.level > 1);

  return (
    <ScreenShell width={contentWidth.reading}>
      <PageHeading
        back={{ href: links.myBots(), label: 'Your bots' }}
        eyebrow={FALLBACK[doc].eyebrow}
        title={lead?.title ?? FALLBACK[doc].title}
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

const styles = StyleSheet.create({
  help: { ...type.body, color: colors.textMuted },
  index: { gap: space.small },
  indexLabel: { ...type.eyebrow, color: colors.textFaint },
  indexRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.snug },
});
