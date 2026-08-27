// What this line is called, and how it gets called something else.
//
// One panel, three audiences. A visitor sees the published name, or every name
// people have put forward for a line that has none -- which is the difference
// between "nobody has named this" and "nobody has *published* a name for
// this", and the two used to look identical. A curator sees the same list with
// a button on each row, and an input that publishes rather than proposes.

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { OpeningLine, OpeningNaming } from '@/engine/openingBook';
import { colors, radius, space } from '@/theme';
import { Badge, GhostButton, Panel, PrimaryButton } from '@/ui/primitives';

import { NameInput, SuggestionRow, publishedOn, ui } from './openingsUi';
import type { OpeningCurator } from './useOpeningCurator';

export interface NamePanelProps {
  curator: OpeningCurator;
  line: OpeningLine;
  naming: OpeningNaming;
  /** Walk to another line, for the "name its parent first" nudge. */
  onOpenLine: (line: OpeningLine) => void;
  /** Resolves false when the proposal was not accepted, so the draft stays. */
  onSuggest: (name: string) => Promise<boolean>;
  suggesting: boolean;
}

export default function NamePanel({
  curator,
  line,
  naming,
  onOpenLine,
  onSuggest,
  suggesting,
}: NamePanelProps) {
  const published = naming.nameFor(line);
  const title = naming.titleFor(line);
  const suggestions = naming.suggestionsFor(line);
  const mirror = naming.mirrorOf(line);
  const parent = line.slice(0, -1);
  const parentNamed = line.length > 1 ? naming.nameFor(parent) : null;
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setDraft(published?.name ?? '');
  }, [published?.name, line.join(' ')]);

  if (!line.length) return null;

  const trimmed = draft.trim();
  const lineIsBusy = curator.busy === `publish:${line.join(' ')}`;
  const submit = () => {
    if (!trimmed) return;
    if (curator.active) {
      curator.publish(line, trimmed);
      return;
    }
    onSuggest(trimmed).then((sent) => sent && setDraft(''));
  };

  return (
    <Panel style={styles.panel} tone="accent">
      <View style={styles.heading}>
        <Text style={ui.eyebrow}>{published ? 'PUBLISHED NAME' : 'NAME WANTED'}</Text>
        {suggestions.length > 0 && !published && (
          <Badge label={`${suggestions.length} PUT FORWARD`} tone="gold" />
        )}
      </View>

      {published ? (
        <>
          <Text style={styles.publishedName}>{published.name}</Text>
          <Text style={ui.hint}>
            {publishedOn(published.updatedAtUnixMs)
              ? `Published ${publishedOn(published.updatedAtUnixMs)}. `
              : ''}
            {mirror
              ? `The mirror line ${mirror.join('  ')} is the same opening and carries the same name.`
              : 'This line is its own mirror.'}
          </Text>
        </>
      ) : (
        <>
          <Text style={styles.prompt}>This line needs a name.</Text>
          <Text style={ui.hint}>
            {title.namedAncestor
              ? `It currently lives under ${title.namedAncestor.name}. Suggest a defense, gambit, variation—or something stranger.`
              : 'Chess has openings, defenses, gambits, and systems. We can borrow the structure without borrowing the seriousness.'}
            {mirror ? ` Naming it names its mirror, ${mirror.join('  ')}, too.` : ''}
          </Text>
        </>
      )}

      {/* The order names are published in is the one thing that makes a book
          read strangely afterwards, and it is invisible until somebody says
          so. A variation named under an unnamed opening inherits nothing. */}
      {curator.active && line.length > 1 && !parentNamed && (
        <View style={styles.nudge}>
          <Text style={styles.nudgeText}>
            {parent.join('  ')} has no name yet, so this would be a variation of nothing. Naming
            that first is usually the better order.
          </Text>
          <GhostButton compact label="NAME THAT FIRST" onPress={() => onOpenLine(parent)} />
        </View>
      )}

      {suggestions.length > 0 && !published && (
        <View style={styles.suggestions}>
          {suggestions.map((suggestion) => (
            <SuggestionRow curator={curator} key={suggestion.suggestionId} suggestion={suggestion} />
          ))}
        </View>
      )}

      <View style={[ui.formRow, styles.form]}>
        <NameInput
          accessibilityLabel={curator.active ? 'Published opening name' : 'Suggested opening name'}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          placeholder={published ? published.name : 'e.g. The Skipping Stone'}
          returnKeyType="send"
          value={draft}
        />
        <PrimaryButton
          compact
          disabled={!trimmed || (curator.active && trimmed === published?.name)}
          label={curator.active ? (published ? 'RENAME' : 'PUBLISH') : 'SUGGEST'}
          loading={curator.active ? lineIsBusy : suggesting}
          onPress={submit}
        />
        {curator.active && published && (
          <GhostButton
            compact
            disabled={curator.busy === `remove:${line.join(' ')}`}
            label="REMOVE"
            onPress={() => curator.remove(line)}
          />
        )}
      </View>
    </Panel>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: 2, padding: 18, gap: 8 },
  heading: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  publishedName: { color: colors.textStrong, fontSize: 20, fontWeight: '900' },
  prompt: { color: colors.textStrong, fontSize: 17, fontWeight: '900' },
  nudge: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.small,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.goldBorder,
    borderRadius: radius.medium,
    backgroundColor: colors.goldSurfaceDeep,
  },
  nudgeText: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 220,
    minWidth: 0,
    color: colors.goldSoft,
    fontSize: 11,
    lineHeight: 17,
  },
  suggestions: { gap: 6, marginTop: 4 },
  form: { marginTop: 4 },
});
