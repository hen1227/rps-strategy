import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

import { prepaintScript } from '@/appearance/prepaint';
import { colors } from '@/theme';
import { HOVER_STYLESHEET } from '@/ui/hover';

// The HTML shell every exported page is built into.
//
// This file runs in Node at build time, never in the browser: it has no DOM, no
// `window`, and no access to anything the app knows. Providers belong in
// `_layout.tsx`, which does run in the browser.

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        {/*
          No `<title>` here, deliberately. The static renderer injects the one
          from `<PageTitle>` at the very top of this `<head>`, and it injects it
          unconditionally — empty, for a page that declares none. A title
          written here could therefore only ever be a second `<title>` element:
          never reached, and no use as a fallback. Titles live in
          `src/navigation/PageTitle.tsx`.
        */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        <meta
          name="description"
          content="Play Rock–Paper–Scissors on a 9×9 board. Challenge players and bots, review games, and enter tournaments."
        />
        {/*
          Icons. Expo's generated favicon only reaches 48px, which is too small
          for bookmark and shortcut tiles, so the larger sizes are declared by
          hand and served from `public/`. The tab and tile icons are
          transparent; the iOS home-screen icon keeps its slate plate because
          iOS flattens alpha to black.
        */}
        <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
        <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        {/*
          The web app manifest, which is not decoration. Safari delivers Web
          Push only to a site that has been added to the Home Screen, and
          `display: standalone` in the manifest is what makes that installation
          produce a context where notifications work at all. Without it, an
          iPhone user can never wait in the queue with the app closed.

          The manifest repeats the default theme's background as a literal
          because static JSON cannot import from the theme, and — unlike the
          meta tag below — it cannot follow a theme the player picks either: it
          is read when the site is installed, not when it is opened. So the
          splash behind a Home Screen launch is always the default look. The two
          must still be changed together when *that* look changes.
        */}
        <link rel="manifest" href="/manifest.webmanifest" />
        {/*
          The default here and not the chosen theme, for the same reason every
          page is pre-rendered in it. `appearance/store.ts` rewrites this tag at
          runtime once the real theme is on.
        */}
        <meta name="theme-color" content={colors.background} />
        {/*
          Before anything paints: hold the app back if this visitor has chosen a
          theme the pre-rendered HTML is not in. See `appearance/prepaint.ts` —
          the whole of why is written there.
        */}
        <script dangerouslySetInnerHTML={{ __html: prepaintScript() }} />
        {/*
          React Native Web renders a scroll view per screen rather than
          scrolling the document, so the body must not scroll as well.
        */}
        <ScrollViewStyleReset />
        {/*
          The one hover rule this site has.

          React Native's style system cannot express a pseudo-class, and the
          names all over this app — engines, entrants, opponents — have to
          underline under the pointer to read as the links they are. See
          `src/ui/hover.ts`, which owns both the rule and the class it hangs
          off, and `src/ui/PlayerLink.tsx`, which wears it.
        */}
        <style id="rps-hover" dangerouslySetInnerHTML={{ __html: HOVER_STYLESHEET }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
