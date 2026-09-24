// The one arrow family for going backwards and forwards.
//
// Named here rather than typed into each button, because they have to match
// across screens that never see each other: the replay row under a board, the
// undo pair in the analysis header, the pager under a list of names. All four
// are line arrows out of the Arrows block, so they share a stroke weight and
// an optical size, and all four take the `color` and `fontWeight` of the
// `Text` drawing them.
//
// That last part is what the replay row got wrong. It paired `⏮`/`⏭` with
// `←`/`→`, and the media-transport glyphs are solid triangles: heavier than
// the arrows beside them, a different size, and deaf to the `fontWeight: 900`
// the buttons set — four buttons in one row reading as two sets of controls.
//
// These are for stepping through something: a move, a page, a move being taken
// back. The app's other directional glyphs are different words and are not
// interchangeable with them — `▶` is start-this-game, and the `‹`/`›` in
// `BackLink` and `LinkRow` are go-to-a-screen.
export const arrows = {
  /** One step back: the previous position, the newer page, a take-back. */
  back: '←',
  /** One step on: the next position, the older page, a move put back. */
  forward: '→',
  /** All the way back: the starting position, the top of the line. */
  jumpBack: '⇤',
  /** All the way on: the latest position, the end of the line. */
  jumpForward: '⇥',
} as const;

export default arrows;
