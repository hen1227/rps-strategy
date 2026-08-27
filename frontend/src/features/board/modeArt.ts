// How a mode is drawn, for whichever screen is drawing it.
//
// A published mode carries its own rules — `ModeDefinition.spec` travels inside
// every game state, which is what lets a client that has never heard of a mode
// play it — and those rules say what its pieces look like. This is the one door
// from a mode to that answer, so every board reaches it the same way.
//
// It lives here rather than in `engine/spec` because it needs `API_URL`, and
// `engine/` is pure: an interpreter that knew where a server was could not be
// run in a test, a worker, or a bot.

import { isArtRef, type RuleSpec } from '@/engine/spec/types';
import { looksFor, type PieceLook } from '@/engine/spec/interpret';
import { API_URL } from '@/store/serverConfig';
import type { ModeDefinition } from '@/types/game';

/**
 * Where an uploaded picture is served from, or nothing.
 *
 * The digest *is* the id, so this URL never means a different picture and is
 * cacheable for as long as the server says — the bargain `botIconUrl` strikes
 * with its `?v=`, without needing the query string, because content addressing
 * already did it.
 *
 * The pattern check is the guard, not decoration: this builds a URL path out of
 * a string an author wrote, so anything that is not `img:` and thirty-two hex
 * characters must not become one.
 */
export const artUrl = (reference: string | undefined): string | undefined =>
  reference && isArtRef(reference) ? `${API_URL}/api/lab/art/${reference}` : undefined;

/**
 * How a mode's kinds are drawn, or nothing for a built-in.
 *
 * Cached on the spec object itself, the way `beatsSet` in `interpret.ts` is.
 * `pieceLooks` is the identity every piece on the board is memoised against, so
 * returning a fresh object per render would re-render eighty pieces for nothing.
 *
 * Nothing for a built-in mode, on purpose: their kind ids *are* their artwork
 * names, so `PieceIcon` already draws them correctly with no looks at all, and
 * an object here would be work with no answer in it.
 */
const looksCache = new WeakMap<RuleSpec, Record<string, PieceLook>>();

export const modeLooks = (
  mode: Pick<ModeDefinition, 'spec'> | null | undefined,
): Record<string, PieceLook> | undefined => {
  const spec = mode?.spec;
  if (!spec) return undefined;
  const cached = looksCache.get(spec);
  if (cached) return cached;
  const built = looksFor(spec);
  looksCache.set(spec, built);
  return built;
};

/** The picture painted under a mode's board, as a URL. */
export const modeBackground = (
  mode: Pick<ModeDefinition, 'spec'> | null | undefined,
): string | undefined => artUrl(mode?.spec?.board.art);

/** The picture a mode's library card leads with, as a URL. */
export const modeCover = (
  mode: Pick<ModeDefinition, 'spec'> | null | undefined,
): string | undefined => artUrl(mode?.spec?.cover);
