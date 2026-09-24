// Tests for the CLA check, against a fake of the part of GitHub's API it uses.
//
//   node --test .github/cla/cla.test.cjs
//
// The fake holds the state a real repository would (commits, comments, the
// signatures branch, workflow runs), so each test reads as what a contributor
// would see happen, not as a list of calls.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cla = require('./cla.cjs');

const OWNER = { id: 1, login: 'hen1227', type: 'User' };
const ALICE = { id: 101, login: 'alice', type: 'User' };
const BOB = { id: 102, login: 'bob', type: 'User' };
const DEPENDABOT = { id: 49699333, login: 'dependabot[bot]', type: 'Bot' };
const ACTIONS_BOT = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

function fakeRepository({ commits = [], comments = [], signatures = null, runs = [] } = {}) {
  let nextId = 5000;
  let nextSha = 1;
  const state = {
    commits,
    comments: comments.map((comment, index) => ({ id: 1000 + index, ...comment })),
    branch: signatures === null ? null : { file: { sha: 'sha-0', text: JSON.stringify({ signatures }) } },
    runs,
    reruns: [],
    created: [],
    pullLookups: 0,
    conflictsLeft: 0,
    orphanParents: undefined,
  };
  const rest = {
    pulls: {
      listCommits: async () => ({ data: state.commits }),
      get: async ({ pull_number }) => {
        state.pullLookups += 1;
        return { data: { number: pull_number, head: { sha: 'head-sha' } } };
      },
    },
    issues: {
      listComments: async () => ({ data: state.comments }),
      createComment: async ({ body }) => {
        const comment = { id: nextId++, user: ACTIONS_BOT, body };
        state.comments.push(comment);
        state.created.push(comment);
        return { data: comment };
      },
      updateComment: async ({ comment_id, body }) => {
        const comment = state.comments.find((entry) => entry.id === comment_id);
        comment.body = body;
        return { data: comment };
      },
    },
    repos: {
      getContent: async ({ path: file, ref }) => {
        if (ref !== cla.BRANCH || file !== cla.FILE || !state.branch?.file) throw httpError(404);
        const { sha, text } = state.branch.file;
        return { data: { sha, content: Buffer.from(text).toString('base64') } };
      },
      getBranch: async () => {
        if (!state.branch) throw httpError(404);
        return { data: {} };
      },
      createOrUpdateFileContents: async ({ branch, content, sha }) => {
        assert.equal(branch, cla.BRANCH);
        if (state.conflictsLeft > 0) {
          state.conflictsLeft -= 1;
          throw httpError(409);
        }
        if (state.branch.file?.sha !== sha) throw httpError(409);
        state.branch.file = { sha: `sha-${nextSha++}`, text: Buffer.from(content, 'base64').toString('utf8') };
        return { data: {} };
      },
    },
    git: {
      createTree: async ({ tree }) => {
        state.pendingTree = tree;
        return { data: { sha: 'tree-1' } };
      },
      createCommit: async ({ parents }) => {
        state.orphanParents = parents;
        return { data: { sha: 'commit-1' } };
      },
      createRef: async ({ ref }) => {
        assert.equal(ref, `refs/heads/${cla.BRANCH}`);
        state.branch = { file: { sha: `sha-${nextSha++}`, text: state.pendingTree[0].content } };
        return { data: {} };
      },
    },
    actions: {
      listWorkflowRuns: async ({ event, head_sha }) => ({
        data: { workflow_runs: state.runs.filter((run) => run.event === event && run.head_sha === head_sha) },
      }),
      reRunWorkflow: async ({ run_id }) => {
        state.reruns.push(run_id);
        return { data: {} };
      },
    },
  };
  const github = { rest, paginate: async (method, params) => (await method(params)).data };
  const recorded = () => (state.branch?.file ? JSON.parse(state.branch.file.text).signatures : []);
  const checkComments = () => state.comments.filter((comment) => String(comment.body).includes(cla.MARKER));
  return { github, state, recorded, checkComments };
}

const commitBy = (person, sha = 'abcdef1234567890') => ({
  sha,
  author: person,
  commit: { author: { name: person ? person.login : 'Somebody', email: 'somebody@example.com' } },
});

function fakeCore() {
  const core = { failed: null, infos: [], warnings: [] };
  core.setFailed = (message) => { core.failed = message; };
  core.info = (message) => core.infos.push(message);
  core.warning = (message) => core.warnings.push(message);
  return core;
}

