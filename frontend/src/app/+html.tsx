import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

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
          The fallback title, for the pre-rendered HTML. A page that wants its
          own says so with `<Head>` — see `src/navigation/PageTitle.tsx`.
        */}
        <title>RPS Strategy</title>
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
          React Native Web renders a scroll view per screen rather than
          scrolling the document, so the body must not scroll as well.
        */}
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
