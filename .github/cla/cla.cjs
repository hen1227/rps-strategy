// The CLA check: has everyone who wrote a commit in this pull request signed?
//
// Run by `.github/workflows/cla.yml` through actions/github-script, which hands
// over an authenticated Octokit as `github`. Everything here goes through that
// client; nothing reads, checks out or runs the pull request's own files, which
// is what makes it safe to run on `pull_request_target`. Kept out of the
// workflow's YAML so it can be tested (`cla.test.cjs`) without GitHub.
//
// Signatures live in `signatures.json` on the `cla-signatures` branch: one
// entry per person per CLA version, keyed by the numeric account id, because a
// login can be renamed and the id cannot.

'use strict';

/** Bump with CLA.md. A signature of an older version does not count. */
const CLA_VERSION = '1.0';

/** What a contributor posts to sign. CLA.md quotes it; a test holds them together. */
const SENTENCE = `I have read the RPS Strategy CLA, version ${CLA_VERSION}, and I agree to it.`;

const BRANCH = 'cla-signatures';
const FILE = 'signatures.json';
const WORKFLOW = 'cla.yml';

/** Marks the check's own comment, so each pull request carries one and it is edited in place. */
const MARKER = '<!-- cla-check -->';

/** Not asked to sign: the Project Owner, whose project it is. Bots are exempt too; see `isExempt`. */
const OWNERS = new Set(['hen1227']);

/**
 * Whether a comment signs the CLA.
 *
 * One line of it has to be the sentence, word for word. Case, spacing and the
 * blockquote marker someone might copy from CLA.md are forgiven, and so is a
 * missing full stop. A paraphrase is not.
 */
function isSignature(body) {
  const target = normalise(SENTENCE);
  return String(body ?? '')
    .split(/\r?\n/)
    .some((line) => normalise(line.replace(/^\s*(?:>\s*)+/, '')) === target);
}

function normalise(text) {
  return text.trim().replace(/\s+/g, ' ').replace(/\.$/, '').toLowerCase();
}

/** Dependabot and the like: a version bump in a lock file is nobody's authorship. */
function isExempt(person) {
  return OWNERS.has(person.login) || person.type === 'Bot' || /\[bot\]$/.test(person.login);
}

/**
 * The people who wrote the pull request's commits.
 *
 * Authors rather than committers: somebody who rebased a branch wrote none of
 * it. A commit whose email is not linked to any GitHub account has nobody who
 * could sign for it, so it is reported rather than skipped.
 */
async function commitAuthors(github, repo, number) {
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    ...repo,
    pull_number: number,
    per_page: 100,
  });
  const people = new Map();
  const unlinked = [];
  for (const commit of commits) {
    if (commit.author && commit.author.id) {
      people.set(commit.author.id, {
        id: commit.author.id,
        login: commit.author.login,
        type: commit.author.type,
      });
    } else {
      unlinked.push({ sha: commit.sha, name: commit.commit?.author?.name ?? 'unknown' });
    }
  }
  return { people: [...people.values()], unlinked };
}

async function readSignatures(github, repo) {
  try {
    const { data } = await github.rest.repos.getContent({ ...repo, path: FILE, ref: BRANCH });
    const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { signatures: parsed.signatures ?? [], sha: data.sha };
  } catch (error) {
    if (error.status === 404) return { signatures: [], sha: null };
    throw error;
  }
}