const REPO = { owner: 'hen1227', repo: 'rps-strategy' };
const pullRequestEvent = (number = 7) => ({
  eventName: 'pull_request_target',
  repo: REPO,
  payload: { repository: { default_branch: 'main' }, pull_request: { number, head: { sha: 'head-sha' } } },
});
const commentEvent = (user, body, number = 7) => ({
  eventName: 'issue_comment',
  repo: REPO,
  payload: {
    repository: { default_branch: 'main' },
    issue: { number, pull_request: {} },
    comment: {
      user,
      body,
      created_at: '2026-09-24T12:00:00Z',
      html_url: `https://github.com/hen1227/rps-strategy/pull/${number}#issuecomment-1`,
    },
  },
});
const prRun = { id: 9, event: 'pull_request_target', head_sha: 'head-sha', created_at: '2026-09-24T11:00:00Z' };

test("the owner's own pull request passes without a comment", async () => {
  const repo = fakeRepository({ commits: [commitBy(OWNER)] });
  const core = fakeCore();
  await cla.run({ github: repo.github, context: pullRequestEvent(), core });
  assert.equal(core.failed, null);
  assert.equal(repo.state.created.length, 0);
});

test("a bot's pull request passes", async () => {
  const repo = fakeRepository({ commits: [commitBy(DEPENDABOT)] });
  const core = fakeCore();
  await cla.run({ github: repo.github, context: pullRequestEvent(), core });
  assert.equal(core.failed, null);
});

test('an unsigned contributor fails the check and is asked once, however often it runs', async () => {
  const repo = fakeRepository({ commits: [commitBy(ALICE, 'a1'), commitBy(ALICE, 'a2'), commitBy(OWNER, 'o1')] });
  for (let pass = 0; pass < 2; pass += 1) {
    const core = fakeCore();
    await cla.run({ github: repo.github, context: pullRequestEvent(), core });
    assert.match(core.failed, /@alice/);
    assert.doesNotMatch(core.failed, /hen1227/);
  }
  const [comment, ...others] = repo.checkComments();
  assert.equal(others.length, 0);
  assert.ok(comment.body.includes(`> ${cla.SENTENCE}`));
  assert.equal(comment.body.match(/@alice/g).length, 1);
});

