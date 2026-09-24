import { adoptAppearance } from './store';
import { readStoredAppearance } from './preference';
import type { AppearanceBootstrap } from './bootstrap.types';

// Launching in the right colours, on a phone.
//
// There is no pre-render here and `deviceStorage` answers synchronously, so the
// stored look is applied while this module is being evaluated — before anything
// has rendered, which is why a phone never flashes the default theme.
//
// Deliberately here rather than at the top of `theme/index.ts`. Reading storage
// opens an `expo-sqlite` database, and the theme barrel is imported by a hundred
// and thirty modules, some of them evaluated very early; `localIdentity.ts`
// defers its own read for the same reason. Importing this file from
// `app/_layout.tsx` puts the read after the theme has finished evaluating and
// still well before the first frame.
//
// See `bootstrap.web.ts` for the browser.

export const bootstrapAppearance: AppearanceBootstrap['bootstrapAppearance'] = () => {
  adoptAppearance(readStoredAppearance());
};

export const useAppearanceBootstrap: AppearanceBootstrap['useAppearanceBootstrap'] = () => {
  // Already done, at module scope. Nothing here was rendered anywhere but here,
  // so there is no markup in the wrong colours to discard and the routed tree
  // keeps one key for the whole session. See `bootstrap.web.ts` for the browser,
  // which does not get off so lightly.
  return 'native';
};
