// Cutting a shipped document into its sections.
//
// The bot pages show *parts* of documents the server sends whole. The "Your
// bots" page wants the table of commands an engine has to answer and nothing
// else around it; a reference page wants an index of what is in it. Retyping
// either would put a second copy of the protocol inside the app, which is the
// failure `Markdown` exists to prevent — so both are cut out of the source at
// render time and stay whatever the file says today.
//
// Fences are tracked, because the guide's example engine opens with
// `#!/usr/bin/env python3` and that is not a heading.

/** One heading and everything under it. */
export interface DocSection {
  level: number;
  title: string;
  /** A web anchor: lowercased, runs of punctuation collapsed to one dash. */
  id: string;
  /** The source under the heading, up to the next heading that starts one. */
  body: string;
}

const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
// A rule at the end of a section separates it from the next one. Rendered into
// a card of its own it is a line under the last paragraph and nothing else.
const TRAILING_RULE = /\n\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

export const sectionId = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Split a document at every heading of `level` or higher.
 *
 * `level` is the deepest heading that starts a section, so `2` keeps each `###`
 * inside the `##` it belongs to and `3` breaks them out on their own. Anything
 * before the first heading is dropped: these documents all open with one.
 */
export function docSections(source: string | null | undefined, level = 2): DocSection[] {
  const sections: DocSection[] = [];
  let heading: Omit<DocSection, 'body'> | null = null;
  let body: string[] = [];
  let fenced = false;

  const close = () => {
    if (heading) {
      sections.push({
        ...heading,
        body: body.join('\n').trim().replace(TRAILING_RULE, ''),
      });
    }
  };

  for (const line of String(source ?? '').split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    const match = fenced ? null : line.match(HEADING);
    const hashes = match?.[1]?.length ?? 0;
    if (match && hashes <= level) {
      close();
      const title = (match[2] ?? '').trim();
      heading = { level: hashes, title, id: sectionId(title) };
      body = [];
      continue;
    }
    if (heading) body.push(line);
  }
  close();
  return sections;
}

/** The first section whose title matches, or null when the document changed. */
export const findSection = (sections: DocSection[], match: RegExp): DocSection | null =>
  sections.find((section) => match.test(section.title)) ?? null;

/**
 * One section's source, heading included, ready to hand to `Markdown`.
 *
 * Null rather than a throw when nothing matches: a section that has been
 * renamed upstream should cost a card on a page, not the page.
 */
export const sectionSource = (section: DocSection | null): string | null =>
  section ? `${'#'.repeat(section.level)} ${section.title}\n\n${section.body}` : null;
