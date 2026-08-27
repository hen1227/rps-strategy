// What the page can do, said in a way an agent can call.
//
// WebMCP's bargain is that a page stops making an agent guess at its UI and
// hands it real operations instead. So these are not wrappers around buttons —
// they are the operations, and the buttons call the same controller.
//
// Three things shape the list:
//
//  1. **`lab_patch_spec` is the important one.** It takes a partial spec and
//     merges it, so the agent can reach any field of the language. A tool per
//     knob would be a menu, and a menu is exactly the thing that would confine
//     an agent to the situations somebody thought of first.
//  2. **The surface is dynamic.** There is no `lab_play_move` until there is a
//     game to play a move in. A tool that is present but cannot work is worse
//     than one that is absent: the agent spends a call finding out.
//  3. **Every result carries a board.** A tool that changed the position says
//     what the position now is, in text, so the agent can reason about it
//     without spending another call asking.
//
// Defined as pure functions over `LabController` so the whole surface can be
// exercised in a `.mts` test with no browser and no agent — the same reason the
// selector modules in `store/` are pure.

import type { AnalysisGame } from '@/engine/analysisGame';
import {
  describePosition,
  isStandardPosition,
  positionFits,
  refitRows,
  standardRows,
} from '@/engine/spec/position';
import type { SimulateReport } from '@/engine/spec/simulate';
import type { RuleSpec } from '@/engine/spec/types';
import type { SpecReport } from '@/engine/spec/validate';
import type { LabArtAsset, LibraryPart } from '@/store/api/lab';
import type { LabAnswer, LabToolCall } from '@/store/labSession';
import { describeSpecChange, type SpecChange } from './agent/specDiff';
import type { ToolDescriptor } from '@/webmcp/modelContext';
import type { Position } from '@/types/game';

/**
 * Everything the tools need, and nothing about React.
 *
 * The Lab screen provides one backed by the store; a test provides one backed by
 * a plain object. Both get the same tools, which is what makes the test worth
 * anything.
 */
export interface LabController {
  getDraft: () => RuleSpec;
  setDraft: (spec: RuleSpec) => SpecReport;
  validate: (spec: RuleSpec) => SpecReport;
  getGame: () => AnalysisGame | null;
  newGame: (options?: { rows?: string[] }) => AnalysisGame | null;
  endGame: () => void;
  legalMoves: (from?: Position) => { from: Position; to: Position }[];
  play: (from: Position, to: Position) => boolean;
  undo: () => boolean;
  simulate: (options?: { games?: number; strength?: number; seed?: number }) => SimulateReport;
  getSimulation: () => SimulateReport | null;
  /** The rule-language reference, from the server that will validate the spec. */
  language: () => Promise<string>;
  searchParts: (options: { kind?: string; search?: string }) => Promise<LibraryPart[]>;
  getPart: (partId: string) => Promise<LibraryPart | null>;
  publishMode: (input: { slug: string; visibility?: 'public' | 'unlisted' }) => Promise<{
    modeId: string;
    url: string;
  }>;
  publishPart: (input: {
    partId: string;
    kind: LibraryPart['kind'];
    name: string;
    summary: string;
    body: unknown;
  }) => Promise<{ partId: string; version: number }>;
  /**
   * Whether this browser may store a picture.
   *
   * Publishing a mode is open to a guest and this is not, so the tool has to be
   * able to say so *before* trying: a refusal that names the reason is worth a
   * call, and a 403 the agent has to interpret is not.
   */
  canAddImage: () => boolean;
  addImage: (input: {
    role: 'piece' | 'board' | 'cover';
    data?: string;
    url?: string;
  }) => Promise<LabArtAsset>;
  listImages: () => Promise<LabArtAsset[]>;
  saveDraft: (name: string) => Promise<{ draftId: string }>;
  listDrafts: () => Promise<{ draftId: string; name: string }[]>;
  loadDraft: (draftId: string) => Promise<RuleSpec | null>;
  /**
   * Stop and ask a person. Used by anything other people can see.
   *
   * Takes the caller's signal so a stopped agent run does not leave the question
   * hanging: an abandoned question answers itself, and it answers "no".
   */
  confirm: (message: string, signal?: AbortSignal) => Promise<boolean>;
  /**
   * Ask a person something that is not a yes or a no.
   *
   * The same stop-and-wait as `confirm` — the tool call is still in flight while
   * the page holds the question up — but the abandoned answer is `null` rather
   * than a choice, because "they never said" is a different fact from any of the
   * options and an agent should be able to tell them apart.
   */
  ask: (
    prompt: { question: string; options: { id: string; label: string }[]; allowText: boolean },
    signal?: AbortSignal,
  ) => Promise<LabAnswer | null>;
  /** Offer a change and wait. Applied only if they say so. */
  propose: (
    proposal: { patch: Partial<RuleSpec>; spec: RuleSpec; changes: SpecChange[]; note: string },
    signal?: AbortSignal,
  ) => Promise<{ applied: boolean; text?: string }>;
  /** Point at something. Changes nothing about the mode. */
  highlight: (
    spotlight: { squares: Position[]; piece: string | null; path: string | null; note: string } | null,
  ) => void;
  /** Everything anybody has done here, newest last. */
  activity: () => LabToolCall[];
}

