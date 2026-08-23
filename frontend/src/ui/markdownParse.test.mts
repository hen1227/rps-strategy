// The Markdown renderer's pure parts.
//
// Run with `npm run test:markdown`. The rendering itself is checked by eye;
// what is pinned here are the two things that were wrong the first time, both
// of which show as raw markup on a page people are told to trust.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseBlocks,
  splitRow,
  tokenizeInline,
  type InlineToken,
  type MarkdownBlock,
} from './markdownParse';

/** The token at `index`, asserted to be of one kind so its fields are readable. */
const tokenAt = <Kind extends InlineToken['kind']>(
  tokens: InlineToken[],
  index: number,
  kind: Kind,
): Extract<InlineToken, { kind: Kind }> => {
  const token = tokens[index];
  assert.ok(token, `expected a token at ${index}`);
  assert.equal(token.kind, kind);
  return token as Extract<InlineToken, { kind: Kind }>;
};

const blockAt = <Kind extends MarkdownBlock['kind']>(
  blocks: MarkdownBlock[],
  index: number,
  kind: Kind,
): Extract<MarkdownBlock, { kind: Kind }> => {
  const block = blocks[index];
  assert.ok(block, `expected a block at ${index}`);
  assert.equal(block.kind, kind);
  return block as Extract<MarkdownBlock, { kind: Kind }>;
};

describe('inline', () => {
  it('renders code inside bold, which the guide relies on', () => {
    // `**`flush=True` matters.**` used to render with the backticks showing.
    const tokens = tokenizeInline('**`flush=True` matters.**');
    assert.equal(tokens.length, 1);
    const bold = tokenAt(tokens, 0, 'bold');
    assert.deepEqual(
      bold.children.map((child) => child.kind),
      ['code', 'text'],
    );
    assert.equal(tokenAt(bold.children, 0, 'code').text, 'flush=True');
  });

  it('reads code, bold, and links out of one line', () => {
    const kinds = tokenizeInline('see `go`, **now**, or [here](https://example.com)')
      .map((token) => token.kind);
    assert.deepEqual(kinds, ['text', 'code', 'text', 'bold', 'text', 'link']);
  });

  it('leaves plain text alone', () => {
    assert.deepEqual(tokenizeInline('nothing special here'), [
      { kind: 'text', text: 'nothing special here' },
    ]);
  });
});

describe('tables', () => {
  it('does not split a cell on an escaped pipe', () => {
    // The audit table in the guide has a cell full of them.
    const cells = splitRow("| `grep -nE 'eval\\|exec\\|pickle'` | nothing |");
    assert.deepEqual(cells, ["`grep -nE 'eval|exec|pickle'`", 'nothing']);
  });

  it('reads an ordinary row', () => {
    assert.deepEqual(splitRow('| rpsi | your identity |'), ['rpsi', 'your identity']);
  });
});

describe('blocks', () => {
  it('separates the shapes the documents use', () => {
    const blocks = parseBlocks(
      [
        '# Title',
        '',
        'A paragraph that',
        'wraps across lines.',
        '',
        '- one',
        '- two',
        '',
        '```',
        'code here',
        '```',
        '',
        '---',
        '',
        '| a | b |',
        '| --- | --- |',
        '| 1 | 2 |',
      ].join('\n'),
    );
    assert.deepEqual(
      blocks.map((block) => block.kind),
      ['heading', 'paragraph', 'list', 'code', 'rule', 'table'],
    );
    // A wrapped paragraph is one paragraph, not two.
    assert.equal(blockAt(blocks, 1, 'paragraph').text, 'A paragraph that wraps across lines.');
    assert.deepEqual(blockAt(blocks, 2, 'list').items, ['one', 'two']);
    assert.equal(blockAt(blocks, 3, 'code').text, 'code here');
    const table = blockAt(blocks, 5, 'table');
    assert.deepEqual(table.header, ['a', 'b']);
    assert.deepEqual(table.rows, [['1', '2']]);
  });

  it('does not mistake a fenced line for a heading or a rule', () => {
    const blocks = parseBlocks(['```', '# not a heading', '---', '```'].join('\n'));
    assert.equal(blocks.length, 1);
    assert.equal(blockAt(blocks, 0, 'code').text, '# not a heading\n---');
  });
});
