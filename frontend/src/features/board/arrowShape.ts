// The shape of an arrow drawn across squares, and nothing about who asked for one.
//
// Every arrow on a board here — the engine's ranked suggestions, the opening
// explorer's weighted moves, the orange one drawn by dragging with the right
// button, the single move on a lobby thumbnail — is the same drawing problem:
// point from one square's centre at another's, over pieces, on a chequer, and
// be read at a glance. So it is solved once, in board coordinates (one unit is
// one square), and the callers supply only a colour and a thickness.
//
// It returns one closed path rather than a stroked line wearing an SVG marker.
// A marker is sized in stroke widths, so a thicker arrow grows a head three
// times too big for the square it lands on, and the join between line and
// marker shows as a seam wherever the arrow is anything but opaque. One filled
// outline has neither problem, and it lets the tail be genuinely round and the
// head genuinely swept, which is the difference the eye actually reads.

/** How far from the source square's centre the tail begins, in squares. */
const TAIL_GAP = 0.26;
/**
 * How far short of the destination's centre the tip stops.
 *
 * Short, not zero: the arrow has to claim the square it points at, and a tip
 * that halts on the square's edge leaves the reader guessing between that
 * square and the one before it. Stopping just inside the centre points at the
 * piece without burying it.
 */
const TIP_GAP = 0.08;
/** Below this much shaft an arrow reads as a floating triangle, so the tail is moved instead. */
const MIN_SHAFT = 0.08;
/** How far the tail may be dragged towards the source piece to make room. */
const MIN_TAIL_GAP = 0.14;
/** A head shorter than this cannot be told from a blunt end. */
const MIN_HEAD = 0.2;

/** The head's width, from the shaft's, held between the two sizes that read. */
const headWidthFor = (width: number) => Math.max(0.44, Math.min(0.58, width * 3));
/** A head a touch shorter than it is wide: any longer and it looks like a spear. */
const HEAD_ASPECT = 0.8;
/**
 * Where the shaft meets the head, as a fraction of the head's length back from
 * the tip. A little under one, so the barbs trail slightly behind the join.
 * Enough of a sweep that the head is not a triangle parked on a stick; not so
 * much that the barbs thin into spikes, which is what happens well before the
 * shape starts to look intentional.
 */
const HEAD_SWEEP = 0.9;

export interface ArrowGeometry {
  /** Board coordinates of the square the arrow leaves. Centres, not corners. */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** Shaft thickness in squares. The head is sized from it. */
  width: number;
}

/**
 * The arrow as an SVG `d`, or `null` when there is nothing to draw.
 *
 * Null rather than an empty path for the two cases a caller can hand over
 * without meaning to: a move to the square it started on, and a distance so
 * small that a head and a tail cannot both fit. Both would otherwise render as
 * a smear at one square's centre, which reads as a bug in the position rather
 * than as an arrow the caller should not have asked for.
 */
export const arrowPath = ({
  fromX,
  fromY,
  toX,
  toY,
  width,
}: ArrowGeometry): string | null => {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < 0.2) return null;

  const ux = dx / length;
  const uy = dy / length;

  const halfShaft = width / 2;
  const fullHead = headWidthFor(width) * HEAD_ASPECT;

  // The tip first, then whatever room is left is divided between head and
  // shaft: a one-square move is most of a board's arrows and it has barely
  // half a square to work with, so the tail gives way before the head does.
  const tip = Math.max(length - TIP_GAP, length * 0.55);
  let tail = TAIL_GAP;
  let head = fullHead;
  if (tip - tail < head + MIN_SHAFT) {
    tail = Math.max(MIN_TAIL_GAP, tip - head - MIN_SHAFT);
  }
  if (tip - tail < head + MIN_SHAFT) {
    head = Math.max(MIN_HEAD, tip - tail - MIN_SHAFT);
  }
  if (tip - tail <= head) return null;

  // The head keeps its proportions when it is shortened, so a cramped arrow
  // has a smaller head rather than a spike.
  const halfHead = head / (2 * HEAD_ASPECT);
  const barb = tip - head;
  const join = tip - head * HEAD_SWEEP;

  // Along the move, then across it. Everything above is measured in those two
  // directions, so this is the only place the arrow learns which way it points.
  const at = (along: number, across: number) =>
    `${(fromX + ux * along - uy * across).toFixed(4)},${(
      fromY +
      uy * along +
      ux * across
    ).toFixed(4)}`;

  // The tail is a true half-circle rather than a squared end. Radii equal, so
  // the rotation flag is moot; the sweep survives the rotation because a
  // rotation cannot turn a shape inside out.
  return [
    `M${at(tail, -halfShaft)}`,
    `A${halfShaft.toFixed(4)},${halfShaft.toFixed(4)} 0 0 0 ${at(tail, halfShaft)}`,
    `L${at(join, halfShaft)}`,
    `L${at(barb, halfHead)}`,
    `L${at(tip, 0)}`,
    `L${at(barb, -halfHead)}`,
    `L${at(join, -halfShaft)}`,
    'Z',
  ].join(' ');
};
