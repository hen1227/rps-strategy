// The opening book: an imported engine scan, plus the names people give its
// lines.
//
// The scan itself is produced offline and published by an admin from a shell;
// this module only reads it. The naming rules are the interesting part, and
// they are two: a hierarchy borrowed wholesale from chess — see `titleFor` —
// and the fact that half the book is the other half seen in a mirror, which
// chess has no equivalent of. See `canonicalOpeningLine`.

/** A line of play, as move notation, from the opening position. */
export type OpeningLine = string[];

/** A named line, as published by a curator. */
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

export const lineKey = (line: OpeningLine) => line.join(' ');

// ---------------------------------------------------------------------------
// Mirror-image lines
// ---------------------------------------------------------------------------
//
// Reversing files — a↔i, b↔h, c↔g, d↔f, e alone — maps every legal move onto a
// legal move and every position onto an equivalent one, for a mode whose
// opening layout reads the same right to left. So `d8-c7` and `f8-g7` are one
// opening drawn twice, and the book contains both, because both are boards you
// can reach.
//
// Naming has to fold them back together, or the same opening is named twice
// and the two names drift. Of a line and its mirror, the one that sorts first
// is the key both are stored under, on the server as well — which is why this
// has to agree with `opening_mirror.go` exactly.

const MIRRORED_FILES: Record<string, string> = {
  a: 'i',
  b: 'h',
  c: 'g',
  d: 'f',
  e: 'e',
  f: 'd',
  g: 'c',
  h: 'b',
  i: 'a',
};

const mirrorSquare = (square: string) => (MIRRORED_FILES[square[0]] ?? square[0]) + square.slice(1);

/** `d8-c7` becomes `f8-g7`. Notation this cannot read is left alone. */
export const mirrorOpeningMove = (move: string): string => {
  const [from, to] = move.split('-');
  if (!from || !to) return move;
  return `${mirrorSquare(from)}-${mirrorSquare(to)}`;
};

export const mirrorOpeningLine = (line: OpeningLine): OpeningLine => line.map(mirrorOpeningMove);

/**
 * The key a line's name is stored under.
 *
 * The whole line mirrors or none of it does. Mirroring move by move — taking
 * whichever of `d8-c7` and `f8-g7` sorts first at every ply — would produce a
 * key that is not a line anybody can play, and two real lines could collide
 * on it.
 *
 * Every prefix of a canonical line is itself canonical, because the comparison
 * turns on the first move that differs from its own mirror and every longer
 * prefix contains it. That is what lets the hierarchy below walk prefixes.
 */
export const canonicalOpeningLine = (line: OpeningLine, mirrors: boolean): OpeningLine => {
  if (!mirrors || line.length === 0) return line;
  const mirrored = mirrorOpeningLine(line);
  return lineKey(mirrored) < lineKey(line) ? mirrored : line;
};

// ---------------------------------------------------------------------------
// What a line is called
// ---------------------------------------------------------------------------

/** What a line is called, and whether anybody has actually named it. */
export interface OpeningTitle {
  exact: boolean;
  inherited: boolean;
  label: string;
  namedAncestor: OpeningName | null;
  suggestionNeeded: boolean;
}

/** Every name proposed for one line, with the context a curator needs. */
export interface OpeningSuggestionGroup {
  /** The canonical line, so two mirrored proposals are one group. */
  line: OpeningLine;
  suggestions: OpeningNameSuggestion[];
  /** The nearest named ancestor, which is what this line would hang under. */
  ancestor: OpeningName | null;
  /**
   * True when the line one move shorter has no published name.
   *
   * Naming out of order is the thing that makes a book read strangely: a
   * variation published under an opening nobody has named yet inherits
   * nothing, and looks — to whoever suggested the shallower name — as though
   * their suggestion was thrown away. The queue surfaces this rather than
   * silently sorting around it.
   */
  parentUnnamed: boolean;
}

/** The naming layer of one book, indexed once and asked many times. */
export interface OpeningNaming {
  /** Whether this mode's lines have mirror twins at all. */
  mirrors: boolean;
  canonical: (line: OpeningLine) => OpeningLine;
  /** The other line that shares this one's name, or null when it is its own. */
  mirrorOf: (line: OpeningLine) => OpeningLine | null;
  /** The published name for this exact line, mirror included. */
  nameFor: (line: OpeningLine) => OpeningName | null;
  titleFor: (line: OpeningLine) => OpeningTitle;
  /** Everything people have proposed for this exact line, oldest first. */
  suggestionsFor: (line: OpeningLine) => OpeningNameSuggestion[];
  /** Every line still waiting for a name, shallowest first. */
  queue: OpeningSuggestionGroup[];
  namedCount: number;
  pendingCount: number;
}

/**
 * What the index is built from -- which is exactly what the bootstrap carries,
 * field for field, so a screen hands it the book it already has rather than
 * three fields it has to remember to keep in step.
 */
