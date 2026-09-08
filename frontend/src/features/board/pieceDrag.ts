import { create } from 'zustand';

// Whether a piece is being dragged right now.
//
// A board inside a scrolling page has a problem a mouse never had. On iOS the
// touch belongs to the enclosing `UIScrollView` first: as soon as the finger
// moves it cancels the touch and scrolls, so dragging a piece dragged the page
// too — and the cancelled touch snapped the piece back to the square it came
// from. The responder system does not help, because Fabric's scroll view
// decides whether to cancel a content touch without consulting the JS
// responder at all (`touchesShouldCancelInContentView:` in
// `RCTScrollViewComponentView.mm` asks only whether scrolling is disabled).
//
// So the board says when a drag is in flight and the pages that put a board
// inside a `ScrollView` stop scrolling while it is. Published here rather than
// passed down because in each of those trees the board is nowhere near the
// scroller, and every one of them has exactly one board — following
// `shell/bottomInset.ts`, which is published for the same reason.
//
// Pieces set this through `getState()` rather than by subscribing: a board is
// eighty-one squares, and none of them needs to re-render because one of them
// is being dragged.

interface PieceDragState {
  dragging: boolean;
  setDragging: (dragging: boolean) => void;
}

export const usePieceDrag = create<PieceDragState>((set) => ({
  dragging: false,
  // Guarded because a drag that ends where it started reports its finish twice
  // — once on release and once as the responder is given up.
  setDragging: (dragging) =>
    set((state) => (state.dragging === dragging ? state : { dragging })),
}));