test('signing starts the record on a branch of its own and re-runs the check', async () => {
  const repo = fakeRepository({ commits: [commitBy(ALICE)], runs: [prRun] });
  const core = fakeCore();
  await cla.run({ github: repo.github, context: commentEvent(ALICE, cla.SENTENCE), core });
  assert.equal(core.failed, null);
  assert.deepEqual(repo.state.orphanParents, []);
  const [entry, ...rest] = repo.recorded();
  assert.equal(rest.length, 0);
  assert.equal(entry.version, cla.CLA_VERSION);
  assert.equal(entry.id, ALICE.id);
  assert.equal(entry.login, 'alice');
  assert.equal(entry.pullRequest, 7);
  assert.match(entry.comment, /#issuecomment-1$/);
  assert.deepEqual(repo.state.reruns, [prRun.id]);
});

test('once signed, the check passes and its comment says so', async () => {
  const repo = fakeRepository({
    commits: [commitBy(ALICE)],
    signatures: [{ version: cla.CLA_VERSION, id: ALICE.id, login: 'alice' }],
    comments: [{ user: ACTIONS_BOT, body: `${cla.MARKER}\nStill to sign: @alice.` }],
  });
  const core = fakeCore();
  await cla.run({ github: repo.github, context: pullRequestEvent(), core });
  assert.equal(core.failed, null);
  const [comment] = repo.checkComments();
  assert.match(comment.body, /has signed/);
  assert.equal(repo.state.created.length, 0);
});

test('a signature of an older version does not count', async () => {
  const repo = fakeRepository({
    commits: [commitBy(ALICE)],
    signatures: [{ version: '0.9', id: ALICE.id, login: 'alice' }],
  });
  const core = fakeCore();
  await cla.run({ github: repo.github, context: pullRequestEvent(), core });
  assert.match(core.failed, /@alice/);
});

test("nobody can sign for somebody else's commits", async () => {
  const repo = fakeRepository({
    commits: [commitBy(ALICE)],
    comments: [{ user: BOB, body: cla.SENTENCE, created_at: '2026-09-24T12:00:00Z', html_url: 'x' }],
    runs: [prRun],
  });
  const onComment = fakeCore();
  await cla.run({ github: repo.github, context: commentEvent(BOB, cla.SENTENCE), core: onComment });
  assert.deepEqual(repo.recorded(), []);
  assert.deepEqual(repo.state.reruns, []);
  const onPullRequest = fakeCore();
  await cla.run({ github: repo.github, context: pullRequestEvent(), core: onPullRequest });
  assert.match(onPullRequest.failed, /@alice/);
});

test('a signature posted while nothing was listening still counts', async () => {
  const repo = fakeRepository({
    commits: [commitBy(ALICE)],
    comments: [{ user: ALICE, body: `> ${cla.SENTENCE}`, created_at: '2026-09-20T09:00:00Z', html_url: 'https://example.test/c' }],
  });
  const core = fakeCore();
  await cla.run({ github: repo.github, context: pullRequestEvent(), core });
  assert.equal(core.failed, null);
  assert.equal(repo.recorded()[0].id, ALICE.id);
  assert.equal(repo.recorded()[0].signedAt, '2026-09-20T09:00:00Z');
});

test('a commit nobody can sign for fails, and its email stays off the pull request', async () => {
  const repo = fakeRepository({ commits: [commitBy(null, '1234567deadbeef')] });
  const core = fakeCore();
  await cla.run({ github: repo.github, context: pullRequestEvent(), core });
  assert.match(core.failed, /1234567/);
  const [comment] = repo.checkComments();
  assert.match(comment.body, /`1234567` \(Somebody\)/);
  assert.doesNotMatch(comment.body, /example\.com/);
});

test('a comment that is not a signature does nothing', async () => {
  const repo = fakeRepository({ commits: [commitBy(ALICE)], runs: [prRun] });
  const core = fakeCore();
  await cla.run({ github: repo.github, context: commentEvent(ALICE, 'Looks good to me.'), core });
  assert.equal(repo.state.pullLookups, 0);
  assert.deepEqual(repo.recorded(), []);
});

test('a write that loses a race to another signature tries again', async () => {
  const repo = fakeRepository({
    commits: [commitBy(ALICE)],
    signatures: [{ version: cla.CLA_VERSION, id: BOB.id, login: 'bob' }],
    runs: [prRun],
  });
  repo.state.conflictsLeft = 1;
  await cla.run({ github: repo.github, context: commentEvent(ALICE, cla.SENTENCE), core: fakeCore() });
  assert.deepEqual(repo.recorded().map((entry) => entry.login), ['bob', 'alice']);
});

test('when the check cannot re-run itself, the signer is told how to update it', async () => {
  const repo = fakeRepository({ commits: [commitBy(ALICE)], runs: [] });
  await cla.run({ github: repo.github, context: commentEvent(ALICE, cla.SENTENCE), core: fakeCore() });
  assert.equal(repo.recorded()[0].id, ALICE.id);
  const [comment] = repo.checkComments();
  assert.match(comment.body, /push any commit/);
});

test('a signature forgives case, spacing, quoting and the full stop, but not a paraphrase', () => {
  const accepted = [
    cla.SENTENCE,
    `> ${cla.SENTENCE}`,
    `  ${cla.SENTENCE.toUpperCase()}  `,
    cla.SENTENCE.replace(/\.$/, ''),
    cla.SENTENCE.replace(/ /g, '   '),
    `Happy to.\n\n${cla.SENTENCE}\n`,
  ];
  for (const body of accepted) assert.ok(cla.isSignature(body), body);
  const rejected = [
    'I agree to the CLA.',
    cla.SENTENCE.replace(cla.CLA_VERSION, '0.9'),
    cla.SENTENCE.replace('I have read', 'I have not read'),
    `${cla.SENTENCE} Except section 2.`,
    '',
    null,
  ];
  for (const body of rejected) assert.ok(!cla.isSignature(body), String(body));
});

test('CLA.md quotes the signing sentence and carries the version the check asks for', () => {
  const document = fs.readFileSync(path.join(__dirname, '..', '..', 'CLA.md'), 'utf8');
  assert.ok(document.includes(`> ${cla.SENTENCE}`), 'CLA.md must quote SENTENCE exactly');
  assert.ok(document.includes(`**Version ${cla.CLA_VERSION}**`), 'CLA.md must name CLA_VERSION');
});

test("the workflow's comment filter lets every signature through", () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'cla.yml'), 'utf8');
  const filter = workflow.match(/contains\(github\.event\.comment\.body, '([^']+)'\)/);
  assert.ok(filter, 'cla.yml should filter comments before starting a runner');
  // GitHub's `contains` ignores case, so compare the same way.
  assert.ok(cla.SENTENCE.toLowerCase().includes(filter[1].toLowerCase()));
});
