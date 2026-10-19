// Which of the router's moves a link takes — the rule `stack.ts` dispatches,
// with nothing of the router in it.
//
// Apart from the hooks for one reason: `expo-router` cannot be imported under
// Node, so a rule that lives beside `useRouter` cannot be tested. Here it is a
// function of plain values, and `stackMove.test.mts` runs each answer through
// the router's own reducer to show what it does to the stack. See `stack.ts`
// for the rule itself and the pile of screens it exists to prevent.

import type { Href } from 'expo-router';

import { links, pageOf } from './links';

/** How a move should be dispatched: the three the router offers that we use. */
export type StackMove = 'navigate' | 'replace' | 'dismissTo';

/**
 * The move for going to `to` from the page `from`.
 *
 * `fromShell` is whether the page being left is a section of the lobby shell,
 * which is the whole of the decision — see the note at the top of `stack.ts`.
 *
 * The same page again is `replace`, and that is not only about stack depth:
 * `replace` gives the route a fresh key, so the screen unmounts and comes back
 * up on its new parameters. Swapping which game you are watching, or which line
 * of the book you are reading, depends on that remount to start over — the
 * other two moves hand the same screen new parameters and let it decide, which
 * a screen holding "I have already asked for my game" cannot do.
 */
export const stackMove = (from: string, to: Href, fromShell: boolean): StackMove => {
  if (pageOf(to) === from) return 'replace';
  if (from === pageOf(links.analysis()) && pageOf(to) === pageOf(links.play())) return 'navigate';
  return fromShell ? 'navigate' : 'dismissTo';
};

/**
 * The move for a row of the lobby's own navigation: the sidebar on a wide
 * screen, and the strip of pages under the phone's header.
 *
 * Between two sections of the shell it is `replace`. The rows are the shell's
 * tabs, and a tab pressed is not a page to come back to, so the shell stays one
 * page deep however much somebody moves around it.
 *
 * A row that leaves the shell is the exception — the analysis board, the one
 * `external` section. Pressing it is a move from the shell to a full-screen
 * page like any other, so it lays the board *over* the shell, which is what
 * `stackMove` answers for every other way onto it. `replace` there threw the
 * shell away instead: the board's "‹ Lobby" then had nothing underneath to pop
 * back to, so it built a fresh lobby and slid it in on top. On an iPad that
 * read as every press pushing a new screen, "back" included.
 */
export const navRowMove = (row: { external?: boolean }): StackMove =>
  row.external ? 'navigate' : 'replace';
