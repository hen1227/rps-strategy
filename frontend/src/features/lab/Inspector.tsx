import { memo, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import PieceIcon from '@/features/board/PieceIcon';
import { modeLooks } from '@/features/board/modeArt';
import { reachOf } from './moveReach';
import { colors, radius, space, type } from '@/theme';
import { OptionChips } from '@/ui/primitives';
import type { SimulateReport } from '@/engine/spec/simulate';
import type {
  BeatsEdge,
  Directions,
  MovementRule,
  PieceKindSpec,
  RuleSpec,
  WinCondition,
} from '@/engine/spec/types';
import type { LabSpotlight } from '@/store/labSession';
import type { Piece } from '@/types/game';

// The parts of a mode a board cannot draw.
//
// The board on the stage shows the shape, the pieces and where they start. Four
// things it cannot show are the rest of the game: what each kind is, who takes
// whom, how they move, and how anybody wins. This is those four, one tab each.
//
// The rule every tab keeps: **show the thing, do not describe it.** So the beats
// graph is a grid of the pieces themselves rather than a list of pairs, and a
// movement rule carries a little board with its own reach drawn on it rather
// than the words "slide, diagonal, up to three". A row of prose about a rule is
// a row an author has to translate before they can judge it.
//
// The second rule: **say what the playtest found, here, next to the rule it is
// about.** `lab_simulate` already reports which rules never fired, and that is
// the one thing about a mode nobody can get by reading it — it has no business
// being a sentence in a list somewhere else.
//
// What this deliberately does *not* edit is `when` — the predicate that can hang
// off any rule. A predicate is a small language with quantifiers in it, and a
// form that covered it would be a worse editor than the JSON. The agent writes
// those, and the JSON editor shows them; everything structural is here.

export type InspectorTab = 'pieces' | 'beats' | 'moves' | 'winning';

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'pieces', label: 'PIECES' },
  { id: 'beats', label: 'BEATS' },
  { id: 'moves', label: 'MOVES' },
  { id: 'winning', label: 'WINNING' },
];

export interface InspectorProps {
  spec: RuleSpec;
  simulation: SimulateReport | null;
  spotlight: LabSpotlight | null;
  /** Commit a change. Goes through `lab_patch_spec`, like everything else. */
  onPatch: (patch: Partial<RuleSpec>, what: string) => void;
  /** Point the board at something, or nowhere. */
  onSpotlight: (spotlight: { piece?: string; path?: string; note: string } | null) => void;
}

/* ------------------------------------------------------------------ helpers -- */

/** How many of each symbol are on the opening board right now. */
const countsOf = (spec: RuleSpec): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of spec.startingPosition?.rows ?? []) {
    for (const symbol of row) counts[symbol] = (counts[symbol] ?? 0) + 1;
  }
  return counts;
};

/** A free letter for a new kind, so adding one never collides. */
const freeSymbol = (spec: RuleSpec): string => {
  const taken = new Set((spec.pieces ?? []).map((piece) => piece.symbol.toUpperCase()));
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find((letter) => !taken.has(letter)) ?? 'X';
};