export interface OpeningNamingInput {
  names?: OpeningName[] | null;
  suggestions?: OpeningNameSuggestion[] | null;
  /** True when this mode folds mirror-image lines onto one name. */
  mirrorNaming?: boolean;
}

/**
 * Index a book's names and open proposals.
 *
 * Every screen that shows a line — the hero, twenty move cards, the curator's
 * queue — asks the same three questions about it, so they are answered from
 * one pair of maps built once, rather than by re-scanning the name list per
 * card as this used to.
 */
export const openingNaming = ({
  names,
  suggestions,
  mirrorNaming: mirrors = false,
}: OpeningNamingInput): OpeningNaming => {
  const canonical = (line: OpeningLine) => canonicalOpeningLine(line ?? [], mirrors);
  const keyOf = (line: OpeningLine | null | undefined) => lineKey(canonical(line ?? []));

  const byLine = new Map<string, OpeningName>();
  for (const opening of names ?? []) byLine.set(keyOf(opening.line), opening);

  const proposals = new Map<string, OpeningNameSuggestion[]>();
  for (const suggestion of suggestions ?? []) {
    const key = keyOf(suggestion.line);
    const group = proposals.get(key);
    if (group) group.push(suggestion);
    else proposals.set(key, [suggestion]);
  }
  // Oldest first, everywhere it is read. Part of a proposal's standing is that
  // somebody said it first, and a list that reorders itself as names arrive is
  // a list a curator has to re-read.
  for (const group of proposals.values()) {
    group.sort((first, second) => first.createdAtUnixMs - second.createdAtUnixMs);
  }

  const nameFor = (line: OpeningLine) => byLine.get(keyOf(line)) ?? null;
  const suggestionsFor = (line: OpeningLine) => proposals.get(keyOf(line)) ?? [];

  // Chess names form a hierarchy: a named opening acquires defenses and
  // variations below it without inventing a brand-new family name each time.
  // Exact human names always win. Otherwise the nearest named ancestor lends
  // its name to the last move, which keeps every branch readable while leaving
  // room for somebody to give it a better one.
  const ancestorOf = (line: OpeningLine): OpeningName | null => {
    const folded = canonical(line);
    for (let length = folded.length - 1; length > 0; length -= 1) {
      const ancestor = byLine.get(lineKey(folded.slice(0, length)));
      if (ancestor) return ancestor;
    }
    return null;
  };

  const titleFor = (line: OpeningLine | null | undefined): OpeningTitle => {
    if (!line?.length) {
      return {
        exact: false,
        inherited: false,
        label: 'The Opening Book',
        namedAncestor: null,
        suggestionNeeded: false,
      };
    }
    const exact = nameFor(line);
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
    const ancestor = ancestorOf(line);
    if (ancestor) {
      return {
        exact: false,
        inherited: true,
        label: `${ancestor.name}: ${lastMove}`,
        namedAncestor: ancestor,
        suggestionNeeded: true,
      };
    }
    return {
      exact: false,
      inherited: false,
      label: `Suggest a name · ${lastMove}`,
      namedAncestor: null,
      suggestionNeeded: true,
    };
  };

  // Shallowest first, which is the order a book wants to be named in: an
  // opening, then its defenses, then their variations.
  const queue: OpeningSuggestionGroup[] = [...proposals.entries()]
    .map(([key, group]) => {
      const line = group[0]?.line ?? (key ? key.split(' ') : []);
      return {
        line: canonical(line),
        suggestions: group,
        ancestor: ancestorOf(line),
        parentUnnamed: line.length > 1 && !nameFor(line.slice(0, -1)),
      };
    })
    .sort(
      (first, second) =>
        first.line.length - second.line.length || lineKey(first.line).localeCompare(lineKey(second.line)),
    );

  return {
    mirrors,
    canonical,
    mirrorOf: (line) => {
      if (!mirrors || !line?.length) return null;
      const mirrored = mirrorOpeningLine(line);
      return lineKey(mirrored) === lineKey(line) ? null : mirrored;
    },
    nameFor,
    titleFor,
    suggestionsFor,
    queue,
    namedCount: byLine.size,
    pendingCount: suggestions?.length ?? 0,
  };
};

// ---------------------------------------------------------------------------
// The opening a game is playing
// ---------------------------------------------------------------------------

/**
 * How far into a game the opening runs.
 *
 * The book itself goes fifty plies deep, because a scan is a search tree and a
 * search tree is worth having deep. Names are not: nobody calls the twentieth
 * move of a game an opening, and asking a player to name one would be asking
 * them to name a position rather than an idea. Past this the board says
 * nothing, which is the honest answer.
 */
export const OPENING_PLIES = 12;

