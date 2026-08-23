// Parsing for the Markdown renderer, kept apart from the rendering.
//
// Two reasons. The rules here — what counts as a table cell, what nests
// inside bold — are the part that has been wrong before and is worth
// testing, and a module with no JSX in it can be tested by plain Node
// without a transform. `Markdown.tsx` turns these into views.

/** A run of text with one kind of formatting on it. */
export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'bold'; children: InlineToken[] };

/** A laid-out region of a document. */
export type MarkdownBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' };

const INLINE = /(`[^`]+`|\*\*.+?\*\*|\[[^\]]+\]\([^)]+\))/g;

/**
 * Inline code, bold, and links.
 *
 * Bold recurses, because the documents write things like
 * `**\`flush=True\` matters**` and rendering that with the backticks still in
 * it makes the page look like it was never read by anybody.
 */
export function tokenizeInline(text: string): InlineToken[] {
  return String(text)
    .split(INLINE)
    .filter((piece) => piece !== '')
    .map((piece) => {
      if (piece.startsWith('`') && piece.endsWith('`')) {
        return { kind: 'code', text: piece.slice(1, -1) };
      }
      if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4) {
        return { kind: 'bold', children: tokenizeInline(piece.slice(2, -2)) };
      }
      const link = piece.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        return { kind: 'link', text: link[1] ?? '', href: link[2] ?? '' };
      }
      return { kind: 'text', text: piece };
    });
}

export const splitRow = (line: string): string[] => {
  const cells: string[] = [];
  let cell = '';
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '\\' && body[index + 1] === '|') {
      cell += '|';
      index += 1;
      continue;
    }
    if (body[index] === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += body[index];
  }
  cells.push(cell.trim());
  return cells;
};

const isDivider = (line: string) =>
  /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');

/** Group the source into blocks the renderer can lay out. */
export function parseBlocks(source: string | null | undefined): MarkdownBlock[] {
  const lines = String(source ?? '').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  // Every read of `lines` past the loop head goes through this, so the walk
  // reads a line that is not there as an empty one rather than crashing.
  const at = (offset: number) => lines[offset] ?? '';

  while (index < lines.length) {
    const line = at(index);

    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith('```')) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !at(index).startsWith('```')) {
        body.push(at(index));
        index += 1;
      }
      index += 1;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (/^-{3,}$/.test(line.trim())) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] ?? '').length,
        text: heading[2] ?? '',
      });
      index += 1;
      continue;
    }
    if (line.trim().startsWith('|') && isDivider(at(index + 1))) {
      const header = splitRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && at(index).trim().startsWith('|')) {
        rows.push(splitRow(at(index)));
        index += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*([-*]|\d+\.)\s+/.test(at(index))) {
        let text = at(index).replace(/^\s*([-*]|\d+\.)\s+/, '');
        index += 1;
        // A wrapped list item continues on an indented line with no marker.
        while (
          index < lines.length &&
          at(index).trim() &&
          /^\s{2,}\S/.test(at(index)) &&
          !/^\s*([-*]|\d+\.)\s+/.test(at(index))
        ) {
          text += ` ${at(index).trim()}`;
          index += 1;
        }
        items.push(text);
      }
      blocks.push({ kind: 'list', items });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      at(index).trim() &&
      !at(index).startsWith('```') &&
      !at(index).startsWith('#') &&
      !at(index).trim().startsWith('|') &&
      !/^\s*([-*]|\d+\.)\s+/.test(at(index)) &&
      !/^-{3,}$/.test(at(index).trim())
    ) {
      paragraph.push(at(index).trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }
  return blocks;
}
