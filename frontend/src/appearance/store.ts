import { Platform } from 'react-native';
import { create } from 'zustand';

import { applyAppearance, colors } from '@/theme';

import {
  DEFAULT_APPEARANCE,
  writeStoredAppearance,
  type Appearance,
} from './preference';

// The chosen look, and the one number the whole tree re-renders on.
//
// The colours themselves do not live here. They live in `@/theme`, in objects
// whose contents `applyAppearance` overwrites — which is what lets a hundred and
// thirty files go on importing `colors` and reading `colors.surface`. What lives
// here is the *choice*, and a counter that goes up when it changes, because
// mutating an object outside React changes nothing on screen until something
// re-renders. See `useAppearanceGeneration` for who subscribes and why.

interface AppearanceState {
  appearance: Appearance;
  /** Goes up once per change. The only thing components subscribe to. */
  generation: number;
}

export const useAppearanceStore = create<AppearanceState>()(() => ({
  appearance: { ...DEFAULT_APPEARANCE },
  generation: 0,
}));

/**
 * Everything that has to happen outside React when the look changes.
 *
 * The browser's own chrome takes its colour from a `<meta>` tag that `+html.tsx`
 * wrote at build time, and the page behind the app takes it from the document
 * element. Neither is in the tree, so neither re-renders.
 */
const paintBrowserChrome = (background: string, themeId: string) => {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  document.documentElement.style.backgroundColor = background;
  // Read back on the next load by the inline script in `+html.tsx`, so the page
  // is already the right colour before the bundle has run.
  document.documentElement.setAttribute('data-rps-theme', themeId);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
};

/**
 * Put a look on screen, and remember it.
 *
 * Call this synchronously from the handler that chose it — never inside a
 * transition, never after an `await`. `applyAppearance` mutates objects that
 * live outside React, so React's tearing guarantees do not cover them: a
 * mutation landing halfway through a time-sliced render would leave the
 * components already rendered in that pass holding the previous theme's
 * colours. At the discrete priority an event handler runs at, an in-progress
 * render is thrown away and restarted instead.
 */
export const chooseAppearance = (patch: Partial<Appearance>) => {
  const next = { ...useAppearanceStore.getState().appearance, ...patch };
  // Tokens first, then the stylesheets that read them, then the surfaces
  // outside the tree — and only then the counter that lets anything render.
  applyAppearance(next.theme, next.board);
  // `colors` is the container, not a copy, so this reads what was just written.
  paintBrowserChrome(colors.background, next.theme);
  writeStoredAppearance(next);
  useAppearanceStore.setState((state) => ({
    appearance: next,
    generation: state.generation + 1,
  }));
};

/**
 * Adopt a look without writing it back to the device.
 *
 * For the account's stored appearance arriving on a device that has never been
 * told what to look like. A device that *has* been told keeps its own choice —
 * what you picked here is what you see here — so this is only ever called when
 * `hasStoredAppearance()` is false.
 */
export const adoptAppearance = (appearance: Appearance) => {
  applyAppearance(appearance.theme, appearance.board);
  paintBrowserChrome(colors.background, appearance.theme);
  useAppearanceStore.setState((state) => ({
    appearance,
    generation: state.generation + 1,
  }));
};

/**
 * Re-render this component when the look changes.
 *
 * Every component that reads a colour needs this *somewhere above it that is
 * not memoised*, which in practice is three places: the two layout routes, each
 * page's route file, and the handful of components wearing `memo()`. Everything
 * else re-renders because its parent did — this app has no `FlatList`, no
 * memoised JSX, and no component that takes its children as a prop and holds
 * them, so a re-render at the top of a page reaches every leaf of it.
 *
 * Deliberately a number. A selector returning an object would hand
 * `useSyncExternalStore` a new snapshot every call and loop forever.
 */
export const useAppearanceGeneration = () =>
  useAppearanceStore((state) => state.generation);

/** What is on screen right now. */
export const useAppearance = () => useAppearanceStore((state) => state.appearance);
