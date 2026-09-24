import { StyleSheet } from 'react-native';
import type { ImageStyle, TextStyle, ViewStyle } from 'react-native';

// A stylesheet that survives the theme changing under it.
//
// `StyleSheet.create({backgroundColor: colors.surface})` at module scope reads
// the colour once, when the file is imported, and keeps it forever. That was
// the right shape when there was one theme and it is the only thing standing
// between this app and several. There are 128 of them.
//
// The fix keeps every call site exactly as it was. A sheet declares its styles
// in a factory instead of a literal, and what comes back is a container object
// this module owns and refills: `styles.panel` is still `styles.panel`, still a
// plain property read, still written the same way in the 1,400 places that do
// it. Only the two characters around the literal move.
//
//     const styles = StyleSheet.create({ … });    // before
//     const styles = themedSheet(() => ({ … }));  // after
//
// The alternative — a hook per component — was priced and rejected: it is about
// three hundred insertion points rather than a hundred and twenty-eight, half
// of them in files where one sheet is shared by a dozen components, and it does
// not work at all in the render helpers that are not components.
//
// Refilling the container is safe on both platforms, and for the same reason on
// each. react-native-web's `create` compiles every *leaf* to atomic CSS, freezes
// it, registers it in a WeakMap keyed by the leaf, and hands back the object it
// was given; React Native's own is that minus the compiling. Neither touches the
// object we keep, so replacing its properties with freshly compiled leaves is
// the supported thing to do rather than a trick. Nothing grows without bound
// either: atomic class names hash the declaration, so a colour is inserted into
// the document once, ever, however many times themes are switched.

type NamedStyles = Record<string, ViewStyle | TextStyle | ImageStyle>;

interface Registered {
  factory: () => NamedStyles;
  container: NamedStyles;
  /**
   * Compiled styles per appearance, so a return visit to a theme is a hundred
   * property assignments rather than a hundred recompiles — and so that
   * applying the appearance already showing costs nothing at all.
   */
  cache: Map<string, NamedStyles>;
}

const registry: Registered[] = [];

/**
 * Which appearance the containers currently hold.
 *
 * A string rather than a counter because it is the *cache key*: two different
 * generations of the same theme must hit the same compiled styles.
 */
let currentKey = 'initial';

const fill = (entry: Registered) => {
  let compiled = entry.cache.get(currentKey);
  if (!compiled) {
    // A fresh object each time: `create` freezes what it is handed in
    // development, and a frozen literal cannot be compiled twice.
    compiled = StyleSheet.create(entry.factory() as NamedStyles) as NamedStyles;
    entry.cache.set(currentKey, compiled);
  }
  Object.assign(entry.container, compiled);
};

/**
 * A stylesheet that follows the theme.
 *
 * The factory is kept and re-run whenever the appearance changes, so it must be
 * a pure function of the theme tokens and nothing else — no props, no state, no
 * measurements. Everything that varies per render belongs in an inline style,
 * exactly as before.
 */
export const themedSheet = <T extends NamedStyles>(factory: () => T): T => {
  const entry: Registered = { factory, container: {}, cache: new Map() };
  fill(entry);
  registry.push(entry);
  return entry.container as T;
};

/**
 * Refill every container for the appearance named by `key`.
 *
 * Called by `applyAppearance` *after* the tokens have been overwritten and
 * *before* anything re-renders, because the factories read the tokens as they
 * run and no component may render between the two halves.
 */
export const rebuildSheets = (key: string) => {
  currentKey = key;
  for (const entry of registry) fill(entry);
};
