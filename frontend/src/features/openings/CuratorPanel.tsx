// The curator's desk: everything that needs a name, in the order it wants one.
//
// This used to be a JSON textarea with a name field under it. Books arrive
// from a shell now -- `build_books.sh --publish` -- so what is left is the
// part a person actually does by hand, and it is worth a real surface:
//
//   1. The moves in front of you, each with a box to name it in. Naming
//      twenty first moves is twenty keystrokes and no navigation.
//   2. Everything anybody has proposed anywhere in the book, shallowest line
//      first, because that is the order names want to be published in: an
//      opening, then its defenses, then their variations. A line whose parent
//      is still unnamed says so, rather than letting the order go wrong
//      quietly and read as though a name went missing.
//
// Both of them publish through the same four verbs -- see `useOpeningCurator`
// -- so the page is already in step by the time the button stops spinning.

import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import MiniBoard from '@/features/board/MiniBoard';
import type { OpeningLine, OpeningMoveView, OpeningNaming, OpeningSuggestionGroup } from '@/engine/openingBook';
import { openingKind } from '@/engine/openingBook';
import {
  gameAfterWalk,
  lastStepOfWalk,
  walkOpeningLine,
  type OpeningStep,
} from '@/engine/openingLine';
import { colors, radius, space } from '@/theme';
import type { ModeDefinition, ModeID } from '@/types/game';
import { Badge, GhostButton, Panel, PrimaryButton } from '@/ui/primitives';

import { NameInput, SuggestionRow, ui } from './openingsUi';
import type { OpeningCurator } from './useOpeningCurator';

const ROW_BOARD = 48;
const QUEUE_BOARD = 64;
/** How many waiting lines to draw before asking for a narrower question. */
const QUEUE_SHOWN = 12;

const PUBLISH_COMMAND =
  'RPS_API_URL=… RPS_ADMIN_TOKEN=… scripts/build_books.sh --publish --skip-survey';

export interface CuratorPanelProps {
  curator: OpeningCurator;
  line: OpeningLine;
  mode: ModeDefinition | null;
  modeId: ModeID;
  /** The ranked moves of the position on screen. */
  moves: OpeningMoveView[];
  /** Their boards, already replayed by the screen for its cards. */
  moveBoards: Map<string, OpeningStep | null>;
  naming: OpeningNaming;
  onOpenLine: (line: OpeningLine) => void;
  onRefresh: () => void;
  refreshing: boolean;
}

export default function CuratorPanel({
  curator,
  line,
  mode,
  modeId,
  moves,
  moveBoards,
  naming,
  onOpenLine,
  onRefresh,
  refreshing,
}: CuratorPanelProps) {
  const [tokenDraft, setTokenDraft] = useState('');
  const [showAll, setShowAll] = useState(false);
  const queue = showAll ? naming.queue : naming.queue.slice(0, QUEUE_SHOWN);

  const unlock = async () => {
    if (!tokenDraft.trim()) return;
    if (await curator.admin.unlock(tokenDraft)) setTokenDraft('');
  };

  return (
    <Panel style={styles.panel}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={ui.eyebrow}>CURATOR STUDIO</Text>
          <Text style={styles.title}>Name the book</Text>
        </View>
        <View style={styles.headerMeta}>
          <Badge label={`${naming.namedCount} NAMED`} tone="accent" />
          <Badge
            label={`${naming.pendingCount} WAITING`}
            tone={naming.pendingCount > 0 ? 'gold' : 'neutral'}
          />
          <GhostButton compact disabled={refreshing} label="REFRESH" onPress={onRefresh} />
        </View>
      </View>

      {!curator.admin.unlocked ? (
        <View style={ui.formRow}>
          <NameInput
            accessibilityLabel="Opening curator admin token"
            onChangeText={setTokenDraft}
            onSubmitEditing={unlock}
            placeholder="Admin token"
            secureTextEntry
            value={tokenDraft}
          />
          <PrimaryButton
            compact
            disabled={!tokenDraft.trim()}
            label="UNLOCK"
            loading={curator.admin.verifying}
            onPress={unlock}
          />
        </View>
      ) : !curator.active ? (
        <Text style={ui.hint}>
          Curator controls are switched off. The toggle at the top of the page brings the naming
          boxes back.
        </Text>
      ) : (
        <View style={styles.sections}>
          {moves.length > 0 && (
            <View>
              <Text style={ui.fieldLabel}>
                {line.length === 0 ? 'NAME THE FIRST MOVES' : 'NAME THE REPLIES IN FRONT OF YOU'}
              </Text>
              <View style={styles.rows}>
                {moves.map((move) => (
                  <MoveNameRow
                    after={moveBoards.get(move.move) ?? null}
                    curator={curator}
                    key={move.move}
                    line={[...line, move.move]}
                    modeId={modeId}
                    naming={naming}
                    notation={move.move}
                    onOpenLine={onOpenLine}
                    rank={move.rank}
                  />
                ))}
              </View>
            </View>
          )}

          <View>
            <Text style={ui.fieldLabel}>WAITING FOR A NAME</Text>
            {naming.queue.length === 0 ? (
              <Text style={ui.hint}>
                Nothing is waiting. Every name anybody has put forward has been published or turned
                down.
              </Text>
            ) : (
              <>
                <View style={styles.rows}>
                  {queue.map((group) => (
                    <QueueGroup
                      curator={curator}
                      group={group}
                      key={group.line.join(' ')}
                      mode={mode}
                      modeId={modeId}
                      onOpenLine={onOpenLine}
                    />
                  ))}
                </View>
                {naming.queue.length > QUEUE_SHOWN && (
                  <View style={styles.more}>
                    <GhostButton
                      compact
                      label={
                        showAll
                          ? 'SHOW THE FIRST TWELVE'
                          : `SHOW ALL ${naming.queue.length} LINES`
                      }
                      onPress={() => setShowAll(!showAll)}
                    />
                  </View>
                )}
              </>
            )}
          </View>

          {/*<View>*/}
          {/*  <Text style={ui.fieldLabel}>IMPORTING A NEW SCAN</Text>*/}
          {/*  <Text style={ui.hint}>*/}
          {/*    Books are published from the shell — the export is around ten megabytes, which is not*/}
          {/*    something to paste. Every human name survives a re-import.*/}
          {/*  </Text>*/}
          {/*  <CopyableCommand />*/}
          {/*</View>*/}
        </View>
      )}
    </Panel>
  );
}

