// Every named opening, findable.
//
// The book page leads with the engine's certified lines and deliberately does
// not list player names beside them: a name nobody vetted, shown next to a
// certified opening, reads as though the engine had something to do with it.
// But a name nobody can find is a name nobody will use, so all of them are
// here -- searchable, and labelled with who named them.

import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { OpeningLine, OpeningName, OpeningNamePage, OpeningNameSource } from '@/engine/openingBook';
import { failureMessage } from '@/errors';
import { browseOpeningNames } from '@/store/api/openings';
import { colors, radius, space } from '@/theme';
import type { ModeID } from '@/types/game';
import { Badge, GhostButton, LabeledInput, OptionChips, Panel } from '@/ui/primitives';

import { publishedOn, ui } from './openingsUi';

const PAGE_SIZE = 25;

type SourceFilter = 'all' | OpeningNameSource;

const SOURCES: readonly { value: SourceFilter; label: string }[] = [
  { value: 'all', label: 'EVERYTHING' },
  { value: 'curator', label: 'THE BOOK' },
  { value: 'player', label: 'BY PLAYERS' },
];

interface NameRowProps {
  entry: OpeningName;
  onOpen: (line: OpeningLine) => void;
}

function NameRow({ entry, onOpen }: NameRowProps) {
  // An unlabelled name is the book's own: the column was added after some
  // names already existed, and its default says so.
  const byPlayer = entry.source === 'player';
  return (
    <Pressable
      accessibilityLabel={`Open ${entry.name}`}
      accessibilityRole="button"
      onPress={() => onOpen(entry.line)}
      style={({ pressed }) => [styles.row, pressed && ui.pressed]}
    >
      <View style={styles.rowCopy}>
        <Text numberOfLines={1} style={styles.rowName}>
          {entry.name}
        </Text>
        <Text numberOfLines={1} style={styles.rowLine}>
          {entry.line.join('  ')}
        </Text>
      </View>
      <View style={styles.rowMeta}>
        <Badge label={byPlayer ? 'PLAYER' : 'BOOK'} tone={byPlayer ? 'neutral' : 'gold'} />
        {byPlayer && entry.authorUsername ? (
          <Text style={styles.rowAuthor}>{entry.authorUsername}</Text>
        ) : null}
        {entry.updatedAtUnixMs ? (
          <Text style={styles.rowDate}>{publishedOn(entry.updatedAtUnixMs)}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export interface NameIndexPanelProps {
  modeId: ModeID;
  onOpenLine: (line: OpeningLine) => void;
}

export default function NameIndexPanel({ modeId, onOpenLine }: NameIndexPanelProps) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<OpeningNamePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A mode change or a new filter starts the paging over: page three of the
  // previous search is not a meaningful position in this one.
  useEffect(() => {
    setOffset(0);
  }, [modeId, query, source]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    browseOpeningNames(modeId, {
      source: source === 'all' ? undefined : source,
      query: query.trim() || undefined,
      limit: PAGE_SIZE,
      offset,
    })
      .then((result) => {
        if (live) {
          setPage(result);
          setError(null);
        }
      })
      .catch((failure) => {
        if (live) setError(failureMessage(failure));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [modeId, query, source, offset]);

  const total = page?.total ?? 0;
  const showing = page?.names?.length ?? 0;

  return (
    <Panel style={styles.panel}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={ui.eyebrow}>THE NAMING LAYER</Text>
          <Text style={styles.sectionTitle}>Every named opening</Text>
        </View>
        {page ? (
          <View style={styles.counts}>
            <Badge label={`${page.curator} IN THE BOOK`} tone="gold" />
            <Badge label={`${page.player} BY PLAYERS`} />
          </View>
        ) : null}
      </View>
      <Text style={styles.sectionCopy}>
        Anyone can name an opening a few moves deep, whether or not RPSFish has analyzed it. Those
        names are kept here rather than listed above, because naming a line is not the same claim
        as certifying one.
      </Text>

      <LabeledInput
        autoCapitalize="none"
        label="SEARCH NAMES"
        onChangeText={setQuery}
        placeholder="Skipping Stone"
        value={query}
      />
      <OptionChips options={SOURCES} onChange={setSource} value={source} />

      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : loading && !page ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : showing === 0 ? (
        <Text style={styles.emptyCopy}>
          {query.trim()
            ? `Nothing is called “${query.trim()}” yet.`
            : 'No openings have been named in this mode yet. Walk into a line below and name it.'}
        </Text>
      ) : (
        <>
          <View style={styles.rows}>
            {page?.names?.map((entry) => (
              <NameRow entry={entry} key={entry.line.join(' ')} onOpen={onOpenLine} />
            ))}
          </View>
          <View style={styles.pager}>
            <Text style={styles.pagerText}>
              {offset + 1}–{offset + showing} of {total}
            </Text>
            <View style={styles.pagerButtons}>
              <GhostButton
                compact
                disabled={offset === 0 || loading}
                label="← NEWER"
                onPress={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              />
              <GhostButton
                compact
                disabled={offset + showing >= total || loading}
                label="OLDER →"
                onPress={() => setOffset(offset + PAGE_SIZE)}
              />
            </View>
          </View>
        </>
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  panel: { gap: space.small },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: space.small,
    justifyContent: 'space-between',
  },
  headerCopy: { flex: 1, gap: 2, minWidth: 0 },
  counts: { alignItems: 'flex-end', gap: 4 },
  sectionTitle: { color: colors.text, fontSize: 19, fontWeight: '700' },
  sectionCopy: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  rows: { gap: 6 },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radius.small,
    borderWidth: 1,
    flexDirection: 'row',
    gap: space.small,
    justifyContent: 'space-between',
    paddingHorizontal: space.small,
    paddingVertical: 7,
  },
  rowCopy: { flex: 1, gap: 1, minWidth: 0 },
  rowName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  rowLine: { color: colors.textFaint, fontSize: 11, fontVariant: ['tabular-nums'] },
  rowMeta: { alignItems: 'flex-end', gap: 2 },
  rowAuthor: { color: colors.textMuted, fontSize: 10 },
  rowDate: { color: colors.textFaint, fontSize: 10 },
  pager: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.small,
    justifyContent: 'space-between',
  },
  pagerText: { color: colors.textFaint, fontSize: 11 },
  pagerButtons: { flexDirection: 'row', gap: 6 },
  loading: { alignItems: 'center', paddingVertical: space.medium },
  error: { color: colors.danger, fontSize: 13 },
  emptyCopy: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
});
