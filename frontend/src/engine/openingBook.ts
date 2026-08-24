// The opening book: an imported engine scan, plus the names people give its
// lines.
//
// The tree itself is produced offline and published by an admin; this module
// only reads it. The naming rules are the interesting part, and they are
// borrowed wholesale from chess — see `openingNameForLine`.

export const OPENING_BOOK_FORMAT = 'rps-opening-book/v1';
/** The flat position graph the server stores and serves a layer at a time. */
export const OPENING_GRAPH_FORMAT = 'rps-opening-book/v2';

/** A line of play, as move notation, from the opening position. */
export type OpeningLine = string[];

/** A named line, as published by an admin. */
export interface OpeningName {
  modeId: string;
  line: OpeningLine;
  name: string;
  updatedAtUnixMs?: number;
}

/** A name somebody has proposed but nobody has published yet. */
export interface OpeningNameSuggestion {
  suggestionId: number;
  modeId: string;
  line: OpeningLine;
  name: string;
  createdAtUnixMs: number;
}

/** One position in the scan, as the engine's exporter wrote it. */
export interface OpeningNode {
  turn: string;
  score: number;
  depth: number;
  selectiveDepth: number;
  nodes: number;
  moves: OpeningEdge[];
}

/** One move out of a scanned position. */
export interface OpeningEdge {
  move: string;
  rank: number;
  score: number;
  mainLine?: boolean;
  /** True when the branch transposes back into a line already in the book. */
  repetition?: boolean;
  /** True when the scan reached this move but recorded no child of its own. */
  searched?: boolean;
  child?: OpeningNode | null;
}

/** The scan itself: what an admin pastes in, and what the server stores. */
export interface OpeningBookDocument {
  format: string;
  modeId: string;
  modeName?: string;
  engineVersion?: string;
  rulesVersion?: number;
  weights?: string;
  symmetry?: string;
  maxPly?: number;
  width?: number;
  /** How many positions the scan searched, which the importer checks. */
  positionCount: number;
  root: OpeningNode;
  mainLine: OpeningLine;
}

export const lineKey = (line: OpeningLine) => line.join(' ');

const nameMap = (names: OpeningName[] | null | undefined) =>
  new Map((names ?? []).map((opening) => [lineKey(opening.line ?? []), opening]));

/** What a line is called, and whether anybody has actually named it. */
export interface OpeningTitle {
  exact: boolean;
  inherited: boolean;
  label: string;
  namedAncestor: OpeningName | null;
  suggestionNeeded: boolean;
}

// Chess names form a hierarchy: a named opening can acquire defenses and
// variations below it without inventing a brand-new family name each time.
// Exact human names always win. Otherwise the nearest named ancestor lends
// its name to the last move, which keeps every branch readable while leaving
// room for someone to give it a better name later.
export const openingNameForLine = (
  names: OpeningName[] | null | undefined,
  line: OpeningLine | null | undefined,
): OpeningTitle => {
  if (!line?.length) {
    return {
      exact: false,
      inherited: false,
      label: 'The Opening Book',
      namedAncestor: null,
      suggestionNeeded: false,
    };
  }

  const byLine = nameMap(names);
  const exact = byLine.get(lineKey(line));
  if (exact) {
    return {
      exact: true,
      inherited: false,
      label: exact.name,
      namedAncestor: exact,
      suggestionNeeded: false,
    };
  }

  const lastMove = line[line.length - 1];
  for (let length = line.length - 1; length > 0; length -= 1) {
    const ancestor = byLine.get(lineKey(line.slice(0, length)));
    if (ancestor) {
      return {
        exact: false,
        inherited: true,
        label: `${ancestor.name}: ${lastMove}`,
        namedAncestor: ancestor,
        suggestionNeeded: true,
      };
    }
  }

  return {
    exact: false,
    inherited: false,
    label: `Suggest a name · ${lastMove}`,
    namedAncestor: null,
    suggestionNeeded: true,
  };
};

// ---------------------------------------------------------------------------
// The served book
// ---------------------------------------------------------------------------
//
// The scan is a graph the *server* owns, keyed by position. A screen asks for
// one position at a time and follows the moves it lists, so what arrives here
// is never the whole book -- which is the point, because the whole book is
// several megabytes and a visitor reads a handful of positions.

/** One move out of a served position. */
export interface OpeningMoveView {
  move: string;
  score: number;
  rank: number;
  searched?: boolean;
  mainLine?: boolean;
  /** The child's key, absent when the scan stored nothing behind the move. */
  child?: string;
  childTurn?: string;
  childDepth?: number;
  /** True when the move walks back into the line that reached this position. */
  repetition?: boolean;
}

/** One position, as the server serves it. */
export interface OpeningNodeView {
  key: string;
  turn: string;
  score: number;
  depth: number;
  selectiveDepth: number;
  nodes: number;
  moves: OpeningMoveView[];
}

/** Everything about a published book except its positions. */
export interface OpeningBookMeta {
  modeId: string;
  modeName?: string;
  engineVersion?: string;
  rulesVersion?: number;
  weights?: string;
  symmetry?: string;
  maxPly?: number;
  rootKey: string;
  positionCount: number;
  mainLine: OpeningLine;
  /** The openings good enough to be worth having before the first tap. */
  featured: OpeningLine[];
  updatedAtUnixMs?: number;
}

