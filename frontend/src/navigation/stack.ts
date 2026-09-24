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

import { usePathname, useRouter, useSegments } from 'expo-router';
import { useCallback } from 'react';
import type { Href } from 'expo-router';

import { pageOf } from './links';

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

/** How a move should be dispatched: the three the router offers that we use. */
type StackMove = 'navigate' | 'replace' | 'dismissTo';

/**
 * The move for going to `to` from the page `from`.
 *
 * `fromShell` is whether the page being left is a section of the lobby shell,
 * which is the whole of the decision — see the note at the top of this file.
 *
 * The same page again is `replace`, and that is not only about stack depth:
 * `replace` gives the route a fresh key, so the screen unmounts and comes back
 * up on its new parameters. Swapping which game you are watching, or which line
 * of the book you are reading, depends on that remount to start over — the
 * other two moves hand the same screen new parameters and let it decide, which
 * a screen holding "I have already asked for my game" cannot do.
 */
const stackMove = (from: string, to: Href, fromShell: boolean): StackMove => {
  if (pageOf(to) === from) return 'replace';
  return fromShell ? 'navigate' : 'dismissTo';
};

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
