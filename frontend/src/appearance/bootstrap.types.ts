/**
 * How the stored look gets on screen at launch, declared apart from either
 * implementation so that both must satisfy it.
 *
 * Platform files are resolved by the bundler and never see each other, so a
 * shared declaration is the only thing that can keep them in step. See
 * `store/deviceStorage.types.ts`, which exists for the same reason.
 */
export interface AppearanceBootstrap {
  /**
   * Apply the device's stored look.
   *
   * Native calls this at module scope, before the first render — storage is
   * synchronous there and there is nothing to match, so the app simply opens in
   * the right colours. The browser cannot: every page is pre-rendered in Node
   * with the default theme, and a first client render in any other one is a
   * hydration mismatch that throws the whole pre-rendered page away. So on the
   * web this is a no-op and the hook below does the work instead.
   */
  bootstrapAppearance: () => void;
  /**
   * Apply the stored look after the first render, where that is the only safe
   * moment, and return the key `_layout.tsx` hangs the routed tree on.
   *
   * The key is the web's half of a fault a phone does not have: pre-rendered
   * markup that some of the tree hydrates into *after* the look has already
   * changed. Changing it throws that markup away. The whole of why is in
   * `bootstrap.web.ts`.
   *
   * Native pre-renders nothing, so it has nothing to discard and returns a
   * constant — the key it hands the layout never changes and nothing remounts.
   */
  useAppearanceBootstrap: () => string;
}