function serialise(signatures) {
  const document = {
    about: 'Signatures of CLA.md, recorded by .github/workflows/cla.yml. One entry per person per CLA version.',
    signatures,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Adds signatures to the record, creating the branch the first time.
 *
 * The branch starts as a commit with no parents, so it carries nothing but the
 * record. Two pull requests can be signed at the same moment, so a write that
 * loses the race re-reads and tries again rather than overwriting the other.
 */
async function recordSignatures(github, repo, fresh) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { signatures, sha } = await readSignatures(github, repo);
    const known = new Set(signatures.map((entry) => `${entry.version}:${entry.id}`));
    const additions = fresh.filter((entry) => !known.has(`${entry.version}:${entry.id}`));
    if (additions.length === 0) return;
    const content = serialise([...signatures, ...additions]);
    const message = `Record the CLA signature of ${additions.map((entry) => `@${entry.login}`).join(', ')}`;
    try {
      if (sha === null && !(await branchExists(github, repo))) {
        const { data: tree } = await github.rest.git.createTree({
          ...repo,
          tree: [{ path: FILE, mode: '100644', type: 'blob', content }],
        });
        const { data: commit } = await github.rest.git.createCommit({
          ...repo,
          message,
          tree: tree.sha,
          parents: [],
        });
        await github.rest.git.createRef({ ...repo, ref: `refs/heads/${BRANCH}`, sha: commit.sha });
      } else {
        await github.rest.repos.createOrUpdateFileContents({
          ...repo,
          path: FILE,
          branch: BRANCH,
          message,
          content: Buffer.from(content, 'utf8').toString('base64'),
          ...(sha ? { sha } : {}),
        });
      }
      return;
    } catch (error) {
      // 409: the file moved under us. 422: the branch appeared under us.
      if (error.status !== 409 && error.status !== 422) throw error;
    }
  }
  throw new Error('Could not record the signature: the record kept changing underneath this run.');
}

async function branchExists(github, repo) {
  try {
    await github.rest.repos.getBranch({ ...repo, branch: BRANCH });
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

/** The check's comment on the pull request: what is missing, or that nothing is. */
function commentBody({ unsigned, unlinked, claURL }) {
  if (unsigned.length === 0 && unlinked.length === 0) {
    return `${MARKER}\nEveryone who wrote a commit here has signed the [CLA](${claURL}). Thank you.`;
  }
  const lines = [MARKER];
  if (unsigned.length > 0) {
    const names = unsigned.map((person) => `@${person.login}`).join(', ');
    lines.push(
      `Thanks for the pull request! Before it can be merged, everyone who wrote a commit in it signs the [Contributor License Agreement](${claURL}) once. Still to sign: ${names}.`,
      '',
      'To sign, read it and then post this comment, exactly:',
      '',
      `> ${SENTENCE}`,
      '',
      'The check runs again by itself when you do. CONTRIBUTING.md explains why the project asks for this.',
    );
  }
  if (unlinked.length > 0) {
    const commits = unlinked.map((commit) => `\`${commit.sha.slice(0, 7)}\` (${commit.name})`).join(', ');
    lines.push(
      '',
      `These commits were made with an email address that isn't linked to a GitHub account, so nobody can sign for them: ${commits}. Add that address to your GitHub account, or re-author the commits with one that is, and push again.`,
    );
  }
  return lines.join('\n');
}

async function upsertComment(github, repo, number, body, { createIfMissing }) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: number,
    per_page: 100,
  });
  const mine = comments.find((comment) => comment.user?.type === 'Bot' && String(comment.body).includes(MARKER));
  if (mine) {
    if (mine.body !== body) await github.rest.issues.updateComment({ ...repo, comment_id: mine.id, body });
  } else if (createIfMissing) {
    await github.rest.issues.createComment({ ...repo, issue_number: number, body });
  }
  return comments;
}

/**
 * Re-runs the pull request's check, so a signature turns it green.
 *
 * A comment runs this workflow in the context of the default branch, so its
 * own result lands on the wrong commit and cannot satisfy the required check.
 * The run that can is the latest `pull_request_target` run for the head commit.
 */
async function rerunCheck(github, repo, headSha, core) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...repo,
    workflow_id: WORKFLOW,
    event: 'pull_request_target',
    head_sha: headSha,
    per_page: 20,
  });
  const latest = (data.workflow_runs ?? [])
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (!latest) {
    core.info('No pull_request_target run to re-run for this head commit.');
    return false;
  }
  try {
    await github.rest.actions.reRunWorkflow({ ...repo, run_id: latest.id });
    return true;
  } catch (error) {
    // Runs older than 30 days cannot be re-run. A push starts a fresh one.
    core.warning(`Could not re-run the CLA check (${error.status ?? error.message}).`);
    return false;
  }
}

