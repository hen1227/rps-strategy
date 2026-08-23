export const OPENING_BOOK_FORMAT = 'rps-opening-book/v1';

export const lineKey = (line) => line.join(' ');

const nameMap = (names) =>
  new Map((names ?? []).map((opening) => [lineKey(opening.line ?? []), opening]));

// Chess names form a hierarchy: a named opening can acquire defenses and
// variations below it without inventing a brand-new family name each time.
// Exact human names always win. Otherwise the nearest named ancestor lends
// its name to the last move, which keeps every branch readable while leaving
// room for someone to give it a better name later.
export const openingNameForLine = (names, line) => {
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

  for (let length = line.length - 1; length > 0; length -= 1) {
    const ancestor = byLine.get(lineKey(line.slice(0, length)));
    if (ancestor) {
      return {
        exact: false,
        inherited: true,
        label: `${ancestor.name}: ${line[line.length - 1]}`,
        namedAncestor: ancestor,
        suggestionNeeded: true,
      };
    }
  }

  return {
    exact: false,
    inherited: false,
    label: `Suggest a name · ${line[line.length - 1]}`,
    namedAncestor: null,
    suggestionNeeded: true,
  };
};

export const openingKind = (line) => {
  if (!line?.length) return 'Book';
  if (line.length === 1) return 'Opening';
  if (line.length === 2) return 'Defense';
  return 'Variation';
};

export const nodeAtLine = (root, line) => {
  let node = root ?? null;
  for (const notation of line ?? []) {
    const edge = node?.moves?.find((candidate) => candidate.move === notation);
    if (!edge) return null;
    node = edge.child;
  }
  return node;
};

export const exactOpeningName = (names, line) =>
  (names ?? []).find((opening) => lineKey(opening.line ?? []) === lineKey(line ?? [])) ?? null;

export const validateOpeningBookDocument = (book, expectedModeId) => {
  if (!book || typeof book !== 'object') throw new Error('Paste an opening-book JSON object.');
  if (book.format !== OPENING_BOOK_FORMAT) {
    throw new Error(`Expected ${OPENING_BOOK_FORMAT}.`);
  }
  if (book.modeId !== expectedModeId) {
    throw new Error(`This is a ${book.modeId ?? 'mode-less'} book, not ${expectedModeId}.`);
  }
  if (!book.root || !Array.isArray(book.root.moves) || !Array.isArray(book.mainLine)) {
    throw new Error('The opening-book tree is incomplete.');
  }
  return book;
};
