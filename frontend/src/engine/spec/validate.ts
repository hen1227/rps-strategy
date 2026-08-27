// Is this a spec, and does it mean anything?
//
// Two jobs in one pass, and they are worth separating in your head:
//
//   **Errors** are things no interpreter could act on — a movement rule for a
//   piece that does not exist, a layout that is not the board's shape, a
//   predicate with a hole in it. A spec with errors is never played.
//
//   **Warnings** are things that are legal and probably not what the author
//   meant: a win condition nothing can satisfy, a piece nothing can capture, an
//   opening with no legal move. The Lab shows them; publishing does not refuse
//   them, because "probably wrong" is the author's call and somebody's fourth
//   invention will want exactly the thing the third one got warned about.
//
// This is also the **publish boundary**. A spec arrives from a stranger, so the
// caps below are not tidiness — they are the bound on how much work one
// published mode can make the server do, and `backend/internal/game/spec` runs
// the same checks with the same numbers. The two must agree: a spec the browser
// accepts and the server refuses is a Lab that lies to its author.

import { MAX_BOARD_SIDE, MAX_BOARD_TILES, MIN_BOARD_SIDE, isBoardRows } from '@/types/game';
import { isArtRef, PIECE_ART, SPEC_VERSION, type PieceArt } from './types';

/** How big a published spec may be, in bytes of JSON. */
export const MAX_SPEC_BYTES = 16 * 1024;

export const SPEC_LIMITS = {
  pieces: 12,
  beats: 64,
  movement: 24,
  effects: 24,
  win: 16,
  /** How deeply predicates and terms may nest. Bounds evaluation cost. */
  depth: 12,
  /** Explicit direction offsets in one rule. */
  offsets: 32,
  /** Squares named explicitly by one region. */
  squares: MAX_BOARD_TILES,
  /** Characters in a name, description or objective. */
  text: 400,
  /**
   * Distinct uploaded pictures one mode may name: every piece, the board and
   * the cover.
   *
   * Derived from `pieces`, so a spec that passes the piece cap cannot reach
   * this one — it is here to bound the work a publish asks of the database
   * (every picture is a row to look up and a row to pin) even if the piece cap
   * is ever raised without anybody thinking about art.
   */
  artRefs: 14,
} as const;

export interface SpecIssue {
  /** A JSON path into the spec, so the Lab can point at the field. */
  path: string;
  message: string;
}

export interface SpecReport {
  errors: SpecIssue[];
  warnings: SpecIssue[];
}

export const isValid = (report: SpecReport) => report.errors.length === 0;

/** The one-line summary a tool result leads with. */
export const describeReport = (report: SpecReport): string => {
  if (report.errors.length) {
    const count = report.errors.length;
    return `${count} error${count === 1 ? '' : 's'}: ${report.errors
      .slice(0, 3)
      .map((issue) => `${issue.path || '(spec)'} — ${issue.message}`)
      .join('; ')}`;
  }
  if (report.warnings.length) {
    const count = report.warnings.length;
    return `valid, with ${count} warning${count === 1 ? '' : 's'}`;
  }
  return 'valid';
};

const SIDE_REFS = ['mover', 'opponent', 'red', 'blue', 'neutral', 'any'] as const;
const SIDE_REF_SET = new Set<string>(SIDE_REFS);
const DIRECTION_NAMES = new Set([
  'all8',
  'orthogonal',
  'diagonal',
  'forward',
  'forwardDiagonal',
  'backward',
  'sideways',
]);
const MOVEMENT_KINDS = ['step', 'slide', 'leap', 'jumpOver'] as const;
const COMPARISONS = ['eq', 'lt', 'lte', 'gt', 'gte'] as const;
const REGION_KINDS = [
  'rows',
  'columns',
  'squares',
  'rect',
  'home',
  'corners',
  'edge',
  'all',
  'destination',
  'origin',
] as const;
const EFFECT_KINDS = [
  'claimTerritory',
  'setTerritory',
  'promote',
  'remove',
  'spawn',
  'extraTurn',
] as const;