async function run({ github, context, core }) {
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const claURL = `https://github.com/${repo.owner}/${repo.repo}/blob/${context.payload.repository.default_branch}/CLA.md`;

  if (context.eventName === 'issue_comment') {
    const { issue, comment } = context.payload;
    if (!issue?.pull_request || !isSignature(comment?.body)) {
      core.info('Not a signature on a pull request; nothing to do.');
      return;
    }
    const { data: pull } = await github.rest.pulls.get({ ...repo, pull_number: issue.number });
    const { people } = await commitAuthors(github, repo, issue.number);
    const signer = people.find((person) => person.id === comment.user.id);
    if (!signer || isExempt(signer)) {
      core.info(`@${comment.user.login} wrote no commit here, so this comment signs nothing.`);
      return;
    }
    await recordSignatures(github, repo, [
      {
        version: CLA_VERSION,
        login: signer.login,
        id: signer.id,
        signedAt: comment.created_at,
        comment: comment.html_url,
        pullRequest: issue.number,
      },
    ]);
    core.info(`Recorded the signature of @${signer.login}.`);
    if (!(await rerunCheck(github, repo, pull.head.sha, core))) {
      await upsertComment(
        github,
        repo,
        issue.number,
        `${MARKER}\nThanks, @${signer.login}: your signature is recorded. The check couldn't re-run itself, so push any commit, or ask for it to be re-run, to update it.`,
        { createIfMissing: true },
      );
    }
    return;
  }

  if (context.eventName !== 'pull_request_target') {
    core.setFailed(`The CLA check does not handle ${context.eventName} events.`);
    return;
  }

  const number = context.payload.pull_request.number;
  const { people, unlinked } = await commitAuthors(github, repo, number);
  const required = people.filter((person) => !isExempt(person));
  const { signatures } = await readSignatures(github, repo);
  const signed = new Set(
    signatures.filter((entry) => entry.version === CLA_VERSION).map((entry) => entry.id),
  );
  let unsigned = required.filter((person) => !signed.has(person.id));

  // A signature posted while no run could record it (before this workflow
  // existed, or during an outage) still counts, so look before asking again.
  if (unsigned.length > 0) {
    const comments = await github.paginate(github.rest.issues.listComments, {
      ...repo,
      issue_number: number,
      per_page: 100,
    });
    const fresh = [];
    for (const person of unsigned) {
      const comment = comments.find((entry) => entry.user?.id === person.id && isSignature(entry.body));
      if (comment) {
        fresh.push({
          version: CLA_VERSION,
          login: person.login,
          id: person.id,
          signedAt: comment.created_at,
          comment: comment.html_url,
          pullRequest: number,
        });
      }
    }
    if (fresh.length > 0) {
      await recordSignatures(github, repo, fresh);
      const recorded = new Set(fresh.map((entry) => entry.id));
      unsigned = unsigned.filter((person) => !recorded.has(person.id));
    }
  }

  const complete = unsigned.length === 0 && unlinked.length === 0;
  // A pull request that never needed a signature gets no comment at all.
  await upsertComment(github, repo, number, commentBody({ unsigned, unlinked, claURL }), {
    createIfMissing: !complete,
  });
  if (!complete) {
    const waiting = [
      ...unsigned.map((person) => `@${person.login}`),
      ...unlinked.map((commit) => commit.sha.slice(0, 7)),
    ];
    core.setFailed(`Waiting on the CLA for: ${waiting.join(', ')}.`);
  }
}

module.exports = {
  CLA_VERSION,
  SENTENCE,
  BRANCH,
  FILE,
  MARKER,
  isSignature,
  isExempt,
  commentBody,
  run,
};