/* ------------------------------------------------------------ board as text -- */

const FILES = 'abcdefghijklmnopqrstuvwxyz';

const squareName = ({ x, y }: Position) => `${FILES[x] ?? '?'}${y + 1}`;

const parseSquare = (text: unknown): Position | null => {
  const name = String(text ?? '').trim().toLowerCase();
  const file = FILES.indexOf(name[0] ?? '');
  const rank = Number(name.slice(1));
  if (file < 0 || !Number.isInteger(rank) || rank < 1) return null;
  return { x: file, y: rank - 1 };
};

/**
 * The position as something a model can read.
 *
 * Upper case is Blue and lower case is Red, the same convention a layout uses,
 * with rank numbers down the side and files along the bottom. A model that can
 * see the board in the tool result does not have to spend a call asking for it.
 */
const drawBoard = (game: AnalysisGame, spec: RuleSpec): string => {
  const symbols = new Map(spec.pieces.map((piece) => [piece.id, piece.symbol.toUpperCase()]));
  const rows = game.grid.map((row, y) => {
    const line = row
      .map((tile) => {
        const symbol = symbols.get(tile.occupant);
        if (!symbol || tile.occupantOwner === 'Neutral') return '.';
        return tile.occupantOwner === 'Red' ? symbol.toLowerCase() : symbol;
      })
      .join('');
    return `${String(y + 1).padStart(2, ' ')} ${line}`;
  });
  const files = `   ${FILES.slice(0, game.grid[0]?.length ?? 0)}`;
  return [...rows, files].join('\n');
};

const describeGame = (game: AnalysisGame, spec: RuleSpec) => {
  const ending =
    game.status === 'InProgress'
      ? `${game.currentTurn} to move`
      : `finished: ${game.winner === 'Neutral' ? 'a draw' : `${game.winner} wins`} by ${game.endReason ?? 'a rule'}`;
  return `${ending}, after ${game.moveNumber} move${game.moveNumber === 1 ? '' : 's'}\n${drawBoard(game, spec)}`;
};

/* ------------------------------------------------------- the opening board -- */

/**
 * The openings a mode can ask for by name.
 *
 * Two, and neither is a style: `standard` is the default this project's own
 * modes use, generalised to whatever board and kinds the mode has now, and
 * `empty` is the blank sheet you want before placing eleven pieces by hand. A
 * longer list would be a menu of somebody's taste, which is the thing
 * `lab_set_starting_position` already lets an author skip.
 */
export const OPENING_PRESETS = ['standard', 'empty'] as const;
export type OpeningPreset = (typeof OPENING_PRESETS)[number];

const presetRows = (preset: OpeningPreset, spec: RuleSpec): string[] =>
  preset === 'empty'
    ? Array.from({ length: spec.board.height }, () => '.'.repeat(spec.board.width))
    : standardRows(spec);

/**
 * The opening board, after a patch moved the board or the pieces under it.
 *
 * A layout is the one field of the language whose correctness depends on two
 * others, so a patch that widens the board leaves an opening that is the wrong
 * shape and a mode that will not start — and the error names the layout, which
 * is true and is not what went wrong. Following the change is what a person
 * would do by hand, so the tool does it, and says so.
 *
 * Which way it follows depends on what was there. A mode still on the default
 * opening stays on the default one — *for the new shape*, so widening the board
 * widens the ranks rather than leaving three pieces adrift on eleven files. A
 * mode with an opening somebody wrote keeps it, carried across, because that
 * layout is a decision and the shape change was not about it.
 *
 * Only when the caller did not send a layout themselves: `startingPosition` in
 * the patch is an instruction, not an accident, even when it does not fit.
 */
const keepOpeningWith = (
  before: RuleSpec,
  spec: RuleSpec,
  patch: Partial<RuleSpec>,
): { spec: RuleSpec; note: string } => {
  const touched = 'board' in patch || 'pieces' in patch;
  if (!touched || 'startingPosition' in patch) return { spec, note: '' };

  const wasDefault = isStandardPosition(before);
  if (!wasDefault && positionFits(spec)) return { spec, note: '' };

  const rows = wasDefault ? standardRows(spec) : refitRows(spec.startingPosition?.rows, spec);
  const unchanged =
    rows.length === (spec.startingPosition?.rows?.length ?? -1) &&
    rows.every((row, y) => row === spec.startingPosition?.rows?.[y]);
  if (unchanged) return { spec, note: '' };

  return {
    spec: { ...spec, startingPosition: { rows } },
    note:
      (wasDefault
        ? 'The opening board is the standard one for the new shape:'
        : 'The opening board no longer fitted, so it was carried across:') + `\n${rows.join('\n')}\n`,
  };
};

/** The shape every tool returns: a line to read, and the same thing as data. */
const result = (summary: string, data: Record<string, unknown> = {}) => ({ summary, ...data });

const issuesOf = (report: SpecReport) => ({
  valid: report.errors.length === 0,
  errors: report.errors,
  warnings: report.warnings,
});

