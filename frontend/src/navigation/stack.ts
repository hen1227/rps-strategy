// What a move between two pages does to the stack.
//
// `links.ts` answers *where* a page is and `upFrom.ts` answers *which page it
// is underneath*. This is the third question, and it only exists on a phone:
// given both of those, does going there put a screen on top of the one showing,
// or take the one showing away?
//
// It used to be answered `push` everywhere, and `push` always adds. So a phone
// grew a pile: the lobby, then the board pushed over it, then — on "‹ Lobby" —
// *another whole lobby* pushed over the board, then another board over that.
// Nothing on screen said so, because every one of these pages fills the screen
// and hides what is under it, but the pile was real in three ways. It slid a
// new page in from the right when the button said back. It armed the iOS
// edge-swipe, so a thumb near the left edge of a board dragged the game away
// mid-move. And it never shrank, so the app held every screen anybody had
// visited in one session.
//
// The rule is: **leaving a full-screen page takes that page away.** A board, a
// watched game, a review, the analysis board and a bot battle are the pages
// that take over the whole screen, and they are all somewhere you go *to* and
// come back *from* — so a move off one of them is `dismissTo`, which pops back
// to the page being asked for if it is already underneath and otherwise
// replaces the page being left. Either way the stack does not get taller.
//
// Moves that start inside the lobby shell are left exactly as they were:
// pushing the board over the lobby is the one bit of depth this app has, and it
// is what makes the phone's own back gesture and Android's back button land on
// the lobby rather than closing the app.
//
// Note what this does *not* need to know: where the move is going. A link out
// of a board goes to the lobby, to a player's page, to the opening book and to
// that game's review, and all four want the board gone. Only the page being
// left decides.
//
// With one exception, and it is the only move that looks at the destination: a
// game started from the analysis board is laid *over* it. PLAY A BOT and PASS
// AND PLAY hand the position being studied to a game, and the game's way out
// is back to that position — which only exists if the analysis board is still
// underneath, with its line intact, rather than replaced by the game. See
// `useBoardUpTarget` in `upFrom` for the other half.

import { usePathname, useRouter, useSegments } from 'expo-router';
import { useCallback } from 'react';
import type { Href } from 'expo-router';

import { navRowMove, stackMove } from './stackMove';

/**
 * The route group every lobby section sits in — see `src/app/(shell)/_layout.tsx`.
 *
 * Read off the current route rather than compared against a list of the shell's
 * addresses, because a list is a second copy of the routing table: a page added
 * under `(shell)` and forgotten here would have its links quietly start
 * unwinding the shell, and a new full-screen page forgotten here would bring
 * the pile above back. The router already knows which group it is in.
 */
const SHELL_GROUP = '(shell)';

/** Whether the page showing is a section of the lobby shell. */
const useInShell = (): boolean => {
  // Group segments are part of `useSegments` — they are only filtered out of
  // `pathname`, which is why this asks the segments and not the path.
  const segments: readonly string[] = useSegments();
  // An empty list is the first render of a pre-rendered page, before the router
  // has settled. `false` is the safe answer to guess: it unwinds, and unwinding
  // a stack that is already one deep is a replace.
  return segments[0] === SHELL_GROUP;
};

/**
 * Go to a page.
 *
 * For a handler. `useStackProps` is the same rule for a `<Link>`, which is what
 * anything that can be a real anchor should use instead.
 *
 * `navigate` rather than the `push` this replaced at most call sites: they are
 * the same action for these routes — no two of this app's pages share a route
 * name, which is the only case where they differ — and it is the action a bare
 * `<Link>` already takes, so a button and a link to the same page now do the
 * same thing.
 */
export const useGoTo = (): ((href: Href) => void) => {
  const router = useRouter();
  const pathname = usePathname();
  const inShell = useInShell();

  return useCallback(
    (href: Href) => {
      switch (stackMove(pathname, href, inShell)) {
        case 'replace':
          router.replace(href);
          return;
        case 'navigate':
          router.navigate(href);
          return;
        default:
          router.dismissTo(href);
      }
    },
    [inShell, pathname, router],
  );
};

/**
 * The same rule, as props to spread onto a `<Link>`.
 *
 * A `<Link>` with none of these set navigates, which is the `navigate` case, so
 * that one is the empty object rather than a prop.
 */
export const useStackProps = (href: Href): { replace?: true; dismissTo?: true } => {
  const pathname = usePathname();
  const inShell = useInShell();

  switch (stackMove(pathname, href, inShell)) {
    case 'replace':
      return { replace: true };
    case 'navigate':
      return {};
    default:
      return { dismissTo: true };
  }
};

/**
 * The rule for a row of the shell's own navigation, as props for its `<Link>`:
 * `replace` between sections, and laid over the shell for the row that leaves
 * it. See `navRowMove`.
 */
export const navRowProps = (row: { external?: boolean }): { replace?: true } =>
  navRowMove(row) === 'replace' ? { replace: true } : {};
