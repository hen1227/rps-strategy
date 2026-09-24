import type { ThemeSpec } from '../spec';

import { charcoal } from './charcoal';
import { contrast } from './contrast';
import { forest } from './forest';
import { midnight } from './midnight';
import { parchment } from './parchment';

// Every look that ships. Curated rather than open: the combinations a player can
// reach are all ones somebody designed, and each theme here is checked against
// each board in `../boards.ts`.
export const THEMES: readonly ThemeSpec[] = [forest, midnight, charcoal, parchment, contrast];

export const DEFAULT_THEME_ID = 'forest';

/**
 * The theme with this id, or the default.
 *
 * Unknown ids are the ordinary case, not an error: a device that stored a
 * preset a later build removed, or an account synced from a phone running a
 * newer version, must render *something*. Same rule `titleTone` follows.
 */
export const themeById = (id: string | null | undefined): ThemeSpec =>
  THEMES.find((theme) => theme.id === id) ?? THEMES[0]!;