/**
 * What arrives on the first request: enough to render the screen and to click
 * through the recommended openings without asking again.
 */
export interface OpeningBookBootstrap extends OpeningBookMeta {
  names: OpeningName[];
  root: OpeningNodeView;
  /** Every position along every featured line, deduplicated by key. */
  featuredPositions: OpeningNodeView[];
}

/** One position, and the line that reached it. */
export interface OpeningNodeResponse {
  line: OpeningLine;
  node: OpeningNodeView;
}

/**
 * Seed a line-keyed cache from a bootstrap.
 *
 * The bootstrap names its featured openings as *lines* and ships their
 * positions as a flat, deduplicated list, so this walks each line through the
 * positions by key to recover which line reaches which position. That is what
 * lets a featured opening be clicked through with no network at all, while
 * everything else is fetched on demand.
 */
export const seedOpeningCache = (
  bootstrap: OpeningBookBootstrap | null | undefined,
): Map<string, OpeningNodeView> => {
  const cache = new Map<string, OpeningNodeView>();
  if (!bootstrap?.root) return cache;
  const byKey = new Map<string, OpeningNodeView>();
  byKey.set(bootstrap.root.key, bootstrap.root);
  for (const position of bootstrap.featuredPositions ?? []) byKey.set(position.key, position);

  cache.set(lineKey([]), bootstrap.root);
  for (const featured of bootstrap.featured ?? []) {
    let node: OpeningNodeView | undefined = bootstrap.root;
    const walked: string[] = [];
    for (const notation of featured) {
      const edge: OpeningMoveView | undefined = node?.moves?.find(
        (candidate) => candidate.move === notation,
      );
      const next: OpeningNodeView | undefined = edge?.child ? byKey.get(edge.child) : undefined;
      if (!next) break;
      walked.push(notation);
      cache.set(lineKey(walked), next);
      node = next;
    }
  }
  return cache;
};

export type OpeningKind = 'Book' | 'Opening' | 'Defense' | 'Variation';

export const openingKind = (line: OpeningLine | null | undefined): OpeningKind => {
  if (!line?.length) return 'Book';
  if (line.length === 1) return 'Opening';
  if (line.length === 2) return 'Defense';
  return 'Variation';
};

/**
 * Walk a *nested* v1 tree. The served book is a graph now, so this is only for
 * a document pasted into the curator studio, which is still the tree shape.
 */
export const nodeAtLine = (
  root: OpeningNode | null | undefined,
  line: OpeningLine | null | undefined,
): OpeningNode | null => {
  let node: OpeningNode | null = root ?? null;
  for (const notation of line ?? []) {
    const edge = node?.moves?.find((candidate) => candidate.move === notation);
    if (!edge) return null;
    node = edge.child ?? null;
  }
  return node;
};

export const exactOpeningName = (
  names: OpeningName[] | null | undefined,
  line: OpeningLine | null | undefined,
): OpeningName | null =>
  (names ?? []).find((opening) => lineKey(opening.line ?? []) === lineKey(line ?? [])) ?? null;

/** A flat position graph, as `book export --format graph` writes it. */
export interface OpeningGraphDocument {
  format: string;
  modeId: string;
  modeName?: string;
  engineVersion?: string;
  rulesVersion?: number;
  weights?: string;
  symmetry?: string;
  maxPly?: number;
  rootKey: string;
  positionCount: number;
  mainLine: OpeningLine;
  featured: OpeningLine[];
  positions: OpeningNodeView[];
}

/** Either shape the curator studio and the import route accept. */
export type OpeningBookUpload = OpeningBookDocument | OpeningGraphDocument;

/**
 * Check a pasted file before it is uploaded.
 *
 * Both shapes are allowed: the graph is what the engine writes now, and the
 * nested tree is what older exports are. The server accepts either and stores
 * a graph, so the only thing worth catching here is a file for the wrong mode
 * or a file that is not a book at all -- the two mistakes a curator actually
 * makes, and the two the server's own error would report far less clearly.
 */
export const validateOpeningBookDocument = (
  book: unknown,
  expectedModeId: string,
): OpeningBookUpload => {
  if (!book || typeof book !== 'object') throw new Error('Paste an opening-book JSON object.');
  const candidate = book as Partial<OpeningBookDocument & OpeningGraphDocument>;
  if (candidate.format !== OPENING_GRAPH_FORMAT && candidate.format !== OPENING_BOOK_FORMAT) {
    throw new Error(`Expected ${OPENING_GRAPH_FORMAT} or ${OPENING_BOOK_FORMAT}.`);
  }
  if (candidate.modeId !== expectedModeId) {
    throw new Error(`This is a ${candidate.modeId ?? 'mode-less'} book, not ${expectedModeId}.`);
  }
  if (!Array.isArray(candidate.mainLine)) {
    throw new Error('The opening book has no main line.');
  }
  if (candidate.format === OPENING_GRAPH_FORMAT) {
    if (!candidate.rootKey || !Array.isArray(candidate.positions) || !candidate.positions.length) {
      throw new Error('The opening-book graph is incomplete.');
    }
  } else if (!candidate.root || !Array.isArray(candidate.root.moves)) {
    throw new Error('The opening-book tree is incomplete.');
  }
  return candidate as OpeningBookUpload;
};