const reportLine = (report: SpecReport) => {
  if (report.errors.length) {
    return `${report.errors.length} error${report.errors.length === 1 ? '' : 's'}: ${report.errors
      .map((issue) => `${issue.path || '(spec)'} — ${issue.message}`)
      .join('; ')}`;
  }
  if (report.warnings.length) {
    return `Valid, with ${report.warnings.length} warning${report.warnings.length === 1 ? '' : 's'}: ${report.warnings
      .map((issue) => `${issue.path} — ${issue.message}`)
      .join('; ')}`;
  }
  return 'Valid, with nothing to warn about.';
};

/* -------------------------------------------------------------- the schemas -- */

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const string = (description: string) => ({ type: 'string', description });
const integer = (description: string) => ({ type: 'integer', description });
const square = (description: string) => ({
  type: 'string',
  description: `${description} A square, like "d7": a file letter then a rank number.`,
});

/* ---------------------------------------------------------------- the tools -- */

export const labTools = (controller: LabController): ToolDescriptor[] => {
  const readOnly = { readOnlyHint: true };
  const tools: ToolDescriptor[] = [
    {
      name: 'lab_get_state',
      description:
        'The whole state of the workbench: the mode being designed, whether its rules are ' +
        'playable, the test game if one is running, and the last playtest. Start here.',
      annotations: readOnly,
      inputSchema: object({}),
      execute: async () => {
        const draft = controller.getDraft();
        const report = controller.validate(draft);
        const game = controller.getGame();
        const simulation = controller.getSimulation();
        return result(
          `"${draft.name}" — ${draft.board.width} by ${draft.board.height}, ` +
            `${draft.pieces.length} piece kind${draft.pieces.length === 1 ? '' : 's'}, ` +
            `${describePosition(draft)}. ` +
            `${reportLine(report)}` +
            `\n\nOpening board:\n${(draft.startingPosition?.rows ?? []).join('\n')}` +
            (game ? `\n\nTest game: ${describeGame(game, draft)}` : '\n\nNo test game running.'),
          {
            spec: draft,
            opening: {
              rows: draft.startingPosition?.rows ?? [],
              standard: isStandardPosition(draft),
            },
            validation: issuesOf(report),
            game: game
              ? { turn: game.currentTurn, status: game.status, moveNumber: game.moveNumber }
              : null,
            lastPlaytest: simulation,
          },
        );
      },
    },
    {
      name: 'lab_describe_language',
      description:
        'The reference for the rule format, from the server that will validate what you write. ' +
        'Read this before your first edit: it is the complete list of what a mode can say.',
      annotations: readOnly,
      inputSchema: object({}),
      execute: async () => {
        const reference = await controller.language();
        return result('The rule language reference follows.', { reference });
      },
    },
    {
      name: 'lab_validate',
      description:
        'Check the mode being designed without changing it. Errors mean it cannot be played; ' +
        'warnings mean it can, and probably is not what you meant.',
      annotations: readOnly,
      inputSchema: object({}),
      execute: async () => {
        const report = controller.validate(controller.getDraft());
        return result(reportLine(report), issuesOf(report));
      },
    },
    {
      name: 'lab_patch_spec',
      description:
        'Change the mode by merging fields into it. Every top-level field of the rule format is ' +
        'reachable here — board, pieces, beats, movement, capture, effects, win, draw, turn, and ' +
        'the name and description. A field you pass replaces the whole of that field, so send a ' +
        'complete list when you change one. This is the main way to build a mode. ' +
        'Resizing the board or changing the pieces carries the opening board across for you — ' +
        'centred on the new width, each side still against its own home rank — so you do not have ' +
        'to redraw it; send startingPosition in the same patch to place it yourself instead.',
      inputSchema: object(
        {
          patch: {
            type: 'object',
            description:
              'Fields to merge into the mode. See lab_describe_language for what each one means.',
          },
        },
        ['patch'],
      ),
      execute: async (input) => {
        const patch = (input.patch ?? {}) as Partial<RuleSpec>;
        const before = controller.getDraft();
        const merged = { ...before, ...patch } as RuleSpec;
        const opening = keepOpeningWith(before, merged, patch);
        const report = controller.setDraft(opening.spec);
        return result(
          `Changed ${Object.keys(patch).join(', ') || 'nothing'}.` +
            (opening.note ? ` ${opening.note}` : '') +
            ` ${reportLine(report)}`,
          { spec: opening.spec, validation: issuesOf(report) },
        );
      },
    },
    {
      name: 'lab_set_spec',
      description:
        'Replace the whole mode with a complete rule document. Use lab_patch_spec for a change; ' +
        'use this to start again, or to load something you built elsewhere.',
      inputSchema: object({ spec: { type: 'object', description: 'A whole rule document.' } }, [
        'spec',
      ]),
      execute: async (input) => {
        const spec = input.spec as RuleSpec;
        const report = controller.setDraft(spec);
        return result(`Replaced the mode. ${reportLine(report)}`, {
          spec,
          validation: issuesOf(report),
        });
      },
    },
    {
      name: 'lab_set_starting_position',
      description:
        'Set the opening board. Pass preset "standard" for the default opening — every kind ' +
        'massed in front of its own home rank, mirrored, which is how the built-in modes start — ' +
        'and it is built for whatever board and pieces the mode has now. Otherwise pass rows: one ' +
        'string per rank, from rank 1 upward, a piece symbol for a piece — upper case for Blue, ' +
        'lower case for Red — and "." for an empty square. Every row must be the same length, and ' +
        'the rectangle must match the board size.',
      inputSchema: object({
        preset: {
          type: 'string',
          enum: [...OPENING_PRESETS],
          description:
            'A named opening to use instead of rows. "standard" is the default one for this ' +
            'mode\'s board and pieces; "empty" clears the board to place pieces yourself.',
        },
        rows: {
          type: 'array',
          items: { type: 'string' },
          description: 'One string per rank, rank 1 first. Ignored when preset is given.',
        },
        mirror: {
          type: 'boolean',
          description:
            'Mirror the rows you gave onto the other half, so both sides start the same. ' +
            'Give only the ranks nearest rank 1.',
        },
      }),
      execute: async (input) => {
        const draft = controller.getDraft();
        const preset = input.preset as OpeningPreset | undefined;
        const rows = (input.rows as string[]) ?? [];
        if (!preset && rows.length === 0) {
          throw new Error('Give either a preset or the rows of the opening board.');
        }
        const built = preset
          ? presetRows(preset, draft)
          : input.mirror
            ? mirrorRows(rows, draft.board.height)
            : rows;
        const report = controller.setDraft({ ...draft, startingPosition: { rows: built } });
        return result(
          `Opening board set${preset ? ` to the ${preset} opening` : ''}.\n` +
            `${built.join('\n')}\n${reportLine(report)}`,
          { rows: built, validation: issuesOf(report) },
        );
      },
    },
    {
      name: 'lab_new_test_game',
      description:
        'Start a game of the mode being designed, so you can play it and see whether it works. ' +
        'Fails while the rules have errors, because a mode that will not validate has no moves.',
      inputSchema: object({
        rows: {
          type: 'array',
          items: { type: 'string' },
          description: 'Start from this board instead of the mode’s own opening.',
        },
      }),
      execute: async (input) => {
        const game = controller.newGame(
          input.rows ? { rows: input.rows as string[] } : undefined,
        );
        if (!game) {
          const report = controller.validate(controller.getDraft());
          return result(`Cannot start a game: ${reportLine(report)}`, {
            started: false,
            validation: issuesOf(report),
          });
        }
        return result(`Started. ${describeGame(game, controller.getDraft())}`, {
          started: true,
          turn: game.currentTurn,
        });
      },
    },
    {
      name: 'lab_simulate',
      description:
        'Play the mode against itself and report what happened: who wins, how games end, how ' +
        'long they run, and — most usefully — which of your rules never fired in any game. ' +
        'A rule nothing ever triggers is the commonest way a mode is wrong.',
      inputSchema: object({
        games: integer('How many games. 40 by default; more is steadier and slower.'),
        strength: {
          type: 'number',
          description:
            'How well both sides play, 0 to 1. Near 0 asks "can this game be finished at all"; ' +
            'near 1 asks "does it hold up when both sides try". They often disagree.',
        },
        seed: integer('Change this to play a different set of games.'),
      }),
      execute: async (input) => {
        const report = controller.simulate({
          games: input.games as number | undefined,
          strength: input.strength as number | undefined,
          seed: input.seed as number | undefined,
        });
        const lines = [
          `${report.games} games: Red ${report.redWins}, Blue ${report.blueWins}, ` +
            `drawn ${report.draws}, unfinished ${report.unfinished}.`,
          `Average ${report.averagePlies} moves. Endings: ` +
            (report.endings.map((entry) => `${entry.reason} ${entry.games}`).join(', ') || 'none'),
          ...report.notes.map((note) => `• ${note}`),
        ];
        return result(lines.join('\n'), report as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'lab_add_image',
      description:
        'Store a picture so the mode can use it, and get back the id to refer to it by. ' +
        'A picture goes in one of three places: a piece kind’s "art", the board’s "art", or the ' +
        'mode’s "cover" — set any of them with lab_patch_spec once you have the id. ' +
        'Send "url" when you can and the server fetches it; "data" is base64 and is only ' +
        'practical for a small picture, because it is an argument you have to write out in full. ' +
        'Square PNGs for pieces; PNG or JPEG for a board or a cover. Needs a signed-in account.',
      inputSchema: object(
        {
          role: string('Where it will go: "piece", "board" or "cover".'),
          url: string('An https URL for the server to fetch it from. Prefer this.'),
          data: string(
            'The picture itself, base64, no "data:" prefix. Only for a small one — ' +
              'anything bigger than about 48 KB should come by url.',
          ),
        },
        ['role'],
      ),
      execute: async (input) => {
        const role = String(input.role ?? '');
        if (role !== 'piece' && role !== 'board' && role !== 'cover') {
          return result('Not stored: a picture goes in a "piece", the "board" or the "cover".');
        }
        const data = typeof input.data === 'string' ? input.data.trim() : '';
        const url = typeof input.url === 'string' ? input.url.trim() : '';
        if ((data === '') === (url === '')) {
          return result('Not stored: give either "url" or "data", not both and not neither.');
        }
        // Refused before anything is attempted, and with what to do instead.
        // Publishing a mode works for a guest, so an agent has no reason to
        // expect this not to, and "sign in" is only useful said in full.
        if (!controller.canAddImage()) {
          return result(
            'Not stored: pictures are kept on an account, and nobody is signed in on this ' +
              'browser. The person at the keyboard can sign in and you can try again — or the ' +
              'mode can use the bundled artwork ("rock", "paper", "scissors") and letters for ' +
              'the rest, which needs no account and always works.',
            { stored: false, needsAccount: true },
          );
        }
        const asset = await controller.addImage({
          role,
          ...(data ? { data } : {}),
          ...(url ? { url } : {}),
        });
        return result(
          `Stored a ${asset.width}×${asset.height} ${asset.mediaType.replace('image/', '')} ` +
            `as ${asset.artId}. ` +
            (role === 'piece'
              ? 'Put it on a kind with lab_patch_spec: pieces[i].art.'
              : role === 'board'
                ? 'Put it under the board with lab_patch_spec: board.art.'
                : 'Make it the library card with lab_patch_spec: cover.'),
          { stored: true, art: asset },
        );
      },
    },
    {
      name: 'lab_list_images',
      description:
        'The pictures already stored on this account, newest first. Look here before adding one: ' +
        'the same picture stored twice gets the same id, so re-sending it is wasted work.',
      annotations: readOnly,
      inputSchema: object({}),
      execute: async () => {
        if (!controller.canAddImage()) {
          return result('Nobody is signed in, so there are no stored pictures.', { art: [] });
        }
        const art = await controller.listImages();
        if (art.length === 0) {
          return result('No pictures on this account yet.', { art: [] });
        }
        const draft = controller.getDraft();
        // Say where each one is already used, so choosing one does not cost a
        // second call to work out what is free.
        const usedAs = (artId: string): string => {
          const kinds = (draft.pieces ?? [])
            .filter((piece) => piece.art === artId)
            .map((piece) => piece.name || piece.id);
          if (draft.board?.art === artId) kinds.push('the board');
          if (draft.cover === artId) kinds.push('the cover');
          return kinds.length ? ` — used as ${kinds.join(', ')}` : '';
        };
        return result(
          art
            .map(
              (asset) =>
                `${asset.artId} (${asset.role}, ${asset.width}×${asset.height})${usedAs(asset.artId)}`,
            )
            .join('\n'),
          { art },
        );
      },
    },
    {
      name: 'lab_search_parts',
      description:
        'Search the library of reusable rule fragments other people have published — a jump, a ' +
        'territory rule, a win condition. Prefer reusing one to writing your own: it is already ' +
        'tested, and the library credits its author.',
      annotations: readOnly,
      inputSchema: object({
        kind: string('movement, capture, effect, win, draw or turn.'),
        search: string('Words to look for in the name or summary.'),
      }),
      execute: async (input) => {
        const parts = await controller.searchParts({
          kind: input.kind as string | undefined,
          search: input.search as string | undefined,
        });
        if (parts.length === 0) return result('No parts matched.', { parts: [] });
        return result(
          parts
            .map(
              (part) =>
                `${part.partId}@${part.version} (${part.kind}) — ${part.name}: ${part.summary}` +
                (part.usedBy ? ` [used by ${part.usedBy}]` : ''),
            )
            .join('\n'),
          { parts },
        );
      },
    },
    {
      name: 'lab_get_part',
      description:
        'One reusable fragment in full, so you can merge its body into the mode you are ' +
        'building. Address a version as "jump@1", or use "jump" for the newest.',
      annotations: readOnly,
      inputSchema: object({ partId: string('For example "jump" or "jump@1".') }, ['partId']),
      execute: async (input) => {
        const part = await controller.getPart(String(input.partId));
        if (!part) return result(`No part called ${String(input.partId)}.`, { part: null });
        return result(`${part.name} (${part.kind}): ${part.summary}`, { part });
      },
    },
    {
      name: 'lab_save_draft',
      description:
        'Save the mode being designed to this account, so it survives a closed tab. Saving does ' +
        'not publish it: nobody else can see a draft.',
      inputSchema: object({ name: string('What to call this draft.') }, ['name']),
      execute: async (input) => {
        const saved = await controller.saveDraft(String(input.name));
        return result(`Saved as "${String(input.name)}".`, saved);
      },
    },
    {
      name: 'lab_list_drafts',
      description:
        'The modes saved on this account, newest first. Use lab_load_draft with one of the ids ' +
        'to pick up where you left off.',
      annotations: readOnly,
      inputSchema: object({}),
      execute: async () => {
        const drafts = await controller.listDrafts();
        if (drafts.length === 0) return result('No saved drafts.', { drafts: [] });
        return result(
          drafts.map((draft) => `${draft.draftId}: ${draft.name}`).join('\n'),
          { drafts },
        );
      },
    },
    {
      name: 'lab_load_draft',
      description:
        'Replace the mode being designed with one saved earlier. Whatever is on the workbench ' +
        'now is discarded, so save it first if it is worth keeping.',
      inputSchema: object({ draftId: string('From lab_list_drafts.') }, ['draftId']),
      execute: async (input) => {
        const spec = await controller.loadDraft(String(input.draftId));
        if (!spec) return result('No draft by that id.', { loaded: false });
        const report = controller.setDraft(spec);
        return result(`Loaded "${spec.name}". ${reportLine(report)}`, {
          loaded: true,
          spec,
          validation: issuesOf(report),
        });
      },
    },
    {
      name: 'lab_recent_activity',
      description:
        'What has happened at this workbench, newest last: your own calls, the person\u2019s edits, ' +
        'and any other agent driving this page. The person can build here too \u2014 they place ' +
        'pieces, resize the board and change rules with their hands \u2014 so read this before ' +
        'assuming the mode is the one you left. Their entries say what changed, not which button ' +
        'they pressed.',
      annotations: readOnly,
      inputSchema: object({
        origin: string(
          'Only calls from one source: "you" for the person here, "lab-agent" for this page\u2019s ' +
            'chat, "external" for another agent. All of them by default.',
        ),
        limit: integer('How many of the most recent to return. 20 by default.'),
      }),
      execute: async (input) => {
        const origin = typeof input.origin === 'string' ? input.origin : null;
        const limit = typeof input.limit === 'number' ? Math.max(1, Math.floor(input.limit)) : 20;
        const entries = controller
          .activity()
          .filter((entry) => !origin || entry.origin === origin)
          .slice(-limit);
        if (entries.length === 0) {
          return result(
            origin ? `Nothing from ${origin} yet.` : 'Nothing has happened here yet.',
            { activity: [] },
          );
        }
        const who = (entry: LabToolCall) =>
          entry.origin === 'you'
            ? 'the person'
            : entry.origin === 'lab-agent'
              ? 'you'
              : 'another agent';
        return result(
          entries
            .map((entry) => {
              const changed = entry.changes.map((change) => change.label).join(', ');
              return (
                `${who(entry)}: ${entry.tool}${entry.ok ? '' : ' (refused)'}` +
                (changed ? ` \u2014 ${changed}` : '')
              );
            })
            .join('\n'),
          { activity: entries },
        );
      },
    },
    {
      name: 'lab_ask_user',
      description:
        'Ask the person at the keyboard something, and wait for their answer. For a decision that ' +
        'is theirs rather than yours \u2014 which of two games they meant, whether a piece should be ' +
        'strong or weak \u2014 not for permission to do your job. Give two to four options; they may ' +
        'also write something instead if you allow it. They can ignore it, and an ignored question ' +
        'answers "they never said", which is not the same as any of your options.',
      inputSchema: object(
        {
          question: string('One sentence. What you want to know.'),
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Two to four short answers to choose between.',
          },
          allowText: {
            type: 'boolean',
            description: 'Let them write their own answer as well. False by default.',
          },
        },
        ['question', 'options'],
      ),
      execute: async (input, options) => {
        const question = String(input.question ?? '').trim();
        const labels = Array.isArray(input.options)
          ? input.options.map((option) => String(option).trim()).filter(Boolean).slice(0, 4)
          : [];
        if (!question) return result('Not asked: give a question.', { asked: false });
        if (labels.length < 2) {
          return result('Not asked: give at least two options to choose between.', { asked: false });
        }
        const answer = await controller.ask(
          {
            question,
            options: labels.map((label, index) => ({ id: `option-${index}`, label })),
            allowText: input.allowText === true,
          },
          options?.signal,
        );
        if (!answer) {
          return result(
            'They did not answer. Carry on and decide it yourself, or ask again later \u2014 do not ' +
              'ask the same question twice in a row.',
            { answered: false },
          );
        }
        const chosen = answer.id ? labels[Number(answer.id.split('-')[1])] : undefined;
        return result(
          chosen && answer.text
            ? `They chose \u201c${chosen}\u201d and said: ${answer.text}`
            : chosen
              ? `They chose \u201c${chosen}\u201d.`
              : `They said: ${answer.text ?? ''}`,
          { answered: true, chosen: chosen ?? null, text: answer.text ?? null },
        );
      },
    },
    {
      name: 'lab_propose_change',
      description:
        'Offer a change instead of making one, and wait. The page shows the person what it would ' +
        'do to the mode and to the board, and they apply it or turn it down. Use it when the change ' +
        'is a matter of taste, or large enough that being wrong would cost them work \u2014 for an ' +
        'ordinary edit use lab_patch_spec, which is what they are expecting you to do. A refusal is ' +
        'an answer: read what they said and try something else rather than proposing it again.',
      inputSchema: object(
        {
          patch: {
            type: 'object',
            description: 'Exactly what you would send to lab_patch_spec.',
          },
          note: string('One line: what this does and why you are asking rather than doing it.'),
        },
        ['patch', 'note'],
      ),
      execute: async (input, options) => {
        const patch = (input.patch ?? {}) as Partial<RuleSpec>;
        if (Object.keys(patch).length === 0) {
          return result('Not offered: the patch is empty.', { applied: false });
        }
        const before = controller.getDraft();
        const merged = { ...before, ...patch } as RuleSpec;
        const opening = keepOpeningWith(before, merged, patch);
        const report = controller.validate(opening.spec);
        // Checked before it is shown. Offering somebody a change that will not
        // validate wastes their decision, and the error is yours to fix.
        if (report.errors.length) {
          return result(`Not offered \u2014 that change does not validate. ${reportLine(report)}`, {
            applied: false,
            validation: issuesOf(report),
          });
        }
        const changes = describeSpecChange(before, opening.spec);
        const answer = await controller.propose(
          {
            patch,
            spec: opening.spec,
            changes,
            note: String(input.note ?? ''),
          },
          options?.signal,
        );
        if (!answer.applied) {
          return result(
            `They turned it down.${answer.text ? ` They said: ${answer.text}` : ''}`,
            { applied: false, ...(answer.text ? { text: answer.text } : {}) },
          );
        }
        return result(
          `They applied it. ${changes.map((change) => change.label).join(', ') || 'Nothing changed.'}` +
            `${answer.text ? ` They said: ${answer.text}` : ''} ${reportLine(report)}`,
          { applied: true, spec: opening.spec, validation: issuesOf(report) },
        );
      },
    },
    {
      name: 'lab_highlight',
      description:
        'Point at something while you talk about it: squares on the board, a piece kind, or a rule ' +
        'in the mode. The person sees it lit up where they are already looking, which is worth more ' +
        'than describing where to look. Changes nothing. Call it with no arguments to stop pointing; ' +
        'it clears itself when they touch the board or when the rules change.',
      annotations: readOnly,
      inputSchema: object({
        squares: {
          type: 'array',
          items: { type: 'string' },
          description: 'Squares to light up, like ["d4", "e4"].',
        },
        piece: string('A piece kind\u2019s id, to light up every one of them on the board.'),
        path: string('A rule to ring in the rule list, like "win[1]" or "movement[0]".'),
        note: string('One short line saying what they are looking at.'),
      }),
      execute: async (input) => {
        const named = Array.isArray(input.squares) ? input.squares : [];
        const squares = named
          .map((value) => parseSquare(value))
          .filter((position): position is Position => position !== null);
        const piece = typeof input.piece === 'string' && input.piece ? input.piece : null;
        const path = typeof input.path === 'string' && input.path ? input.path : null;
        if (squares.length === 0 && !piece && !path) {
          controller.highlight(null);
          return result('Stopped pointing.', { pointing: false });
        }
        if (named.length > squares.length) {
          return result(
            `Not pointing: ${named.length - squares.length} of those are not squares. ` +
              'A square is a file letter and a rank number, like "d4".',
            { pointing: false },
          );
        }
        const note = String(input.note ?? '');
        controller.highlight({ squares, piece, path, note });
        const what = [
          squares.length ? squares.map(squareName).join(' ') : '',
          piece ? `every ${piece}` : '',
          path ? path : '',
        ]
          .filter(Boolean)
          .join(', ');
        return result(`Pointing at ${what}.`, { pointing: true, squares: squares.map(squareName) });
      },
    },
    {
      name: 'lab_publish_mode',
      description:
        'Publish the mode to the library, where other people can find it and play it against ' +
        'you. Asks the person at the keyboard first, and waits for their answer. Publishing is ' +
        'permanent: an edit becomes a new version rather than changing what people are playing.',
      inputSchema: object(
        {
          slug: string('A short name for the address, like "jumpers". Lower case, no spaces.'),
          visibility: string('"public" to list it, "unlisted" to share only by link.'),
        },
        ['slug'],
      ),
      execute: async (input, options) => {
        const draft = controller.getDraft();
        const report = controller.validate(draft);
        if (report.errors.length) {
          return result(`Not published — the rules are not playable. ${reportLine(report)}`, {
            published: false,
            validation: issuesOf(report),
          });
        }
        const agreed = await controller.confirm(
          `Publish "${draft.name}" to the mode library as "${String(input.slug)}"? ` +
            'Anyone will be able to find and play it.',
          options?.signal,
        );
        if (!agreed) {
          return result('Not published: the person at the keyboard declined.', {
            published: false,
          });
        }
        const published = await controller.publishMode({
          slug: String(input.slug),
          visibility: input.visibility as 'public' | 'unlisted' | undefined,
        });
        return result(`Published as ${published.modeId}. ${published.url}`, {
          published: true,
          ...published,
        });
      },
    },
    {
      name: 'lab_publish_part',
      description:
        'Publish a fragment of this mode as a reusable part, so the next author can use it. ' +
        'Asks the person at the keyboard first.',
      inputSchema: object(
        {
          partId: string('A short name, like "jump".'),
          kind: string('movement, capture, effect, win, draw or turn.'),
          name: string('What it is called.'),
          summary: string('One sentence: what it does.'),
          body: { type: 'object', description: 'The fragment itself, in the rule format.' },
        },
        ['partId', 'kind', 'name', 'summary', 'body'],
      ),
      execute: async (input, options) => {
        const agreed = await controller.confirm(
          `Publish "${String(input.name)}" as a reusable part called "${String(input.partId)}"?`,
          options?.signal,
        );
        if (!agreed) return result('Not published: declined.', { published: false });
        const published = await controller.publishPart({
          partId: String(input.partId),
          kind: input.kind as LibraryPart['kind'],
          name: String(input.name),
          summary: String(input.summary),
          body: input.body,
        });
        return result(`Published ${published.partId}@${published.version}.`, {
          published: true,
          ...published,
        });
      },
    },
  ];

  // Only while there is a game. A tool that is present and cannot work costs the
  // agent a call to find that out.
  if (controller.getGame()) {
    tools.push(
      {
        name: 'lab_get_position',
        description:
          'The test game’s board as text, whose turn it is, how many moves have been played, and ' +
          'whether it has ended and how.',
        annotations: readOnly,
        inputSchema: object({}),
        execute: async () => {
          const game = controller.getGame();
          if (!game) return result('No test game is running.', { game: null });
          return result(describeGame(game, controller.getDraft()), {
            turn: game.currentTurn,
            status: game.status,
            winner: game.winner,
            endReason: game.endReason,
            moveNumber: game.moveNumber,
          });
        },
      },
      {
        name: 'lab_legal_moves',
        description:
          'Every move the side to move may play, or only the ones from one square. This is the ' +
          'rules answering, so it is the fastest way to see whether a movement rule does what ' +
          'you meant.',
        annotations: readOnly,
        inputSchema: object({ from: square('Only moves from this square.') }),
        execute: async (input) => {
          const game = controller.getGame();
          if (!game) return result('No test game is running.', { moves: [] });
          // `from` is honoured rather than ignored: asking what one piece can do
          // is the commonest way to check a movement rule, and answering with
          // every move on the board looks like the rule is far too generous.
          const from = input.from === undefined ? undefined : parseSquare(input.from);
          if (input.from !== undefined && !from) {
            return result('Give a square, like "d7".', { moves: [] });
          }
          const moves = controller.legalMoves(from ?? undefined);
          const named = moves.map((move) => `${squareName(move.from)}-${squareName(move.to)}`);
          const where = from ? ` from ${squareName(from)}` : '';
          return result(
            named.length
              ? `${named.length} legal move${named.length === 1 ? '' : 's'}${where}: ${named.join(' ')}`
              : from
                ? `Nothing can move from ${squareName(from)}.`
                : 'No legal moves — this side is stalemated, which is a draw.',
            { moves: named },
          );
        },
      },
      {
        name: 'lab_play_move',
        description:
          'Play a move in the test game. Refused when the move is not legal, which is itself ' +
          'the answer to "is this move legal".',
        inputSchema: object(
          { from: square('The square to move from.'), to: square('The square to move to.') },
          ['from', 'to'],
        ),
        execute: async (input) => {
          const from = parseSquare(input.from);
          const to = parseSquare(input.to);
          if (!from || !to) {
            return result('Give two squares, like "d7" and "d6".', { played: false });
          }
          if (!controller.play(from, to)) {
            const legal = controller
              .legalMoves()
              .map((move) => `${squareName(move.from)}-${squareName(move.to)}`);
            return result(
              `${squareName(from)}-${squareName(to)} is not legal here. Legal moves: ${legal.join(' ') || 'none'}`,
              { played: false, legalMoves: legal },
            );
          }
          const game = controller.getGame();
          return result(
            `Played ${squareName(from)}-${squareName(to)}. ` +
              (game ? describeGame(game, controller.getDraft()) : ''),
            { played: true },
          );
        },
      },
      {
        name: 'lab_undo',
        description:
          'Take back the last move in the test game, so you can try a different one from the ' +
          'same position.',
        inputSchema: object({}),
        execute: async () => {
          if (!controller.undo()) return result('Nothing to take back.', { undone: false });
          const game = controller.getGame();
          return result(
            `Taken back. ${game ? describeGame(game, controller.getDraft()) : ''}`,
            { undone: true },
          );
        },
      },
      {
        name: 'lab_end_test_game',
        description:
          'Stop the test game and go back to editing. Changing the rules ends it anyway; this is ' +
          'for when you are done playing and want the board out of the way.',
        inputSchema: object({}),
        execute: async () => {
          controller.endGame();
          return result('Test game ended.', { ended: true });
        },
      },
    );
  }

  return tools;
};

/**
 * Mirror the near half of a board onto the far half.
 *
 * Most modes are symmetric, and writing out both halves by hand is where a
 * lopsided opening comes from — one nobody meant, which then makes one side win
 * every playtest for a reason the author cannot see.
 */
export const mirrorRows = (rows: string[], height: number): string[] => {
  const built = Array.from({ length: height }, (_unused, index) => {
    const near = rows[index];
    if (near !== undefined) return near;
    const opposite = rows[height - 1 - index];
    if (opposite === undefined) return '.'.repeat(rows[0]?.length ?? 0);
    // Swapping case swaps sides, which is the whole of the convention.
    return Array.from(opposite)
      .map((symbol) =>
        symbol === symbol.toUpperCase() ? symbol.toLowerCase() : symbol.toUpperCase(),
      )
      .join('');
  });
  return built;
};
