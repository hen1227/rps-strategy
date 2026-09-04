// What this line is called, and how it gets called something else.
//
// One panel, three audiences. A curator publishes and renames. A visitor
// *names* an unnamed line outright -- no queue, because a proposal that sits
// invisible until somebody happens to look is a question the site asked and
// then ignored. And where naming is not on offer, a visitor suggests: the two
// cases are a line somebody has already named, where the answer to disagreeing
// is to propose an alternative rather than to overwrite, and a line longer
// than a name should describe.

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { PLAYER_NAME_PLY_LIMIT, type OpeningLine, type OpeningNaming } from '@/engine/openingBook';
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
  /**
   * Name the line outright. Resolves false when it was refused -- somebody
   * naming it first, most likely -- so the draft stays put.
   */
  onName: (name: string) => Promise<boolean>;
  /** Resolves false when the proposal was not accepted, so the draft stays. */
  onSuggest: (name: string) => Promise<boolean>;
  suggesting: boolean;
}

export default function NamePanel({
  curator,
  line,
  naming,
  onOpenLine,
  onName,
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
  // Naming is on offer for an unnamed line short enough to be an opening.
  // Where "book" ends is genuinely unclear, so this does not try to find that
  // ply -- it picks a length at which a name still describes an idea rather
  // than a game. Past it, the honest answer is that the position has no name.
  const tooLong = line.length > PLAYER_NAME_PLY_LIMIT;
  const canName = !curator.active && !published && !tooLong;
  const submit = () => {
    if (!trimmed) return;
    if (curator.active) {
      curator.publish(line, trimmed);
      return;
    }
    const send = canName ? onName : onSuggest;
    send(trimmed).then((sent) => sent && setDraft(''));
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
          <Text style={styles.prompt}>
            {tooLong ? 'This line is past naming.' : 'This line needs a name.'}
          </Text>
          <Text style={ui.hint}>
            {tooLong
              ? `Names cover the first ${PLAYER_NAME_PLY_LIMIT} moves. Past that a line is a game rather than an opening, so there is no name to give it — walk back up and name the opening it came from.`
              : title.namedAncestor
                ? `It currently lives under ${title.namedAncestor.name}. Name a defense, gambit, variation—or something stranger.`
                : 'Chess has openings, defenses, gambits, and systems. We can borrow the structure without borrowing the seriousness.'}
            {!tooLong && mirror ? ` Naming it names its mirror, ${mirror.join('  ')}, too.` : ''}
          </Text>
          {canName ? (
            <Text style={ui.hint}>
              Your name goes up straight away, whether or not RPSFish has analyzed this line. It
              is listed under every named opening rather than beside the engine’s certified ones.
            </Text>
          ) : null}
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
          accessibilityLabel={
            curator.active
              ? 'Published opening name'
              : canName
                ? 'Opening name'
                : 'Suggested opening name'
          }
          editable={!tooLong || curator.active}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          placeholder={published ? published.name : 'e.g. The Skipping Stone'}
          returnKeyType="send"
          value={draft}
        />
        <PrimaryButton
          compact
          disabled={
            !trimmed ||
            (curator.active && trimmed === published?.name) ||
            (tooLong && !curator.active)
          }
          label={
            curator.active ? (published ? 'RENAME' : 'PUBLISH') : canName ? 'NAME IT' : 'SUGGEST'
          }
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
