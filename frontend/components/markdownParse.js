// Parsing for the Markdown renderer, kept apart from the rendering.
//
// Two reasons. The rules here — what counts as a table cell, what nests
// inside bold — are the part that has been wrong before and is worth
// testing, and a module with no JSX in it can be tested by plain Node
// without a transform. `Markdown.js` turns these into views.

const INLINE = /(`[^`]+`|\*\*.+?\*\*|\[[^\]]+\]\([^)]+\))/g;

/**
 * Inline code, bold, and links.
 *
 * Bold recurses, because the documents write things like
 * `**\`flush=True\` matters**` and rendering that with the backticks still in
 * it makes the page look like it was never read by anybody.
 */
export function tokenizeInline(text) {
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
        return { kind: 'link', text: link[1], href: link[2] };
      }
      return { kind: 'text', text: piece };
    });
}

export const splitRow = (line) => {
  const cells = [];
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

const isDivider = (line) => /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');

/** Group the source into blocks the renderer can lay out. */
export function parseBlocks(source) {
  const lines = String(source ?? '').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith('```')) {
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        body.push(lines[index]);
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
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }
    if (line.trim().startsWith('|') && isDivider(lines[index + 1] ?? '')) {
      const header = splitRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[index])) {
        let text = lines[index].replace(/^\s*([-*]|\d+\.)\s+/, '');
        index += 1;
        // A wrapped list item continues on an indented line with no marker.
        while (
          index < lines.length &&
          lines[index].trim() &&
          /^\s{2,}\S/.test(lines[index]) &&
          !/^\s*([-*]|\d+\.)\s+/.test(lines[index])
        ) {
          text += ` ${lines[index].trim()}`;
          index += 1;
        }
        items.push(text);
      }
      blocks.push({ kind: 'list', items });
      continue;
    }

    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith('```') &&
      !lines[index].startsWith('#') &&
      !lines[index].trim().startsWith('|') &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[index]) &&
      !/^-{3,}$/.test(lines[index].trim())
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }
  return blocks;
}