/**
 * Author-supplied text reaches other people's screens. Control characters are
 * the only thing refused outright; everything else is rendered as plain text.
 *
 * Written as a code-point test rather than a regex so the source of this file
 * stays printable — a character class of literal control bytes is unreadable and
 * easy to corrupt in a patch.
 */
const hasControlCharacter = (text: string) =>
  Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Exactly one of these keys, which is how every tagged union here is spelled. */
const soleKey = (value: Record<string, unknown>, allowed: readonly string[]): string | null => {
  const present = Object.keys(value).filter((key) => allowed.includes(key));
  return present.length === 1 ? (present[0] ?? null) : null;
};

export const validateSpec = (candidate: unknown): SpecReport => {
  const errors: SpecIssue[] = [];
  const warnings: SpecIssue[] = [];
  const fail = (path: string, message: string) => {
    errors.push({ path, message });
  };
  const warn = (path: string, message: string) => {
    warnings.push({ path, message });
  };

  /**
   * An artwork reference: a bundled name, or `img:` and a digest.
   *
   * The two halves are deliberately not equally strict. A name this build does
   * not recognise is a **warning**, because that is what lets the format grow a
   * new bundled picture without every older reader refusing modes that use it —
   * the cost of being wrong is a letter instead of a drawing. A malformed
   * `img:` reference is an **error**, because it can only be a mistake: nothing
   * will ever resolve it, and saying so at the moment it is written is cheaper
   * than a published mode with a permanent hole in it.
   */
  const artRefs = new Set<string>();
  const checkArt = (path: string, value: unknown, allowBundled: boolean) => {
    if (value === undefined) return;
    if (typeof value !== 'string' || value.trim() === '') {
      fail(path, 'an artwork name, or an uploaded picture as "img:<digest>"');
      return;
    }
    if (value.startsWith('img:')) {
      if (isArtRef(value)) {
        artRefs.add(value);
      } else {
        fail(path, 'an uploaded picture is "img:" and 32 lower-case hex characters');
      }
      return;
    }
    if (!allowBundled) {
      fail(path, `an uploaded picture as "img:<digest>", not "${value}"`);
      return;
    }
    if (!PIECE_ART.includes(value as PieceArt)) {
      // Not an error: a kind with no artwork is drawn as its letter, so an
      // unknown name only costs the picture.
      warn(path, `no bundled artwork called "${value}"; it will draw as a letter`);
    }
  };

  if (!isObject(candidate)) {
    return { errors: [{ path: '', message: 'a spec is a JSON object' }], warnings };
  }
  // Deliberately untyped from here on. This function's whole job is to decide
  // whether the thing in front of it *is* a RuleSpec, so reading it through
  // RuleSpec would be assuming the answer — and the compiler would then hide
  // the very holes this is looking for.
  const spec = candidate as Record<string, unknown>;

  if (spec.spec !== SPEC_VERSION) {
    fail('spec', `this build reads rule language version ${SPEC_VERSION}, got ${String(spec.spec)}`);
    // Everything below assumes v1 shapes, so there is nothing useful to add.
    return { errors, warnings };
  }

  /* ------------------------------------------------------------- identity -- */

  for (const field of ['name', 'shortCode', 'description', 'objective'] as const) {
    const value = spec[field];
    if (typeof value !== 'string' || value.trim() === '') {
      fail(field, 'required, and not blank');
      continue;
    }
    if (value.length > SPEC_LIMITS.text) fail(field, `at most ${SPEC_LIMITS.text} characters`);
    if (hasControlCharacter(value)) fail(field, 'contains control characters');
  }
  if (typeof spec.shortCode === 'string' && !/^[A-Za-z0-9]{1,6}$/.test(spec.shortCode)) {
    fail('shortCode', 'one to six letters or digits');
  }

  /* ---------------------------------------------------------------- board -- */

  const board = spec.board;
  let width = 0;
  let height = 0;
  if (!isObject(board) || typeof board.width !== 'number' || typeof board.height !== 'number') {
    fail('board', 'required: { width, height }');
  } else {
    width = board.width;
    height = board.height;
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      fail('board', 'width and height are whole numbers');
    } else if (
      width < MIN_BOARD_SIDE ||
      height < MIN_BOARD_SIDE ||
      width > MAX_BOARD_SIDE ||
      height > MAX_BOARD_SIDE
    ) {
      fail('board', `each side is between ${MIN_BOARD_SIDE} and ${MAX_BOARD_SIDE}`);
    } else if (width * height > MAX_BOARD_TILES) {
      fail('board', `at most ${MAX_BOARD_TILES} tiles, got ${width * height}`);
    }
    checkArt('board.art', board.art, false);
  }

  checkArt('cover', spec.cover, false);

  /* --------------------------------------------------------------- pieces -- */

  const kinds = new Set<string>();
  const symbols = new Map<string, string>();
  if (!Array.isArray(spec.pieces) || spec.pieces.length === 0) {
    fail('pieces', 'at least one kind of piece');
  } else if (spec.pieces.length > SPEC_LIMITS.pieces) {
    fail('pieces', `at most ${SPEC_LIMITS.pieces} kinds`);
  } else {
    spec.pieces.forEach((piece, index) => {
      const path = `pieces[${index}]`;
      if (!isObject(piece)) {
        fail(path, 'a piece is an object');
        return;
      }
      if (typeof piece.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(piece.id)) {
        fail(`${path}.id`, 'letters, digits, dash or underscore, starting with a letter');
      } else if (piece.id === 'Empty') {
        // `Empty` is what an unoccupied tile carries, so a kind by that name
        // would be a piece indistinguishable from no piece at all.
        fail(`${path}.id`, '"Empty" is reserved for a square with nothing on it');
      } else if (kinds.has(piece.id)) {
        fail(`${path}.id`, `duplicate piece id "${piece.id}"`);
      } else {
        kinds.add(piece.id);
      }
      if (typeof piece.name !== 'string' || piece.name.trim() === '') {
        fail(`${path}.name`, 'required');
      }
      if (typeof piece.symbol !== 'string' || !/^[A-Z]$/.test(piece.symbol)) {
        // One letter, and upper case: the case of a symbol in a layout is which
        // side owns the piece, so a lower-case symbol would have no room left
        // to say that.
        fail(`${path}.symbol`, 'one upper-case letter, A to Z');
      } else if (symbols.has(piece.symbol)) {
        fail(`${path}.symbol`, `symbol ${piece.symbol} is already ${symbols.get(piece.symbol)}`);
      } else if (typeof piece.id === 'string') {
        symbols.set(piece.symbol, piece.id);
      }
      checkArt(`${path}.art`, piece.art, true);
    });
  }

  /* ---------------------------------------------------------------- beats -- */

  const predators = new Map<string, string[]>();
  if (!Array.isArray(spec.beats)) {
    fail('beats', 'required: a list of [attacker, defender] pairs');
  } else if (spec.beats.length > SPEC_LIMITS.beats) {
    fail('beats', `at most ${SPEC_LIMITS.beats} pairs`);
  } else {
    const seen = new Set<string>();
    spec.beats.forEach((edge, index) => {
      const path = `beats[${index}]`;
      if (!Array.isArray(edge) || edge.length !== 2) {
        fail(path, 'a pair: [attacker, defender]');
        return;
      }
      const [attacker, defender] = edge;
      for (const [role, kind] of [
        ['attacker', attacker],
        ['defender', defender],
      ] as const) {
        if (typeof kind !== 'string' || !kinds.has(kind)) {
          fail(path, `${role} "${String(kind)}" is not a declared piece`);
        }
      }
      // `[X, X]` is allowed on purpose: a kind that takes its own kind is how a
      // chess pawn works, and refusing it would refuse a whole family of modes
      // for the sake of a tidiness nothing needs.
      const key = `${String(attacker)}>${String(defender)}`;
      if (seen.has(key)) fail(path, 'duplicate pair');
      seen.add(key);
      if (typeof defender === 'string' && typeof attacker === 'string') {
        predators.set(defender, [...(predators.get(defender) ?? []), attacker]);
      }
    });
  }

  const captureMode = isObject(spec.capture) ? spec.capture.mode : undefined;
  if (
    captureMode !== undefined &&
    !['beats', 'always', 'never', 'mutual'].includes(String(captureMode))
  ) {
    fail('capture.mode', 'one of beats, always, never, mutual');
  }
  if (captureMode === undefined || captureMode === 'beats') {
    for (const kind of kinds) {
      if (!predators.has(kind)) {
        warn(
          'beats',
          `nothing captures "${kind}", so it can never be taken — an annihilation win may be unreachable`,
        );
      }
    }
  }

  /* ----------------------------------------------------- starting position -- */

  const rows = isObject(spec.startingPosition) ? spec.startingPosition.rows : undefined;
  if (!isBoardRows(rows)) {
    fail('startingPosition.rows', 'a rectangle of rows, each the same length');
  } else if (width > 0 && (rows.length !== height || rows[0]?.length !== width)) {
    fail(
      'startingPosition.rows',
      `the board is ${width} by ${height}, but the layout is ${rows[0]?.length ?? 0} by ${rows.length}`,
    );
  } else {
    const allowed = new Set(['.']);
    for (const symbol of symbols.keys()) {
      allowed.add(symbol);
      allowed.add(symbol.toLowerCase());
    }
    let blue = 0;
    let red = 0;
    rows.forEach((row, y) => {
      Array.from(row).forEach((symbol, x) => {
        if (!allowed.has(symbol)) {
          fail(`startingPosition.rows[${y}]`, `"${symbol}" at file ${x + 1} is not a declared piece`);
        } else if (symbol !== '.') {
          if (symbol === symbol.toUpperCase()) blue += 1;
          else red += 1;
        }
      });
    });
    if (blue + red === 0) warn('startingPosition.rows', 'the opening board is empty');
    else if (red === 0) {
      warn('startingPosition.rows', 'Red starts with no pieces, so Red has no legal move');
    } else if (blue === 0) {
      warn('startingPosition.rows', 'Blue starts with no pieces, so Blue has no legal move');
    }
  }

  /* --------------------------------------------- regions, terms, questions -- */

  const checkRegion = (region: unknown, path: string) => {
    if (!isObject(region)) {
      fail(path, 'a region is an object');
      return;
    }
    const key = soleKey(region, REGION_KINDS);
    if (!key) {
      fail(path, 'a region names exactly one kind');
      return;
    }
    if (key === 'rows' || key === 'columns') {
      const limit = key === 'rows' ? height : width;
      const list = region[key];
      if (!Array.isArray(list) || list.length === 0) {
        fail(path, `${key} is a non-empty list of indexes`);
        return;
      }
      list.forEach((value, index) => {
        if (!Number.isInteger(value) || Number(value) < 0 || Number(value) >= limit) {
          fail(`${path}.${key}[${index}]`, `outside a board ${width} by ${height}`);
        }
      });
    }
    if (key === 'squares') {
      const list = region.squares;
      if (!Array.isArray(list)) {
        fail(path, 'squares is a list of [x, y]');
        return;
      }
      if (list.length > SPEC_LIMITS.squares) fail(path, 'too many squares');
      list.forEach((square, index) => {
        const onBoard =
          Array.isArray(square) &&
          square.length === 2 &&
          Number.isInteger(square[0]) &&
          Number.isInteger(square[1]) &&
          Number(square[0]) >= 0 &&
          Number(square[0]) < width &&
          Number(square[1]) >= 0 &&
          Number(square[1]) < height;
        if (!onBoard) {
          fail(`${path}.squares[${index}]`, `not a square on a ${width} by ${height} board`);
        }
      });
    }
    if (key === 'rect') {
      const rect = region.rect;
      const whole =
        isObject(rect) &&
        Number.isInteger(rect.x) &&
        Number.isInteger(rect.y) &&
        Number.isInteger(rect.width) &&
        Number.isInteger(rect.height);
      if (!whole) fail(path, 'rect is { x, y, width, height } in whole numbers');
    }
    if (key === 'home' && !['mover', 'opponent', 'red', 'blue'].includes(String(region.home))) {
      fail(`${path}.home`, 'one of mover, opponent, red, blue');
    }
    for (const flag of ['corners', 'edge', 'all', 'destination', 'origin'] as const) {
      if (key === flag && region[flag] !== true) fail(`${path}.${flag}`, 'only true');
    }
  };

  const checkFilter = (filter: unknown, path: string) => {
    if (!isObject(filter)) {
      fail(path, 'a tile filter is an object');
      return;
    }
    if (filter.region !== undefined) checkRegion(filter.region, `${path}.region`);
    for (const field of ['owner', 'territory'] as const) {
      if (filter[field] !== undefined && !SIDE_REF_SET.has(String(filter[field]))) {
        fail(`${path}.${field}`, `one of ${SIDE_REFS.join(', ')}`);
      }
    }
    if (filter.piece !== undefined) {
      for (const kind of Array.isArray(filter.piece) ? filter.piece : [filter.piece]) {
        if (typeof kind !== 'string' || !kinds.has(kind)) {
          fail(`${path}.piece`, `"${String(kind)}" is not a declared piece`);
        }
      }
    }
    if (filter.empty !== undefined && typeof filter.empty !== 'boolean') {
      fail(`${path}.empty`, 'true or false');
    }
  };

  const checkTerm = (term: unknown, path: string, depth: number) => {
    if (depth > SPEC_LIMITS.depth) {
      fail(path, `nested deeper than ${SPEC_LIMITS.depth}`);
      return;
    }
    if (typeof term === 'number') {
      if (!Number.isFinite(term)) fail(path, 'not a finite number');
      return;
    }
    if (!isObject(term)) {
      fail(path, 'a term is a number or an object');
      return;
    }
    const key = soleKey(term, ['count', 'row', 'column', 'moveNumber', 'share']);
    if (!key) {
      fail(path, 'a term names exactly one kind');
      return;
    }
    if (key === 'count') checkFilter(term.count, `${path}.count`);
    if ((key === 'row' || key === 'column') && !['from', 'to'].includes(String(term[key]))) {
      fail(`${path}.${key}`, 'from or to');
    }
    if (key === 'moveNumber' && term.moveNumber !== true) fail(`${path}.moveNumber`, 'only true');
    if (key === 'share' && !SIDE_REF_SET.has(String(term.share))) {
      fail(`${path}.share`, `one of ${SIDE_REFS.join(', ')}`);
    }
  };

  const checkPredicate = (predicate: unknown, path: string, depth: number) => {
    if (depth > SPEC_LIMITS.depth) {
      fail(path, `nested deeper than ${SPEC_LIMITS.depth}`);
      return;
    }
    if (typeof predicate === 'boolean') return;
    if (!isObject(predicate)) {
      fail(path, 'a condition is true, false, or an object');
      return;
    }
    const key = soleKey(predicate, [
      'and',
      'or',
      'not',
      ...COMPARISONS,
      'in',
      'captured',
      'moved',
      'any',
      'all',
    ]);
    if (!key) {
      fail(path, 'a condition names exactly one kind');
      return;
    }
    if (key === 'and' || key === 'or') {
      const list = predicate[key];
      if (!Array.isArray(list) || list.length === 0) {
        fail(`${path}.${key}`, 'a non-empty list');
        return;
      }
      list.forEach((item, index) => checkPredicate(item, `${path}.${key}[${index}]`, depth + 1));
      return;
    }
    if (key === 'not') {
      checkPredicate(predicate.not, `${path}.not`, depth + 1);
      return;
    }
    if ((COMPARISONS as readonly string[]).includes(key)) {
      const pair = predicate[key];
      if (!Array.isArray(pair) || pair.length !== 2) {
        fail(`${path}.${key}`, 'a pair of terms');
        return;
      }
      checkTerm(pair[0], `${path}.${key}[0]`, depth + 1);
      checkTerm(pair[1], `${path}.${key}[1]`, depth + 1);
      return;
    }
    if (key === 'in') {
      const pair = predicate.in;
      if (!Array.isArray(pair) || pair.length !== 2) {
        fail(`${path}.in`, '[from|to, region]');
        return;
      }
      if (!['from', 'to'].includes(String(pair[0]))) fail(`${path}.in[0]`, 'from or to');
      checkRegion(pair[1], `${path}.in[1]`);
      return;
    }
    if (key === 'captured') {
      if (predicate.captured !== true) {
        fail(`${path}.captured`, 'only true; wrap it in `not` for the other case');
      }
      return;
    }
    if (key === 'moved') {
      for (const kind of Array.isArray(predicate.moved) ? predicate.moved : [predicate.moved]) {
        if (typeof kind !== 'string' || !kinds.has(kind)) {
          fail(`${path}.moved`, `"${String(kind)}" is not a declared piece`);
        }
      }
      return;
    }
    if (key === 'any' || key === 'all') {
      const quantifier = predicate[key];
      if (!isObject(quantifier)) {
        fail(`${path}.${key}`, '{ tiles, where }');
        return;
      }
      checkFilter(quantifier.tiles, `${path}.${key}.tiles`);
      if (quantifier.where !== undefined) {
        checkPredicate(quantifier.where, `${path}.${key}.where`, depth + 1);
      }
    }
  };

  /* ------------------------------------------------------------- movement -- */

  const checkDirections = (dirs: unknown, path: string) => {
    if (typeof dirs === 'string') {
      if (!DIRECTION_NAMES.has(dirs)) fail(path, `unknown direction set "${dirs}"`);
      return;
    }
    if (!isObject(dirs) || !Array.isArray(dirs.offsets)) {
      fail(path, 'a direction name or { offsets: [[dx, dy], ...] }');
      return;
    }
    if (dirs.offsets.length === 0) fail(path, 'offsets cannot be empty');
    if (dirs.offsets.length > SPEC_LIMITS.offsets) {
      fail(path, `at most ${SPEC_LIMITS.offsets} offsets`);
    }
    dirs.offsets.forEach((offset, index) => {
      const pair =
        Array.isArray(offset) &&
        offset.length === 2 &&
        Number.isInteger(offset[0]) &&
        Number.isInteger(offset[1]);
      if (!pair) {
        fail(`${path}.offsets[${index}]`, 'a pair of whole numbers');
        return;
      }
      if (offset[0] === 0 && offset[1] === 0) {
        fail(`${path}.offsets[${index}]`, 'a piece cannot move to the square it is on');
      }
      if (
        Math.abs(Number(offset[0])) >= MAX_BOARD_SIDE ||
        Math.abs(Number(offset[1])) >= MAX_BOARD_SIDE
      ) {
        fail(`${path}.offsets[${index}]`, 'longer than any board');
      }
    });
  };

  if (!Array.isArray(spec.movement) || spec.movement.length === 0) {
    fail('movement', 'at least one movement rule, or nothing can move');
  } else if (spec.movement.length > SPEC_LIMITS.movement) {
    fail('movement', `at most ${SPEC_LIMITS.movement} rules`);
  } else {
    const covered = new Set<string>();
    spec.movement.forEach((rule, index) => {
      const path = `movement[${index}]`;
      if (!isObject(rule)) {
        fail(path, 'a movement rule is an object');
        return;
      }
      if (!(MOVEMENT_KINDS as readonly string[]).includes(String(rule.kind))) {
        fail(`${path}.kind`, `one of ${MOVEMENT_KINDS.join(', ')}`);
      }
      checkDirections(rule.dirs, `${path}.dirs`);
      if (
        rule.distance !== undefined &&
        (!Number.isInteger(rule.distance) || Number(rule.distance) < 1)
      ) {
        fail(`${path}.distance`, 'a whole number of at least 1');
      }
      if (
        rule.maxDistance !== undefined &&
        (!Number.isInteger(rule.maxDistance) || Number(rule.maxDistance) < 1)
      ) {
        fail(`${path}.maxDistance`, 'a whole number of at least 1');
      }
      if (rule.targets !== undefined && !['empty', 'enemy', 'any'].includes(String(rule.targets))) {
        fail(`${path}.targets`, 'one of empty, enemy, any');
      }
      if (rule.mustCapture !== undefined && typeof rule.mustCapture !== 'boolean') {
        fail(`${path}.mustCapture`, 'true or false');
      }
      if (rule.when !== undefined) checkPredicate(rule.when, `${path}.when`, 1);
      const pieces =
        rule.piece === undefined
          ? [...kinds]
          : Array.isArray(rule.piece)
            ? rule.piece
            : [rule.piece];
      for (const kind of pieces) {
        if (typeof kind !== 'string' || !kinds.has(kind)) {
          fail(`${path}.piece`, `"${String(kind)}" is not a declared piece`);
        } else {
          covered.add(kind);
        }
      }
    });
    for (const kind of kinds) {
      if (!covered.has(kind)) {
        warn('movement', `no rule lets "${kind}" move, so it can only ever sit still`);
      }
    }
  }

  /* -------------------------------------------------------------- effects -- */

  if (spec.effects !== undefined) {
    if (!Array.isArray(spec.effects)) {
      fail('effects', 'a list of effect rules');
    } else if (spec.effects.length > SPEC_LIMITS.effects) {
      fail('effects', `at most ${SPEC_LIMITS.effects} rules`);
    } else {
      spec.effects.forEach((rule, index) => {
        const path = `effects[${index}]`;
        if (!isObject(rule)) {
          fail(path, 'an effect rule is an object');
          return;
        }
        if (!['move', 'capture', 'turnEnd'].includes(String(rule.on))) {
          fail(`${path}.on`, 'one of move, capture, turnEnd');
        }
        if (rule.when !== undefined) checkPredicate(rule.when, `${path}.when`, 1);
        if (!Array.isArray(rule.do) || rule.do.length === 0) {
          fail(`${path}.do`, 'at least one effect');
          return;
        }
        rule.do.forEach((effect, position) => {
          const effectPath = `${path}.do[${position}]`;
          if (!isObject(effect)) {
            fail(effectPath, 'an effect is an object');
            return;
          }
          const key = soleKey(effect, EFFECT_KINDS);
          if (!key) {
            fail(effectPath, 'an effect names exactly one kind');
            return;
          }
          if (key === 'claimTerritory' && !SIDE_REF_SET.has(String(effect.claimTerritory))) {
            fail(`${effectPath}.claimTerritory`, `one of ${SIDE_REFS.join(', ')}`);
          }
          if (key === 'setTerritory') {
            const set = effect.setTerritory;
            if (!isObject(set)) {
              fail(effectPath, 'setTerritory is { tiles, to }');
              return;
            }
            checkFilter(set.tiles, `${effectPath}.setTerritory.tiles`);
            if (!SIDE_REF_SET.has(String(set.to))) {
              fail(`${effectPath}.setTerritory.to`, `one of ${SIDE_REFS.join(', ')}`);
            }
          }
          if (key === 'promote') {
            const to = isObject(effect.promote) ? effect.promote.to : undefined;
            if (typeof to !== 'string' || !kinds.has(to)) {
              fail(`${effectPath}.promote.to`, `"${String(to)}" is not a declared piece`);
            }
          }
          if (key === 'remove') {
            const remove = effect.remove;
            if (!isObject(remove)) {
              fail(effectPath, 'remove is { tiles }');
              return;
            }
            checkFilter(remove.tiles, `${effectPath}.remove.tiles`);
          }
          if (key === 'spawn') {
            const spawn = effect.spawn;
            if (!isObject(spawn)) {
              fail(effectPath, 'spawn is { piece, owner, at }');
              return;
            }
            if (typeof spawn.piece !== 'string' || !kinds.has(spawn.piece)) {
              fail(`${effectPath}.spawn.piece`, `"${String(spawn.piece)}" is not a declared piece`);
            }
            if (!SIDE_REF_SET.has(String(spawn.owner))) {
              fail(`${effectPath}.spawn.owner`, `one of ${SIDE_REFS.join(', ')}`);
            }
            checkRegion(spawn.at, `${effectPath}.spawn.at`);
          }
          if (key === 'extraTurn' && effect.extraTurn !== true) {
            fail(`${effectPath}.extraTurn`, 'only true');
          }
        });
      });
    }
  }

  /* -------------------------------------------------------------- win/draw -- */

  if (!Array.isArray(spec.win)) {
    fail('win', 'a list of win conditions, even if it is empty');
  } else if (spec.win.length > SPEC_LIMITS.win) {
    fail('win', `at most ${SPEC_LIMITS.win} conditions`);
  } else {
    if (spec.win.length === 0) {
      // Legal, and worth saying out loud. Infiltration has no annihilation rule
      // and leans on the engine's stalemate draw, so a mode with no win
      // condition at all is a mode that can only be drawn or resigned.
      warn('win', 'no win condition, so this mode can only end in a draw or a resignation');
    }
    spec.win.forEach((condition, index) => {
      const path = `win[${index}]`;
      if (!isObject(condition)) {
        fail(path, 'a win condition is an object');
        return;
      }
      if (condition.when === undefined) fail(`${path}.when`, 'required');
      else checkPredicate(condition.when, `${path}.when`, 1);
      const result = condition.result;
      if (typeof result === 'string') {
        if (!['mover', 'opponent', 'draw'].includes(result)) {
          fail(`${path}.result`, 'one of mover, opponent, draw, or { moreOf }');
        }
      } else if (isObject(result) && isObject(result.moreOf)) {
        checkTerm(result.moreOf.red, `${path}.result.moreOf.red`, 1);
        checkTerm(result.moreOf.blue, `${path}.result.moreOf.blue`, 1);
      } else {
        fail(`${path}.result`, 'one of mover, opponent, draw, or { moreOf: { red, blue } }');
      }
      if (
        condition.reason !== undefined &&
        !/^[a-z][a-z0-9_]{0,31}$/.test(String(condition.reason))
      ) {
        fail(`${path}.reason`, 'lower-case letters, digits and underscores');
      }
    });
  }

  if (spec.draw !== undefined) {
    if (!isObject(spec.draw)) {
      fail('draw', 'an object');
    } else {
      const { moveLimit } = spec.draw;
      if (moveLimit !== undefined && moveLimit !== null) {
        if (!Number.isInteger(moveLimit) || Number(moveLimit) < 1) {
          fail('draw.moveLimit', 'null, or a whole number of at least 1');
        }
      }
      // Named so an author who tried to switch off a rule they cannot switch off
      // is told, rather than left believing they did.
      for (const engineRule of ['repetition', 'stalemate'] as const) {
        if (engineRule in spec.draw) {
          fail(
            `draw.${engineRule}`,
            `${engineRule} is the engine's rule and applies to every mode; a spec cannot change it`,
          );
        }
      }
    }
  }

  if (spec.turn !== undefined) {
    if (!isObject(spec.turn)) {
      fail('turn', 'an object');
    } else {
      const { movesPerTurn, mayPass } = spec.turn;
      if (
        movesPerTurn !== undefined &&
        (!Number.isInteger(movesPerTurn) || Number(movesPerTurn) < 1)
      ) {
        fail('turn.movesPerTurn', 'a whole number of at least 1');
      }
      if (mayPass !== undefined && typeof mayPass !== 'boolean') {
        fail('turn.mayPass', 'true or false');
      }
    }
  }

  /* ----------------------------------------------------------------- size -- */

  // Last, because a spec with structural errors is not worth weighing, and the
  // caps above already bound everything this could catch. It is here for the one
  // case they do not: a spec legal in every part and enormous in total.
  if (errors.length === 0) {
    const bytes = JSON.stringify(spec).length;
    if (bytes > MAX_SPEC_BYTES) {
      fail('', `a published spec is at most ${MAX_SPEC_BYTES} bytes, this one is ${bytes}`);
    }
  }

  if (artRefs.size > SPEC_LIMITS.artRefs) {
    fail(
      '',
      `at most ${SPEC_LIMITS.artRefs} uploaded pictures in one mode, this one names ${artRefs.size}`,
    );
  }

  return { errors, warnings };
};
