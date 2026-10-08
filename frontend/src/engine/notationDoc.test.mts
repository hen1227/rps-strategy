// The worked example on the Records and notation page, replayed by the app.
//
// `docs/notation.md` is what a reader checks their own parser against, so its
// example has to be a game that could have happened: the board its moves reach
// is the board its `FinalFEN` names. The backend pins the same record through
// `TestTheDocumentedRecordsReplay`; this pins the replay the review screen does.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { reviewSourceFromPGN } from '@/engine/gameReview';
import { encodePosition, parsePGN } from '@/engine/pgn';
import { ALL_TEST_MODES } from '@/testing/modes';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTATION = resolve(HERE, '../../../docs/notation.md');

/** The fenced block that holds a record: the one that opens with a tag pair. */
const documentedRecord = () => {
  const blocks = readFileSync(NOTATION, 'utf8').split('```');
  for (let index = 1; index < blocks.length; index += 2) {
    const body = (blocks[index] ?? '').slice((blocks[index] ?? '').indexOf('\n') + 1);
    if (body.startsWith('[Event ')) return body;
  }
  assert.fail('docs/notation.md has no fenced record');
};

test('the documented record replays to its own FinalFEN', () => {
  const pgn = documentedRecord();
  const source = reviewSourceFromPGN(pgn, ALL_TEST_MODES.slice());
  const final = source.positions[source.positions.length - 1];
  assert.ok(final, 'the record should replay to a position');
  assert.equal(
    encodePosition(final.grid, final.currentTurn),
    parsePGN(pgn).tag('FinalFEN'),
    'the board, side to move and territory its moves reach',
  );
});