/** One candidate move, with a box to name the line it starts. */
function MoveNameRow({
  after,
  curator,
  line,
  modeId,
  naming,
  notation,
  onOpenLine,
  rank,
}: {
  after: OpeningStep | null;
  curator: OpeningCurator;
  line: OpeningLine;
  modeId: ModeID;
  naming: OpeningNaming;
  notation: string;
  onOpenLine: (line: OpeningLine) => void;
  rank: number;
}) {
  const published = naming.nameFor(line);
  const title = naming.titleFor(line);
  const suggestions = naming.suggestionsFor(line);
  const [draft, setDraft] = useState(published?.name ?? '');

  useEffect(() => {
    setDraft(published?.name ?? '');
  }, [published?.name, line.join(' ')]);

  const trimmed = draft.trim();
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityLabel={`Open ${notation}`}
        accessibilityRole="button"
        onPress={() => onOpenLine(line)}
        style={({ pressed }) => [styles.rowBoard, pressed && ui.pressed]}
      >
        {after ? (
          <MiniBoard
            capture={after.captured}
            grid={after.game.grid}
            modeId={modeId}
            move={after.move}
            mover={after.mover}
            size={ROW_BOARD}
          />
        ) : (
          <View style={[styles.rowBoardMissing, { height: ROW_BOARD, width: ROW_BOARD }]} />
        )}
      </Pressable>
      <View style={styles.rowCopy}>
        <View style={styles.rowHeadline}>
          <Text style={styles.rowRank}>{rank}</Text>
          <Text style={styles.rowNotation}>{notation}</Text>
          {published ? (
            <Badge label="NAMED" tone="accent" />
          ) : suggestions.length > 0 ? (
            <Badge label={`${suggestions.length} PUT FORWARD`} tone="gold" />
          ) : null}
        </View>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {published ? published.name : title.inherited ? title.label : 'Unnamed line'}
        </Text>
        <View style={ui.formRow}>
          <NameInput
            accessibilityLabel={`Name for ${notation}`}
            onChangeText={setDraft}
            onSubmitEditing={() => trimmed && curator.publish(line, trimmed)}
            placeholder="Name this line"
            returnKeyType="send"
            value={draft}
          />
          <PrimaryButton
            compact
            disabled={!trimmed || trimmed === published?.name}
            label={published ? 'RENAME' : 'PUBLISH'}
            loading={curator.busy === `publish:${line.join(' ')}`}
            onPress={() => trimmed && curator.publish(line, trimmed)}
          />
          {published && (
            <GhostButton
              compact
              disabled={curator.busy === `remove:${line.join(' ')}`}
              label="REMOVE"
              onPress={() => curator.remove(line)}
            />
          )}
        </View>
        {!published && suggestions.length > 0 && (
          <View style={styles.rowSuggestions}>
            {suggestions.map((suggestion) => (
              <SuggestionRow
                curator={curator}
                key={suggestion.suggestionId}
                suggestion={suggestion}
              />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

/** One line with names waiting on it, wherever in the book it sits. */
function QueueGroup({
  curator,
  group,
  mode,
  modeId,
  onOpenLine,
}: {
  curator: OpeningCurator;
  group: OpeningSuggestionGroup;
  mode: ModeDefinition | null;
  modeId: ModeID;
  onOpenLine: (line: OpeningLine) => void;
}) {
  const walk = useMemo(() => walkOpeningLine(mode, group.line), [mode, group.line.join(' ')]);
  const step = lastStepOfWalk(walk);
  const game = gameAfterWalk(walk);
  const parent = group.line.slice(0, -1);

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityLabel={`Open ${group.line.join(' ')}`}
        accessibilityRole="button"
        onPress={() => onOpenLine(group.line)}
        style={({ pressed }) => [styles.rowBoard, pressed && ui.pressed]}
      >
        {game ? (
          <MiniBoard
            capture={step?.captured}
            grid={game.grid}
            modeId={modeId}
            move={step?.move}
            mover={step?.mover}
            size={QUEUE_BOARD}
          />
        ) : (
          <View style={[styles.rowBoardMissing, { height: QUEUE_BOARD, width: QUEUE_BOARD }]} />
        )}
      </Pressable>
      <View style={styles.rowCopy}>
        <View style={styles.rowHeadline}>
          <Text style={styles.rowNotation}>{group.line.join('  ')}</Text>
          <Badge label={openingKind(group.line).toUpperCase()} />
          <GhostButton compact label="OPEN" onPress={() => onOpenLine(group.line)} />
        </View>
        {group.parentUnnamed ? (
          <Text style={styles.rowWarning}>
            {parent.join('  ')} has no name yet — naming that first makes this a variation of
            something.
          </Text>
        ) : group.ancestor ? (
          <Text style={styles.rowTitle}>Sits under {group.ancestor.name}</Text>
        ) : (
          <Text style={styles.rowTitle}>A first move: this one names a family.</Text>
        )}
        <View style={styles.rowSuggestions}>
          {group.suggestions.map((suggestion) => (
            <SuggestionRow curator={curator} key={suggestion.suggestionId} suggestion={suggestion} />
          ))}
        </View>
      </View>
    </View>
  );
}

/** The one command that publishes a scan, and a button that copies it. */
function CopyableCommand() {
  const [copied, setCopied] = useState(false);
  return (
    <Pressable
      accessibilityLabel="Copy the publish command"
      accessibilityRole="button"
      onPress={async () => {
        try {
          await Clipboard.setStringAsync(PUBLISH_COMMAND);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
      style={({ pressed }) => [styles.command, pressed && ui.pressed]}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={styles.commandText}>{PUBLISH_COMMAND}</Text>
      </ScrollView>
      <Text style={styles.commandHint}>{copied ? 'COPIED' : 'TAP TO COPY'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: 4, padding: 18, gap: 14 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: space.small,
  },
  headerCopy: { flexGrow: 1, flexShrink: 1, flexBasis: 180, minWidth: 0 },
  headerMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
  title: { color: colors.textStrong, fontSize: 18, fontWeight: '900', marginTop: 4 },
  sections: { gap: 22 },
  rows: { gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceSunken,
  },
  rowBoard: { borderRadius: 4, overflow: 'hidden' },
  rowBoardMissing: { borderRadius: 4, backgroundColor: colors.surfaceDeep },
  // The copy column has to be allowed to shrink, or a long name pushes the
  // whole row past the panel instead of wrapping inside it.
  rowCopy: { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0, gap: 6 },
  rowHeadline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
  rowRank: { color: colors.textFaint, fontSize: 9, fontWeight: '900' },
  rowNotation: { color: colors.textStrong, fontSize: 13, fontWeight: '900' },
  rowTitle: { color: colors.textMuted, fontSize: 11 },
  rowWarning: { color: colors.goldSoft, fontSize: 11, lineHeight: 16 },
  rowSuggestions: { gap: 6 },
  more: { alignItems: 'center', marginTop: 10 },
  command: {
    marginTop: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceDeep,
  },
  commandText: { color: colors.accentSoft, fontFamily: 'monospace', fontSize: 11 },
  commandHint: {
    color: colors.textFaint,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
    marginTop: 6,
  },
});