const freeId = (spec: RuleSpec, name: string): string => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'kind';
  const taken = new Set((spec.pieces ?? []).map((piece) => piece.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
};

const DIRECTION_NAMES = [
  'all8',
  'orthogonal',
  'diagonal',
  'forward',
  'forwardDiagonal',
  'backward',
  'sideways',
] as const;

/** The named direction sets, or `custom` for a rule written with offsets. */
const dirsKey = (dirs: Directions): string =>
  typeof dirs === 'string' ? dirs : 'custom';

const MOVE_KINDS = ['step', 'slide', 'leap', 'jumpOver'] as const;

/** A rule's distance knob, whichever of the two names it goes by. */
const distanceOf = (rule: MovementRule): number | null => {
  if (rule.kind === 'step') return rule.distance ?? 1;
  if (rule.kind === 'slide') return rule.maxDistance ?? 0;
  return null;
};

const withDistance = (rule: MovementRule, value: number): MovementRule =>
  rule.kind === 'step'
    ? { ...rule, distance: value }
    : rule.kind === 'slide'
      ? { ...rule, maxDistance: value }
      : rule;

/* -------------------------------------------------------------------- shell -- */

function Inspector({ spec, simulation, spotlight, onPatch, onSpotlight }: InspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('pieces');
  const counts = useMemo(() => countsOf(spec), [spec]);
  const looks = modeLooks({ spec });

  return (
    <View style={styles.inspector}>
      <View style={styles.tabs}>
        {TABS.map((option) => (
          <Pressable
            accessibilityRole="tab"
            // `aria-selected` rather than `accessibilityState`: react-native-web
            // does not turn the latter into an attribute here, so a screen
            // reader is told these are tabs and never told which one is open.
            aria-selected={tab === option.id}
            key={option.id}
            onPress={() => setTab(option.id)}
            style={[styles.tab, tab === option.id && styles.tabOn]}
          >
            <Text style={[styles.tabText, tab === option.id && styles.tabTextOn]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {tab === 'pieces' ? (
          <PiecesTab
            counts={counts}
            looks={looks}
            onPatch={onPatch}
            onSpotlight={onSpotlight}
            simulation={simulation}
            spec={spec}
            spotlight={spotlight}
          />
        ) : null}
        {tab === 'beats' ? (
          <BeatsTab looks={looks} onPatch={onPatch} spec={spec} />
        ) : null}
        {tab === 'moves' ? (
          <MovesTab
            looks={looks}
            onPatch={onPatch}
            onSpotlight={onSpotlight}
            simulation={simulation}
            spec={spec}
            spotlight={spotlight}
          />
        ) : null}
        {tab === 'winning' ? (
          <WinningTab
            onPatch={onPatch}
            onSpotlight={onSpotlight}
            simulation={simulation}
            spec={spec}
            spotlight={spotlight}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

export default memo(Inspector);

/* ------------------------------------------------------------------ pieces -- */

type Looks = ReturnType<typeof modeLooks>;

function PiecesTab({
  spec,
  counts,
  looks,
  simulation,
  spotlight,
  onPatch,
  onSpotlight,
}: {
  spec: RuleSpec;
  counts: Record<string, number>;
  looks: Looks;
  simulation: SimulateReport | null;
  spotlight: LabSpotlight | null;
  onPatch: InspectorProps['onPatch'];
  onSpotlight: InspectorProps['onSpotlight'];
}) {
  const pieces = spec.pieces ?? [];

  const edit = (index: number, change: Partial<PieceKindSpec>, what: string) => {
    const next = pieces.map((piece, at) => (at === index ? { ...piece, ...change } : piece));
    onPatch({ pieces: next }, what);
  };

  const add = () => {
    const name = `Kind ${pieces.length + 1}`;
    const kind: PieceKindSpec = { id: freeId(spec, name), name, symbol: freeSymbol(spec) };
    onPatch({ pieces: [...pieces, kind] }, `added ${name}`);
  };

  /**
   * Removing a kind takes its edges with it.
   *
   * A `beats` edge naming a kind that is gone is an error the validator reports
   * against `beats`, which is true and is not what the author did. Taking them
   * out here means removing a piece leaves a mode that still validates.
   */
  const remove = (index: number) => {
    const kind = pieces[index];
    if (!kind) return;
    onPatch(
      {
        pieces: pieces.filter((_unused, at) => at !== index),
        beats: (spec.beats ?? []).filter(
          (edge) => edge[0] !== kind.id && edge[1] !== kind.id,
        ),
      },
      `removed ${kind.name || kind.id}`,
    );
  };

  return (
    <View style={styles.rows}>
      {pieces.map((piece, index) => {
        const idle = simulation?.piecesThatNeverMoved.includes(piece.id) ?? false;
        const lit = spotlight?.piece === piece.id;
        const onBoard =
          (counts[piece.symbol.toUpperCase()] ?? 0) + (counts[piece.symbol.toLowerCase()] ?? 0);
        return (
          // A View, not a Pressable: the remove button and the two inputs are
          // inside it, and a button inside a button is invalid DOM that React
          // refuses on the web. What is pressable is the icon beside them.
          <View key={piece.id} style={[styles.row, lit && styles.rowLit]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Point at every ${piece.name || piece.id}`}
              onPress={() =>
                onSpotlight(
                  lit ? null : { piece: piece.id, note: `Every ${piece.name || piece.id}` },
                )
              }
            >
              <PieceIcon color="Red" look={looks?.[piece.id]} piece={piece.id as Piece} size={26} />
            </Pressable>
            <View style={styles.rowBody}>
              <TextInput
                accessibilityLabel="Name of this kind"
                onChangeText={(value) => edit(index, { name: value }, 'renamed a kind')}
                style={styles.name}
                value={piece.name}
              />
              <Text style={styles.meta}>
                {onBoard} on the board
                {idle ? ' · never moved in the playtest' : ''}
              </Text>
            </View>
            <TextInput
              accessibilityLabel="The letter this kind is written with"
              maxLength={1}
              onChangeText={(value) =>
                value.trim() &&
                edit(index, { symbol: value.trim().toUpperCase() }, 're-lettered a kind')
              }
              style={styles.symbol}
              value={piece.symbol.toUpperCase()}
            />
            <Pressable
              accessibilityLabel={`Remove ${piece.name || piece.id}`}
              accessibilityRole="button"
              disabled={pieces.length <= 1}
              onPress={() => remove(index)}
              style={styles.remove}
            >
              <Text style={[styles.removeText, pieces.length <= 1 && styles.removeOff]}>×</Text>
            </Pressable>
          </View>
        );
      })}

      <Pressable accessibilityRole="button" onPress={add} style={styles.addRow}>
        <Text style={styles.addText}>+ ADD A KIND</Text>
      </Pressable>
    </View>
  );
}

/* ------------------------------------------------------------------- beats -- */

function BeatsTab({
  spec,
  looks,
  onPatch,
}: {
  spec: RuleSpec;
  looks: Looks;
  onPatch: InspectorProps['onPatch'];
}) {
  const pieces = spec.pieces ?? [];
  const beats = spec.beats ?? [];
  // Measured rather than fixed. A three-piece grid at a fixed cell size is a
  // small square in the top-left of a wide column with nothing beside it, which
  // reads as an unfinished panel — and the cells are the control, so making them
  // fill the width makes them easier to hit as well as better to look at.
  const [column, setColumn] = useState(0);
  const cell = Math.max(
    28,
    Math.min(72, Math.floor((column - (pieces.length + 1) * 2) / (pieces.length + 1))),
  );
  const has = (attacker: string, defender: string) =>
    beats.some((edge) => edge[0] === attacker && edge[1] === defender);

  const toggle = (attacker: string, defender: string) => {
    const next: BeatsEdge[] = has(attacker, defender)
      ? beats.filter((edge) => !(edge[0] === attacker && edge[1] === defender))
      : [...beats, [attacker, defender]];
    onPatch({ beats: next }, 'changed who takes whom');
  };

  /** A kind nothing can take. The validator warns about it; this shows it. */
  const safe = (id: string) => !beats.some((edge) => edge[1] === id);

  const icon = Math.max(16, Math.round(cell * 0.62));

  return (
    <View onLayout={(event) => setColumn(event.nativeEvent.layout.width)} style={styles.beats}>
      <Text style={styles.hint}>
        A row takes a column. Tap a square to change it.
      </Text>

      <View style={styles.beatsRow}>
        <View style={{ height: cell, width: cell }} />
        {pieces.map((piece) => (
          <View key={piece.id} style={[styles.beatsHead, { height: cell, width: cell }]}>
            <PieceIcon color="Blue" look={looks?.[piece.id]} piece={piece.id as Piece} size={icon} />
            {safe(piece.id) ? <View style={styles.warnDot} /> : null}
          </View>
        ))}
      </View>

      {pieces.map((attacker) => (
        <View key={attacker.id} style={styles.beatsRow}>
          <View style={[styles.beatsHead, { height: cell, width: cell }]}>
            <PieceIcon
              color="Red"
              look={looks?.[attacker.id]}
              piece={attacker.id as Piece}
              size={icon}
            />
          </View>
          {pieces.map((defender) => {
            const on = has(attacker.id, defender.id);
            const self = attacker.id === defender.id;
            return (
              <Pressable
                accessibilityLabel={`${attacker.name} takes ${defender.name}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                disabled={self}
                key={defender.id}
                onPress={() => toggle(attacker.id, defender.id)}
                style={[
                  styles.beatsCell,
                  { height: cell, width: cell },
                  on && styles.beatsCellOn,
                  self && styles.beatsCellSelf,
                ]}
              >
                <Text
                  style={[
                    styles.beatsMark,
                    { fontSize: Math.round(cell * 0.45) },
                    on && styles.beatsMarkOn,
                  ]}
                >
                  {self ? '·' : on ? '▸' : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}

      {pieces.some((piece) => safe(piece.id)) ? (
        <Text style={styles.warn}>
          A dotted kind is one nothing can take. Nothing is wrong with that, but a mode where every
          kind is safe can never be won by wiping the other side out.
        </Text>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------- moves -- */

function MovesTab({
  spec,
  looks,
  simulation,
  spotlight,
  onPatch,
  onSpotlight,
}: {
  spec: RuleSpec;
  looks: Looks;
  simulation: SimulateReport | null;
  spotlight: LabSpotlight | null;
  onPatch: InspectorProps['onPatch'];
  onSpotlight: InspectorProps['onSpotlight'];
}) {
  const movement = spec.movement ?? [];

  const edit = (index: number, rule: MovementRule, what: string) =>
    onPatch({ movement: movement.map((old, at) => (at === index ? rule : old)) }, what);

  const add = () =>
    onPatch(
      { movement: [...movement, { kind: 'step', dirs: 'all8', distance: 1 }] },
      'added a movement rule',
    );

  return (
    <View style={styles.rows}>
      {movement.map((rule, index) => {
        const name = `movement[${index}]`;
        // The report names a rule with its kind and pieces attached, so match on
        // the prefix rather than on the whole label.
        const unused =
          simulation?.movementRulesNeverUsed.some((entry) => entry.startsWith(name)) ?? false;
        const lit = spotlight?.path === name;
        const reach = reachOf(spec, index);
        const distance = distanceOf(rule);

        return (
          <View key={name} style={[styles.ruleCard, lit && styles.rowLit]}>
            <View style={styles.ruleHead}>
              {/* The reach board is the point of the row: a rule is a shape, and
                  a shape is not something to read. It is also what you press to
                  make the board say the same thing. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Point at ${name}`}
                onPress={() => onSpotlight(lit ? null : { path: name, note: `This is ${name}` })}
              >
                <ReachBoard looks={looks} reach={reach} />
              </Pressable>
              <View style={styles.rowBody}>
                <Text style={styles.name}>
                  {rule.kind}
                  {distance !== null ? ` · ${distance || 'any'}` : ''}
                  {' · '}
                  {dirsKey(rule.dirs)}
                </Text>
                <Text style={[styles.meta, unused && styles.metaWarn]}>
                  {reach
                    ? `${reach.to.length} square${reach.to.length === 1 ? '' : 's'} from the middle`
                    : 'no preview'}
                  {unused ? ' · never used in the playtest' : ''}
                </Text>
              </View>
              <Pressable
                accessibilityLabel={`Remove ${name}`}
                accessibilityRole="button"
                onPress={() =>
                  onPatch(
                    { movement: movement.filter((_unused, at) => at !== index) },
                    'removed a movement rule',
                  )
                }
                style={styles.remove}
              >
                <Text style={styles.removeText}>×</Text>
              </Pressable>
            </View>

            <OptionChips
              label="HOW"
              onChange={(value) =>
                edit(index, { ...rule, kind: value } as MovementRule, 'changed a movement rule')
              }
              options={MOVE_KINDS.map((value) => ({ value, label: value }))}
              value={rule.kind}
            />
            <OptionChips
              disabled={dirsKey(rule.dirs) === 'custom'}
              label={dirsKey(rule.dirs) === 'custom' ? 'WHERE (WRITTEN AS OFFSETS)' : 'WHERE'}
              onChange={(value) =>
                edit(index, { ...rule, dirs: value } as MovementRule, 'changed a movement rule')
              }
              options={DIRECTION_NAMES.map((value) => ({ value, label: value }))}
              value={dirsKey(rule.dirs) as (typeof DIRECTION_NAMES)[number]}
            />
            {distance !== null ? (
              <OptionChips
                label={rule.kind === 'slide' ? 'AT MOST' : 'HOW FAR'}
                onChange={(value) =>
                  edit(index, withDistance(rule, value), 'changed a movement rule')
                }
                options={[0, 1, 2, 3, 4, 5].map((value) => ({
                  value,
                  label: value === 0 ? 'any' : String(value),
                }))}
                value={distance}
              />
            ) : null}
            <OptionChips
              label="ONTO"
              onChange={(value) =>
                edit(index, { ...rule, targets: value }, 'changed a movement rule')
              }
              options={[
                { value: 'empty' as const, label: 'empty' },
                { value: 'enemy' as const, label: 'enemy' },
                { value: 'any' as const, label: 'any' },
              ]}
              value={rule.targets ?? 'any'}
            />
            {rule.when ? (
              <Text style={styles.hint}>
                This rule has a condition on it. Conditions are edited in JSON, or by asking the
                agent.
              </Text>
            ) : null}
          </View>
        );
      })}

      <Pressable accessibilityRole="button" onPress={add} style={styles.addRow}>
        <Text style={styles.addText}>+ ADD A WAY TO MOVE</Text>
      </Pressable>
    </View>
  );
}

/** How wide the reach thumbnail is drawn. */
const REACH_SIZE = 76;

/** One rule's reach, drawn small. Plain views: no SVG over anything tappable. */
function ReachBoard({ reach, looks }: { reach: ReturnType<typeof reachOf>; looks: Looks }) {
  if (!reach) return <View style={styles.reachEmpty} />;
  const cell = Math.floor(REACH_SIZE / reach.width);
  return (
    <View style={styles.reach}>
      {Array.from({ length: reach.height }, (_unused, y) => (
        <View key={y} style={styles.reachRow}>
          {Array.from({ length: reach.width }, (_unusedCell, x) => {
            const here = reach.from.x === x && reach.from.y === y;
            const reached = reach.to.some((to) => to.x === x && to.y === y);
            return (
              <View
                key={x}
                style={[
                  styles.reachCell,
                  { width: cell, height: cell },
                  reached && styles.reachCellOn,
                  here && styles.reachCellFrom,
                ]}
              >
                {here ? (
                  <PieceIcon
                    color="Red"
                    look={looks?.[reach.kindId]}
                    piece={reach.kindId as Piece}
                    size={cell - 2}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/* ----------------------------------------------------------------- winning -- */

function WinningTab({
  spec,
  simulation,
  spotlight,
  onPatch,
  onSpotlight,
}: {
  spec: RuleSpec;
  simulation: SimulateReport | null;
  spotlight: LabSpotlight | null;
  onPatch: InspectorProps['onPatch'];
  onSpotlight: InspectorProps['onSpotlight'];
}) {
  const win = spec.win ?? [];

  const edit = (index: number, change: Partial<WinCondition>, what: string) =>
    onPatch({ win: win.map((old, at) => (at === index ? { ...old, ...change } : old)) }, what);

  return (
    <View style={styles.rows}>
      <Text style={styles.hint}>
        Checked in order after every move; the first that holds ends the game. Order is the
        tie-break, so it matters.
      </Text>

      {win.map((condition, index) => {
        const name = condition.id ?? `win[${index}]`;
        const never = simulation?.winConditionsNeverFired.includes(name) ?? false;
        const lit = spotlight?.path === name;
        return (
          <View key={name} style={[styles.ruleCard, lit && styles.rowLit]}>
            <View style={styles.ruleHead}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Point at ${name}`}
                onPress={() => onSpotlight(lit ? null : { path: name, note: `This is ${name}` })}
              >
                <Text style={styles.ordinal}>{index + 1}</Text>
              </Pressable>
              <View style={styles.rowBody}>
                <TextInput
                  accessibilityLabel="What this win condition is called"
                  onChangeText={(value) => edit(index, { id: value }, 'renamed a win condition')}
                  placeholder={`win[${index}]`}
                  placeholderTextColor={colors.textFaint}
                  style={styles.name}
                  value={condition.id ?? ''}
                />
                {/* The whole reason this tab is worth having. A condition nothing
                    can satisfy is the commonest way a mode is broken, and it is
                    invisible from reading the rule. */}
                <Text style={[styles.meta, never && styles.metaWarn]}>
                  {typeof condition.result === 'string'
                    ? `${condition.result} wins`
                    : 'whoever has more'}
                  {simulation
                    ? never
                      ? ' · never fired in the playtest'
                      : ' · fired in the playtest'
                    : ''}
                </Text>
              </View>
              <Pressable
                accessibilityLabel={`Remove ${name}`}
                accessibilityRole="button"
                onPress={() =>
                  onPatch(
                    { win: win.filter((_unused, at) => at !== index) },
                    'removed a win condition',
                  )
                }
                style={styles.remove}
              >
                <Text style={styles.removeText}>×</Text>
              </Pressable>
            </View>

            {typeof condition.result === 'string' ? (
              <OptionChips
                label="WHO WINS"
                onChange={(value) => edit(index, { result: value }, 'changed a win condition')}
                options={[
                  { value: 'mover' as const, label: 'the mover' },
                  { value: 'opponent' as const, label: 'the other side' },
                  { value: 'draw' as const, label: 'a draw' },
                ]}
                value={condition.result}
              />
            ) : (
              <Text style={styles.hint}>
                This one compares two counts. Edit it in JSON, or ask the agent.
              </Text>
            )}
          </View>
        );
      })}

      {win.length === 0 ? (
        <Text style={styles.warn}>
          Nothing ends this game. It will run to the move limit every time.
        </Text>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ styles -- */

const styles = StyleSheet.create({
  inspector: { flex: 1, minHeight: 0, minWidth: 0 },

  tabs: {
    borderBottomColor: colors.borderSoft,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: space.tight,
    paddingHorizontal: space.small,
    paddingVertical: space.tight,
  },
  tab: { borderRadius: radius.small, paddingHorizontal: space.snug, paddingVertical: space.tight },
  tabOn: { backgroundColor: colors.accentSurface },
  tabText: { ...type.eyebrow, color: colors.textFaint },
  tabTextOn: { color: colors.accentText },

  body: { flex: 1, minHeight: 0 },
  bodyContent: { padding: space.small, paddingBottom: space.large },

  rows: { gap: space.snug },
  row: {
    alignItems: 'center',
    borderColor: colors.borderSoft,
    borderRadius: radius.small,
    borderWidth: 1,
    flexDirection: 'row',
    gap: space.snug,
    padding: space.snug,
  },
  rowLit: { borderColor: colors.accent, backgroundColor: colors.accentSurface },
  // `minWidth: 0` is what lets a long name wrap instead of pushing the symbol
  // and the remove button off the end of the row.
  rowBody: { flex: 1, gap: 2, minWidth: 0 },
  name: {
    ...type.rowTitle,
    color: colors.text,
    padding: 0,
    ...Platform.select({ web: { outlineStyle: 'none' as never } }),
  },
  meta: { ...type.meta, color: colors.textFaint },
  metaWarn: { color: colors.dangerSoft },
  symbol: {
    ...type.rowTitle,
    backgroundColor: colors.surfaceWell,
    borderRadius: radius.small,
    color: colors.textSoft,
    fontFamily: 'monospace',
    paddingHorizontal: space.snug,
    paddingVertical: space.tight,
    textAlign: 'center',
    width: 34,
  },
  remove: { paddingHorizontal: space.snug },
  removeText: { color: colors.textMuted, fontSize: 18, lineHeight: 20 },
  removeOff: { opacity: 0.3 },

  addRow: {
    alignItems: 'center',
    borderColor: colors.borderLight,
    borderRadius: radius.small,
    borderStyle: 'dashed',
    borderWidth: 1,
    padding: space.snug,
  },
  addText: { ...type.eyebrow, color: colors.textMuted },

  hint: { ...type.meta, color: colors.textFaint },
  warn: { ...type.meta, color: colors.textMuted, marginTop: space.snug },

  beats: { gap: space.tight },
  beatsRow: { flexDirection: 'row', gap: 2 },
  beatsHead: { alignItems: 'center', justifyContent: 'center' },
  beatsCell: {
    alignItems: 'center',
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.small,
    justifyContent: 'center',
  },
  beatsCellOn: { backgroundColor: colors.accentSurfaceStrong },
  beatsCellSelf: { backgroundColor: 'transparent' },
  beatsMark: { color: colors.textFaint },
  beatsMarkOn: { color: colors.accentText },
  warnDot: {
    backgroundColor: colors.dangerSoft,
    borderRadius: 3,
    height: 5,
    position: 'absolute',
    right: 2,
    top: 2,
    width: 5,
  },

  ruleCard: {
    borderColor: colors.borderSoft,
    borderRadius: radius.small,
    borderWidth: 1,
    gap: space.snug,
    padding: space.snug,
  },
  ruleHead: { alignItems: 'center', flexDirection: 'row', gap: space.snug },
  ordinal: { ...type.eyebrow, color: colors.textFaint, width: REACH_SIZE, textAlign: 'center' },

  reach: { backgroundColor: colors.borderSoft, borderRadius: 3, gap: 1, padding: 1 },
  reachEmpty: { height: REACH_SIZE, width: REACH_SIZE },
  reachRow: { flexDirection: 'row', gap: 1 },
  reachCell: { alignItems: 'center', backgroundColor: colors.surfaceWell, justifyContent: 'center' },
  reachCellOn: { backgroundColor: colors.accentSurfaceStrong },
  reachCellFrom: { backgroundColor: colors.surfaceSunken },
});
