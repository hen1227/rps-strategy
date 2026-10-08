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

const channels = (hex: string): [number, number, number] => {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((channel) => channel + channel)
          .join('')
      : value;
  return [0, 2, 4].map((start) => parseInt(full.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
};

const toHex = (rgb: readonly number[]) =>
  `#${rgb
    .map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0'))
    .join('')}`;

/** `from` moved `amount` of the way to `to`, channel by channel. */
export const mix = (from: string, to: string, amount: number) => {
  const a = channels(from);
  const b = channels(to);
  return toHex(a.map((channel, index) => channel + (b[index]! - channel) * amount));
};

/**
 * A square as a picture of a board draws it, rather than as the board does.
 *
 * Two moves, and both are needed. Taking out some of the colour is what stops a
 * small, saturated chequer from being the loudest thing on a card; leaning the
 * result towards the card it sits on is what makes it look placed there rather
 * than pasted on. Neither moves the two squares far enough apart or together
 * to change how a position reads.
 */
export const previewTile = (tile: string, surface: string) => {
  const [red, green, blue] = channels(tile);
  const grey = 0.299 * red + 0.587 * green + 0.114 * blue;
  const quieter = toHex([red, green, blue].map((channel) => channel + (grey - channel) * 0.24));
  return mix(quieter, surface, 0.1);
};
