import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Link, useRouter } from 'expo-router';

import MiniBoard from '@/features/board/MiniBoard';
import { modeBackground, modeCover, modeLooks } from '@/features/board/modeArt';
import { gridFromRows } from '@/engine/analysisGame';
import { alphabetFor, modeDefinitionFor } from '@/engine/spec/interpret';
import { LAB_ENABLED } from '@/featureFlags';
import { useSettled } from '@/hooks/useSettled';
import { useSettledSearchParams } from '@/navigation/useSettledSearchParams';
import { links } from '@/navigation/links';
import { listLibraryModes, type LibraryMode } from '@/store/api/lab';
import { useGameStore } from '@/store/gameStore';
import { defaultTimeControlOf } from '@/store/setupSelectors';
import { colors, contentWidth, radius, space, type } from '@/theme';
import {
  Badge,
  Banner,
  EmptyState,
  GhostButton,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';
import ScreenShell from '@/ui/ScreenShell';
import { failureMessage } from '@/errors';

// Every mode people have made, and the three things you can do with one.
//
// A card per mode, and the card *is* the mode: the board it is played on, drawn
// at a size you can read, with the rules bulleted underneath. A row of names and
// descriptions would be a list of documents; this is a shelf of games.
//
// The three doors, in the order they matter: play a stranger, try it against the
// search, or fork it into the Lab and make it yours. The last is the one that
// makes a library rather than a gallery.

/** The rules in a handful of lines, for the card. */
const describeMode = (mode: LibraryMode): string[] => {
  const spec = mode.spec;
  const lines: string[] = [];
  lines.push(`${spec.board.width}×${spec.board.height} board, ${spec.pieces.length} kind${spec.pieces.length === 1 ? '' : 's'}: ${spec.pieces.map((piece) => piece.name).join(', ')}`);

  const movement = spec.movement.map((rule) => {
    const who = rule.piece === undefined ? 'Everything' : [rule.piece].flat().join(' and ');
    switch (rule.kind) {
      case 'slide':
        return `${who} slides up to ${rule.maxDistance ?? 'any distance'}`;
      case 'leap':
        return `${who} leaps`;
      case 'jumpOver':
        return `${who} jumps over the piece in front${rule.captureJumped ? ', taking it' : ''}`;
      default:
        return `${who} steps ${rule.distance && rule.distance > 1 ? `${rule.distance} squares` : 'one square'}`;
    }
  });
  lines.push(...movement);

  if (spec.capture?.mode === 'never') lines.push('Nothing is ever captured');
  else if (spec.capture?.mode === 'always') lines.push('Anything takes anything');
  else if (spec.beats.length > 0) {
    lines.push(
      spec.beats.length <= 4
        ? spec.beats.map(([attacker, defender]) => `${attacker} takes ${defender}`).join('; ')
        : `${spec.beats.length} capture matchups`,
    );
  }
  for (const condition of spec.win) {
    lines.push(`Wins by ${condition.reason ?? condition.id ?? 'a rule of its own'}`);
  }
  return lines.slice(0, 6);
};

function ModeCard({ mode, onPlay }: { mode: LibraryMode; onPlay: (mode: LibraryMode) => void }) {
  const grid = useMemo(
    () => gridFromRows(mode.spec.startingPosition.rows, alphabetFor(mode.spec)),
    [mode.spec],
  );
  const definition = useMemo(() => modeDefinitionFor(mode.spec, mode.modeId), [mode]);
  const bullets = useMemo(() => describeMode(mode), [mode]);
  // A cover leads the card when there is one; the opening board is what the
  // card has always shown and stays the fallback, so a mode with no picture —
  // or one that has been taken down — reads exactly as it did before.
  const [coverFailed, setCoverFailed] = useState<string | null>(null);
  const declared = modeCover({ spec: mode.spec });
  const cover = declared && declared !== coverFailed ? declared : undefined;

  return (
    <Panel>
      <View style={styles.card}>
        {/*
          The depiction gets its own column at a size worth looking at, and it
          drives the card's height. A panel whose only description of the thing
          it is about is a line of text has not earned its place.
        */}
        <View style={styles.cardBoard}>
          {cover ? (
            <Image
              accessibilityIgnoresInvertColors
              accessible={false}
              onError={() => setCoverFailed(cover)}
              resizeMode="cover"
              source={{ uri: cover }}
              style={styles.cardCover}
            />
          ) : null}
          <MiniBoard
            boardBackground={modeBackground({ spec: mode.spec })}
            grid={grid}
            modeId={definition.id}
            pieceLooks={modeLooks({ spec: mode.spec })}
            size={cover ? 96 : 168}
          />
        </View>
        <View style={styles.cardBody}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>{mode.name}</Text>
            <Badge label={mode.shortCode.toUpperCase()} tone="neutral" />
            {mode.plays > 0 ? <Badge label={`${mode.plays} PLAYED`} tone="cool" /> : null}
          </View>
          <Text style={styles.cardBy}>
            by {mode.ownerUsername || 'somebody'}
            {mode.derivedFrom?.length ? ` · built on ${mode.derivedFrom.join(', ')}` : ''}
          </Text>
          <Text style={styles.cardObjective}>{mode.objective}</Text>
          {bullets.map((line) => (
            <Text key={line} style={styles.bullet}>
              • {line}
            </Text>
          ))}
          <View style={styles.cardButtons}>
            <PrimaryButton label="PLAY A FRIEND" onPress={() => onPlay(mode)} />
            <Link href={links.lab({ fork: mode.modeId })} asChild>
              <Pressable accessibilityRole="button" style={styles.forkButton}>
                <Text style={styles.forkLabel}>FORK INTO THE LAB</Text>
              </Pressable>
            </Link>
          </View>
        </View>
      </View>
    </Panel>
  );
}

export default function LibraryScreen() {
  const settled = useSettled();
  if (!LAB_ENABLED) {
    return (
      <ScreenShell width={contentWidth.reading}>
        <Panel>
          <SectionHeading eyebrow="LIBRARY" title="Not open yet" />
          <Text style={styles.muted}>
            Modes people have designed will be listed here once the Lab opens.
          </Text>
        </Panel>
      </ScreenShell>
    );
  }
  if (!settled) {
    return (
      <ScreenShell width={contentWidth.page}>
        <Panel>
          <SectionHeading eyebrow="LIBRARY" title="Modes people made" />
          <Text style={styles.muted}>Loading…</Text>
        </Panel>
      </ScreenShell>
    );
  }
  return <Library />;
}

function Library() {
  const router = useRouter();
  const { params } = useSettledSearchParams<{ mode?: string }>();
  const [search, setSearch] = useState('');
  const [modes, setModes] = useState<LibraryMode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const postOpenChallenge = useGameStore((state) => state.postOpenChallenge);
  const defaultTimeControl = useGameStore((state) => state.defaultTimeControl);

  const load = useCallback(async (term: string) => {
    try {
      setError(null);
      const { modes: found } = await listLibraryModes({ search: term, limit: 40 });
      setModes(found);
    } catch (failure) {
      setError(failureMessage(failure, 'Could not load the library'));
      setModes([]);
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  /**
   * Post a challenge in this mode.
   *
   * The mode id is all it takes: a published mode is an ordinary registered
   * mode, so the challenge, the queue and the game screen need to know nothing
   * about the library. That is the whole reason `SpecMode` implements
   * `GameMode` rather than being something new.
   */
  const play = (mode: LibraryMode) => {
    postOpenChallenge({
      modeId: mode.modeId,
      timeControl: defaultTimeControlOf(defaultTimeControl),
      // Left empty on purpose: the server fills the board in from the mode, so
      // both sides of a pairing describe the same game without either of them
      // having to send a layout the other might spell differently.
      startingPosition: { rows: [] },
      rules: {},
      // Custom modes are casual. Ratings are per mode, and an unbounded set of
      // modes would be an unbounded set of rating pools.
      casual: true,
    });
    router.push(links.lobby());
  };

  const highlighted = params.mode;
  const listed = useMemo(() => {
    if (!modes) return null;
    if (!highlighted) return modes;
    // A link to one mode puts it first rather than hiding the rest: somebody
    // arriving from a shared link is usually about to browse.
    return [...modes].sort((first, second) =>
      first.modeId === highlighted ? -1 : second.modeId === highlighted ? 1 : 0,
    );
  }, [modes, highlighted]);

  return (
    <ScreenShell width={contentWidth.page}>
      <Panel>
        <SectionHeading
          eyebrow="LIBRARY"
          title="Modes people made"
          trailing={
            <Link href={links.lab()} asChild>
              <Pressable accessibilityRole="button" style={styles.forkButton}>
                <Text style={styles.forkLabel}>MAKE ONE</Text>
              </Pressable>
            </Link>
          }
        />
        <Text style={styles.muted}>
          Every one of these was designed in the Lab and published from it. Play one against a
          friend, or fork it and make it yours.
        </Text>
        <View style={styles.searchRow}>
          <TextInput
            accessibilityLabel="Search the mode library"
            onChangeText={setSearch}
            onSubmitEditing={() => void load(search)}
            placeholder="Search by name or objective"
            placeholderTextColor={colors.textFaint}
            style={styles.search}
            value={search}
          />
          <GhostButton label="SEARCH" onPress={() => void load(search)} />
        </View>
      </Panel>

      {error ? <Banner message={error} tone="error" /> : null}

      {listed === null ? (
        <Panel>
          <Text style={styles.muted}>Loading the library…</Text>
        </Panel>
      ) : listed.length === 0 ? (
        <EmptyState
          title="Nothing published yet"
          detail="Be the first: open the Lab, design a game with the agent, and publish it."
        />
      ) : (
        <View style={styles.grid}>
          {listed.map((mode) => (
            <ModeCard key={mode.modeId} mode={mode} onPlay={play} />
          ))}
        </View>
      )}
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  muted: { ...type.meta, color: colors.textDim },
  searchRow: { flexDirection: 'row', gap: space.small, marginTop: space.small, alignItems: 'center' },
  search: {
    backgroundColor: colors.surfaceWell,
    borderColor: colors.border,
    borderRadius: radius.small,
    borderWidth: 1,
    color: colors.text,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    paddingHorizontal: space.small,
    paddingVertical: 8,
  },
  grid: { gap: space.medium, marginTop: space.medium },
  card: { flexDirection: 'row', flexWrap: 'wrap', gap: space.medium, alignItems: 'flex-start' },
  // The board keeps its size and the text takes what is left; on a phone the
  // wrap puts the board first, which is where it has to be.
  cardBoard: { flexGrow: 0, flexShrink: 0, gap: space.snug },
  cardCover: { borderRadius: radius.medium, height: 96, width: 168 },
  cardBody: { flexGrow: 1, flexBasis: 260, minWidth: 0, gap: 2 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.snug, flexWrap: 'wrap' },
  cardTitle: { ...type.cardTitle, color: colors.textStrong },
  cardBy: { ...type.meta, color: colors.textMuted },
  cardObjective: { ...type.body, color: colors.textSoft, marginTop: space.tight },
  bullet: { ...type.meta, color: colors.textDim },
  cardButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.small, marginTop: space.small },
  forkButton: {
    borderColor: colors.borderStrong,
    borderRadius: radius.small,
    borderWidth: 1,
    paddingHorizontal: space.medium,
    paddingVertical: 8,
  },
  forkLabel: { ...type.label, color: colors.textSoft },
});
