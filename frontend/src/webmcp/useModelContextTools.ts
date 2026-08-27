// Tools, bound to a screen's lifetime.
//
// The set a page offers is a statement about what it can do *right now*, so it
// changes as the page does: there is no `lab_play_move` until there is a game to
// play a move in. This hook re-registers whenever the list changes and takes
// everything away on unmount, so a stale tool can never outlive the screen that
// meant it.
//
// Behind `useSettled`, and that is not optional: these pages are pre-rendered in
// Node at build time, where `document` does not exist. Registering on the first
// render would either throw during the export or disagree with it in the
// browser — see `expo-static-rendering-constraints`.

import { useEffect, useMemo, useState } from 'react';

import { useSettled } from '@/hooks/useSettled';
import {
  modelContext,
  onToolsChanged,
  registerTools,
  registeredTools,
  type ModelContextFlavour,
  type ToolDescriptor,
} from './modelContext';

export interface ModelContextBinding {
  /** Which generation of the API this page found, once it is settled. */
  flavour: ModelContextFlavour;
  /** What is registered right now — the panel lists exactly this. */
  tools: ToolDescriptor[];
}

/**
 * `descriptors` is expected to be memoised by the caller: it is the dependency,
 * so a fresh array every render would unregister and re-register the whole set
 * on every keystroke.
 */
export const useModelContextTools = (descriptors: ToolDescriptor[]): ModelContextBinding => {
  const settled = useSettled();
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!settled) return;
    const release = registerTools(descriptors);
    setVersion((version) => version + 1);
    return release;
  }, [descriptors, settled]);

  // The shim tells us when its registry moves, which is how the panel stays
  // right when a tool appears mid-session.
  useEffect(() => {
    if (!settled) return onToolsChanged(() => {});
    return onToolsChanged(() => setVersion((version) => version + 1));
  }, [settled]);

  return useMemo(
    () => ({
      flavour: settled ? modelContext().flavour : 'none',
      tools: settled ? registeredTools() : [],
    }),
    // `descriptors` is in the list because the registry changes with it, and the
    // version counter is what re-reads the registry after an out-of-band change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settled, descriptors],
  );
};
