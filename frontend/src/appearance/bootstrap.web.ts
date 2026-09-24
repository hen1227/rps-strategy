import { useLayoutEffect, useState } from 'react';

import { DEFAULT_THEME_ID } from '@/theme';

import { adoptAppearance } from './store';
import { readStoredAppearance } from './preference';
import { revealPrepainted } from './prepaint';
import type { AppearanceBootstrap } from './bootstrap.types';

// Launching in the right colours, in a browser. See `bootstrap.ts` for a phone.
//
// `app.json` sets `web.output: "static"`, so every page is a real HTML file
// rendered in Node at build time — with the default theme, because Node has no
// idea what this visitor chose. React then hydrates that HTML, and hydration
// compares what the client renders against what arrived: react-native-web turns
// every colour into an atomic class name, so a first render in a different theme
// differs on essentially every element, and React 19 answers that by throwing
// the pre-rendered page away and rendering the whole thing again on the client.
//
// So the first render here is always the default, and the stored look goes on
// immediately after it. What stops that from being a visible flash is not this
// file but the inline script in `app/+html.tsx`, which runs before the page
// paints: it reads the same key out of `localStorage` and, when the answer is
// not the default, paints the page's background and holds the app hidden until
// the line below reveals it. A visitor on the default theme pays nothing.
//
// --------------------------------------------------------------------------
// Why the routed tree is then thrown away and built again.
//
// "The first render is always the default" is only true of the part of the tree
// that has hydrated by the time the effect below runs, and that is not all of
// it. expo-router wraps route content in three nested Suspense boundaries, and
// React hydrates those separately and later.
//
// A boundary that hydrates *after* the look has changed hydrates the new tokens
// against the old markup. React adopts the element it finds rather than patching
// its `className`, records the class it just rendered as the one showing, and so
// never writes it; from then on every render agrees with itself and does
// nothing. The node keeps the default theme's colours for the life of the page.
// It is not a flash and a reload does not clear it: on the lobby it stranded 47
// visible elements — the page background, the card borders, the badges and the
// eyebrows — around parts that had hydrated early and were perfectly correct.
// Exactly the half-themed page that looks like.
//
// Waiting for hydration to finish instead is not on offer: React publishes no
// signal for it, the boundary comments survive hydration so they cannot be
// watched either, and an idle callback is a guess. So the key below discards the
// pre-rendered markup rather than trying to correct it — which does not care
// when a boundary would have hydrated, because nothing is left for it to hydrate
// into.
//
// The cost is one extra mount of the routed subtree: a second run of the page's
// own effects, paid only by a visitor who is not on the default theme, and paid
// while the app is still hidden. It is *not* paid by the socket or the session
// effects, which hang beside the keyed view rather than inside it — see
// `app/_layout.tsx`.
//
// Deliberately not keyed on the theme. Changing the look after launch has always
// been correct, because by then React's record and the DOM agree and an ordinary
// re-render writes the new classes; a key that moved with the theme would
// remount the navigator mid-session and cost a page its state to fix nothing.

/** The two keys the routed tree is hung on. Only that they differ matters. */
const PRERENDERED = 'prerendered';
const REBUILT = 'rebuilt';

export const bootstrapAppearance: AppearanceBootstrap['bootstrapAppearance'] = () => {
  // Nothing at module scope: see above.
};

export const useAppearanceBootstrap: AppearanceBootstrap['useAppearanceBootstrap'] = () => {
  const [key, setKey] = useState(PRERENDERED);
  // `useLayoutEffect` rather than `useEffect`, so the colours are on — and the
  // tree below rebuilt — before the browser paints the hydrated tree rather than
  // one frame after it. The state set here is flushed synchronously at the end
  // of this commit, so the rebuild lands in the same frame and nothing is
  // painted in between.
  useLayoutEffect(() => {
    const stored = readStoredAppearance();
    adoptAppearance(stored);
    // Only a visitor on something other than the default is holding markup in
    // the wrong colours. On the default the pre-rendered HTML is already right,
    // and keeping it is the entire point of having pre-rendered it.
    if (stored.theme !== DEFAULT_THEME_ID) setKey(REBUILT);
    revealPrepainted();
  }, []);
  return key;
};
