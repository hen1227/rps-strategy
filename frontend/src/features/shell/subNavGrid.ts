// How the phone's page strip lays out when its chips do not fit on one line.
//
// Apart from `SubNav` so it can be tested in Node: the arithmetic is the part
// that decides whether four chips are two rows of two or three and a stray.

/**
 * The even grid a strip of chips this wide becomes, or null for one line.
 *
 * Null as well until every chip has been measured, which is the plain wrapped
 * row: the first frame is the old layout, never a guess.
 */
export const gridFor = (
  chipWidths: readonly (number | undefined)[],
  stripWidth: number,
  gap: number,
): { columns: number; cell: number } | null => {
  const count = chipWidths.length;
  if (count < 2 || stripWidth <= 0 || chipWidths.some((width) => width === undefined)) {
    return null;
  }
  const widths = chipWidths as number[];
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * (count - 1);
  if (total <= stripWidth) return null;
  const cellFor = (columns: number) => Math.floor((stripWidth - gap * (columns - 1)) / columns);
  const widest = Math.max(...widths);
  let most = count;
  while (most > 1 && cellFor(most) < widest) most -= 1;
  // As many columns as there is room for, then as few as still fill the rows
  // that needs: four chips that fit three to a row are two rows of two.
  const columns = Math.ceil(count / Math.ceil(count / most));
  return { columns, cell: cellFor(columns) };
};
