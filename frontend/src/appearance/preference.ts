import { deviceStorage } from '@/store/deviceStorage';
import { DEFAULT_BOARD_ID, DEFAULT_THEME_ID } from '@/theme';

import { DEFAULT_PIECE_SET_ID } from './pieceSets';
import { DEFAULT_SOUND_PACK_ID } from './soundPacks';

// What a player has chosen to look at, and where it is kept.
//
// The shape is four ids and nothing else. Not four objects, and not a colour
// anywhere: an id is all that survives a build that adds a preset or drops one,
// and it is the only thing worth sending to a server that must not be taught
// the catalogue. Everything an id cannot answer is answered by falling back to
// the default, the way `titleTone` has always handled a title this build has
// never heard of.

export interface Appearance {
  /** A theme id from `THEMES`. */
  theme: string;
  /** A board id from `BOARDS`. */
  board: string;
  /** A piece set id from `PIECE_SETS`. */
  pieces: string;
  /** A sound pack id from `SOUND_PACKS`. */
  sound: string;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: DEFAULT_THEME_ID,
  board: DEFAULT_BOARD_ID,
  pieces: DEFAULT_PIECE_SET_ID,
  sound: DEFAULT_SOUND_PACK_ID,
};

const APPEARANCE_KEY = 'rps.appearance.v1';

/** Keep only what we recognise as an id, and let the rest fall back. */
const clean = (value: unknown): Appearance => {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_APPEARANCE };
  const raw = value as Partial<Record<keyof Appearance, unknown>>;
  const pick = (field: keyof Appearance) =>
    typeof raw[field] === 'string' && raw[field].length > 0 && raw[field].length <= 64
      ? (raw[field] as string)
      : DEFAULT_APPEARANCE[field];
  return { theme: pick('theme'), board: pick('board'), pieces: pick('pieces'), sound: pick('sound') };
};

/**
 * A stored or synced appearance, as an `Appearance`.
 *
 * Anything unrecognised falls back to the default field by field rather than
 * wholesale, so a look saved by a newer build — one axis of which this build
 * has never heard of — still carries over the three axes it does know.
 */
export const appearanceFromJson = (raw: string | null | undefined): Appearance => {
  if (!raw) return { ...DEFAULT_APPEARANCE };
  try {
    return clean(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
};

/**
 * What this device last chose, or the default.
 *
 * Synchronous, which is the whole reason `deviceStorage` is: on a phone this is
 * read before the first frame is drawn, so the app opens in the right colours
 * rather than flashing through somebody else's. See `bootstrap.ts`.
 */
export const readStoredAppearance = (): Appearance => {
  try {
    const stored = deviceStorage()?.getItem(APPEARANCE_KEY);
    return stored ? clean(JSON.parse(stored)) : { ...DEFAULT_APPEARANCE };
  } catch {
    // Private browsing, a device store that will not open, or a value written
    // by a build that wrote something else. None is worth a broken launch.
    return { ...DEFAULT_APPEARANCE };
  }
};

export const writeStoredAppearance = (appearance: Appearance) => {
  try {
    deviceStorage()?.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
  } catch {
    // The look lasts as long as this session does.
  }
};

/** Whether this device has ever been told what to look like. */
export const hasStoredAppearance = (): boolean => {
  try {
    return Boolean(deviceStorage()?.getItem(APPEARANCE_KEY));
  } catch {
    return false;
  }
};
