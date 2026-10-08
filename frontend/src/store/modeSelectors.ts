import type { ModeDefinition } from '@/types/game';

// Which mode the site leads with, and which are its variants.
//
// The lobby used to give every playable mode the same card in a column, which
// told a newcomer there were three equal games to choose between when there is
// one game and two ways of changing how it is won. The main one is read off
// the catalogue rather than named here: the server already ranks its modes by
// `displayOrder`, and Intransitive is 1 (backend/internal/game/
// mode_intransitive.go), so reordering the catalogue moves the lobby with it
// and a client release is not needed to promote a different mode.

/** The modes that take new games, in the catalogue's order. */
export const playableModesOf = (modes: readonly ModeDefinition[]): ModeDefinition[] =>
  modes.filter((mode) => mode.playable !== false);

/**
 * Where a mode sits in the catalogue's ranking.
 *
 * A mode fabricated in the Lab, or sent by a server older than the field, may
 * carry no order at all, and it ranks after every mode that does rather than
 * ahead of them as a missing number compared as zero would.
 */
const rankOf = (mode: ModeDefinition): number =>
  Number.isFinite(mode.displayOrder) ? mode.displayOrder : Number.POSITIVE_INFINITY;

/**
 * The mode the lobby leads with: the playable one the catalogue ranks first.
 *
 * Ties keep the catalogue's own order. Null only while no playable mode is
 * known at all, which the lobby treats as having nothing to feature.
 */
export const featuredModeOf = (modes: readonly ModeDefinition[]): ModeDefinition | null =>
  playableModesOf(modes).reduce<ModeDefinition | null>(
    (best, mode) => (best === null || rankOf(mode) < rankOf(best) ? mode : best),
    null,
  );

/** Every other playable mode, in the catalogue's order. */
export const variantModesOf = (modes: readonly ModeDefinition[]): ModeDefinition[] => {
  const featured = featuredModeOf(modes);
  return playableModesOf(modes).filter((mode) => mode.id !== featured?.id);
};
