// Colour arithmetic, and nothing that knows what a colour is for.
//
// Both helpers were in `theme.ts` when there was one theme. They are here now
// because `buildTheme` runs them per preset and the presets themselves reach
// for `withAlpha` when they author a wash.

/** A hex colour with the alpha channel put on. `#abc` and `#aabbcc` both work. */
export const withAlpha = (hex: string, alpha: number) => {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((channel) => channel + channel)
          .join('')
      : value;
  const red = parseInt(full.slice(0, 2), 16);
  const green = parseInt(full.slice(2, 4), 16);
  const blue = parseInt(full.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
};

/**
 * How many distances the reach ramp distinguishes, counting zero.
 *
 * Nine, because a king crosses a nine-square board in eight moves and anything
 * a detour pushes past that is far enough to share the faintest band.
 */
export const REACH_BANDS = 9;

/**
 * A wash per distance: opaque under the piece, almost gone at the far edge.
 *
 * Two ramps per side, for the same reason `clock.bonusWash` has two: one alpha
 * cannot serve both squares of a chequerboard. The strong hue darkens the light
 * tile and would vanish into the dark one, so the dark tile takes the light hue
 * instead and lifts off its background rather than sinking into it.
 *
 * The near end is well short of opaque on purpose. This is a wash the pieces
 * have to be read *through* — a board whose own position has become hard to see
 * is not a board anybody can use the overlay on.
 */
export const reachRamp = (hex: string, near: number, far: number): readonly string[] =>
  Array.from({ length: REACH_BANDS }, (_unusedBand, moves) =>
    withAlpha(hex, near + ((far - near) * moves) / (REACH_BANDS - 1)),
  );
