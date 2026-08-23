// The opening book: an imported engine scan, plus the names people give its
// lines.
//
// The tree itself is produced offline and published by an admin; this module
// only reads it. The naming rules are the interesting part, and they are
// borrowed wholesale from chess — see `openingNameForLine`.

export const OPENING_BOOK_FORMAT = 'rps-opening-book/v1';

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

/**
 * What the server serves: the scan, plus the names people have given its lines.
 *
 * The two are stored apart on purpose — a fresh scan replaces the tree without
 * touching a single name.
 */
export interface PublishedOpeningBook {
  book: OpeningBookDocument;
  names: OpeningName[];
  updatedAtUnixMs: number;
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

export type OpeningKind = 'Book' | 'Opening' | 'Defense' | 'Variation';

export const openingKind = (line: OpeningLine | null | undefined): OpeningKind => {
  if (!line?.length) return 'Book';
  if (line.length === 1) return 'Opening';
  if (line.length === 2) return 'Defense';
  return 'Variation';
};

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

export const validateOpeningBookDocument = (
  book: unknown,
  expectedModeId: string,
): OpeningBookDocument => {
  if (!book || typeof book !== 'object') throw new Error('Paste an opening-book JSON object.');
  const candidate = book as Partial<OpeningBookDocument>;
  if (candidate.format !== OPENING_BOOK_FORMAT) {
    throw new Error(`Expected ${OPENING_BOOK_FORMAT}.`);
  }
  if (candidate.modeId !== expectedModeId) {
    throw new Error(`This is a ${candidate.modeId ?? 'mode-less'} book, not ${expectedModeId}.`);
  }
  if (!candidate.root || !Array.isArray(candidate.root.moves) || !Array.isArray(candidate.mainLine)) {
    throw new Error('The opening-book tree is incomplete.');
  }
  return candidate as OpeningBookDocument;
};