/** What a game in progress is playing, as far as the book is concerned. */
export interface GameOpening {
  /**
   * The line the title describes: the deepest named prefix of the game, or —
   * when nothing along it is named — the first move, which is where a book
   * starts naming and where a reader would look for this opening.
   */
  line: OpeningLine;
  /** The published name covering `line`, or null when nobody has given one. */
  name: OpeningName | null;
  title: OpeningTitle;
  /**
   * The shallowest prefix with no published name: the line worth naming next,
   * and the one a "name this" prompt should open. Null when every ply within
   * the opening already has a name.
   *
   * Shallowest rather than deepest on purpose. Naming out of order is the one
   * thing that makes a book read strangely afterwards — a variation published
   * under an opening nobody has named inherits nothing — so the line a game
   * offers up is the one its own naming hierarchy wants first.
   */
  wants: OpeningLine | null;
}

/**
 * What to call the opening of a game that has been played this far.
 *
 * One walk, two questions, because a game asks both at once and they have
 * different answers: what this opening is *called* is the deepest name anybody
 * has published along the line, and what still *wants* a name is the shallowest
 * ply that has none. A game deep in a named opening is both — "Skipping Stone",
 * and a fourth move nobody has titled yet.
 */
export const openingOfGame = (
  naming: OpeningNaming,
  played: OpeningLine | null | undefined,
  plies = OPENING_PLIES,
): GameOpening | null => {
  const line = (played ?? []).slice(0, Math.max(0, plies));
  if (line.length === 0) return null;

  let name: OpeningName | null = null;
  let named: OpeningLine | null = null;
  let wants: OpeningLine | null = null;
  for (let length = 1; length <= line.length; length += 1) {
    const prefix = line.slice(0, length);
    const published = naming.nameFor(prefix);
    if (published) {
      name = published;
      named = prefix;
    } else if (!wants) wants = prefix;
  }

  // One of the two always exists: every prefix is named, or one of them is the
  // first that is not. The line itself is the answer to neither, and is here
  // only so this cannot return something that is not a line.
  const subject = named ?? wants ?? line;
  return { line: subject, name, title: naming.titleFor(subject), wants };
};

export type OpeningKind = 'Book' | 'Opening' | 'Defense' | 'Variation';

export const openingKind = (line: OpeningLine | null | undefined): OpeningKind => {
  if (!line?.length) return 'Book';
  if (line.length === 1) return 'Opening';
  if (line.length === 2) return 'Defense';
  return 'Variation';
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
  /** Every name people have put forward and nobody has published yet. */
  suggestions: OpeningNameSuggestion[];
  /** Whether this mode's lines share their names with their mirrors. */
  mirrorNaming?: boolean;
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

// ---------------------------------------------------------------------------
// Keeping the page in step
// ---------------------------------------------------------------------------
//
// Naming a line changes two things at once: the name, and the proposals that
// were waiting for it. The server does both in one transaction, and these do
// the same to the copy already on screen -- so a curator watches the queue
// shorten as they work rather than after a reload, and never sees the state
// the server has already left behind.

const matchesLine = (book: OpeningBookBootstrap, line: OpeningLine) => {
  const wanted = lineKey(canonicalOpeningLine(line ?? [], Boolean(book.mirrorNaming)));
  return (candidate: OpeningLine | null | undefined) =>
    lineKey(canonicalOpeningLine(candidate ?? [], Boolean(book.mirrorNaming))) === wanted;
};

/** A published name folded in, replacing any name for the same line. */
export const withPublishedName = (
  book: OpeningBookBootstrap,
  published: OpeningName,
): OpeningBookBootstrap => {
  const isTheLine = matchesLine(book, published.line);
  return {
    ...book,
    names: [...book.names.filter((name) => !isTheLine(name.line)), published],
    // Publishing a name answers every proposal for that line, which is exactly
    // what the server has just done to them.
    suggestions: book.suggestions.filter((suggestion) => !isTheLine(suggestion.line)),
  };
};

/** A name taken back off a line, leaving it unnamed. */
export const withoutOpeningName = (
  book: OpeningBookBootstrap,
  line: OpeningLine,
): OpeningBookBootstrap => {
  const isTheLine = matchesLine(book, line);
  return { ...book, names: book.names.filter((name) => !isTheLine(name.line)) };
};

/** Somebody's new proposal, so they can see it land. */
export const withSuggestion = (
  book: OpeningBookBootstrap,
  suggestion: OpeningNameSuggestion,
): OpeningBookBootstrap => ({
  ...book,
  suggestions: [
    ...book.suggestions.filter((candidate) => candidate.suggestionId !== suggestion.suggestionId),
    suggestion,
  ],
});

/** One proposal turned down. */
export const withoutSuggestion = (
  book: OpeningBookBootstrap,
  suggestionId: number,
): OpeningBookBootstrap => ({
  ...book,
  suggestions: book.suggestions.filter((candidate) => candidate.suggestionId !== suggestionId),
});
