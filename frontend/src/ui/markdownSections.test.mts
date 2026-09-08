// Slicing the shipped documents.
//
// What is pinned here is the reason this module is not three lines of regex:
// the guide's example engine starts with a shebang inside a fence, and a naive
// scan reads that as a heading and hands the page half a section.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { docSections, findSection, sectionId, sectionSource } from './markdownSections';

const DOCUMENT = [
  '# Connect your bot',
  '',
  'An opening paragraph.',
  '',
  '## 2. What your bot has to do',
  '',
  'Read lines on stdin.',
  '',
  '| You receive | You reply |',
  '| --- | --- |',
  '| `rpsi` | `rpsiok` |',
  '',
  '### Reading a `go` line',
  '',
  'That one line matters.',
  '',
  '```python',
  '#!/usr/bin/env python3',
  '# not a heading either',
  'print("bestmove d7-d6")',
  '```',
  '',
  '## 3. Getting connected',
  '',
  'Run the client.',
  '',
  '---',
].join('\n');

describe('docSections', () => {
  it('keeps subheadings inside their section by default', () => {
    const sections = docSections(DOCUMENT);
    assert.deepEqual(
      sections.map((section) => section.title),
      ['Connect your bot', '2. What your bot has to do', '3. Getting connected'],
    );
    assert.match(sections[1]!.body, /Reading a/);
  });

  it('breaks subheadings out when asked for them', () => {
    const titles = docSections(DOCUMENT, 3).map((section) => section.title);
    assert.deepEqual(titles, [
      'Connect your bot',
      '2. What your bot has to do',
      'Reading a `go` line',
      '3. Getting connected',
    ]);
  });

  it('ignores hashes inside a fence', () => {
    // The shebang and the comment in the example engine are code, and a scan
    // that reads them as headings splits the guide in the middle of a snippet.
    const code = findSection(docSections(DOCUMENT, 3), /go. line/);
    assert.ok(code);
    assert.match(code.body, /#!\/usr\/bin\/env python3/);
    assert.match(code.body, /# not a heading either/);
  });

  it('carries the levels and anchors the pages address sections by', () => {
    const sections = docSections(DOCUMENT);
    assert.equal(sections[0]!.level, 1);
    assert.equal(sections[1]!.level, 2);
    assert.equal(sections[1]!.id, '2-what-your-bot-has-to-do');
    assert.equal(sectionId('Reading a `go` line'), 'reading-a-go-line');
  });

  it('drops the rule that separated a section from the next one', () => {
    // These documents rule off between sections, and each section is rendered
    // into a card of its own — where a trailing rule is a line under nothing.
    const last = docSections(DOCUMENT).at(-1);
    assert.equal(last?.body, 'Run the client.');
  });

  it('gives a section back as markdown, and nothing for a missing one', () => {
    const found = findSection(docSections(DOCUMENT), /getting connected/i);
    assert.equal(sectionSource(found), '## 3. Getting connected\n\nRun the client.');
    assert.equal(findSection(docSections(DOCUMENT), /nothing like this/), null);
    assert.equal(sectionSource(null), null);
  });

  it('says nothing about an empty document rather than throwing', () => {
    assert.deepEqual(docSections(null), []);
    assert.deepEqual(docSections(''), []);
  });
});
