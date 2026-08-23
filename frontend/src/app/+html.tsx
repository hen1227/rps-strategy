import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

import { colors } from '@/theme';

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
          content="A real-time Rock–Paper–Scissors strategy game on a 9x9 board, with a
            deterministic analysis engine, post-game review, and tournaments."
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

          The manifest repeats `colors.background` as a literal because static
          JSON cannot import from the theme. It is the one sanctioned copy of a
          colour outside `theme.ts`; the meta tag below is the version that can
          be kept honest, and the two must be changed together.
        */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content={colors.background} />
        {/*
          React Native Web renders a scroll view per screen rather than
          scrolling the document, so the body must not scroll as well.
        */}
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
