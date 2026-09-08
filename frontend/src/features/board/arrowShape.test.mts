// The arrow's outline, checked where getting it wrong is invisible in review.
//
// A path string is a poor thing to assert on directly, so the tests read the
// points back out of it and ask geometric questions: does the tip point where
// the caller said, does the head stay on the near side of the destination, is
// there still an arrow left when the two squares are neighbours.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { arrowPath } from './arrowShape';

/**
 * Every point the path visits, in order.
 *
 * The tail's arc writes its radii as a comma-separated pair too, so those are
 * dropped first -- reading them as a point puts a stray coordinate near the
 * origin into every answer, which is the kind of thing that makes a test agree
 * with a broken shape.
 */
const pointsOf = (d: string): [number, number][] =>
  [...d.replace(/A[\d.]+,[\d.]+ \d \d \d /g, 'L').matchAll(/(-?\d+\.\d+),(-?\d+\.\d+)/g)].map(
    ([, x, y]) => [Number(x), Number(y)],
  );

const distance = (a: [number, number], b: [number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]);

const ONE_SQUARE = { fromX: 4.5, fromY: 5.5, toX: 4.5, toY: 4.5, width: 0.185 };

describe('arrowPath', () => {
  it('puts the tip short of the square it points at, on the line between the two', () => {
    const d = arrowPath({ fromX: 1.5, fromY: 7.5, toX: 5.5, toY: 3.5, width: 0.17 });
    assert.ok(d);
    // The tip is the point furthest from the source; nothing else may pass it.
    const points = pointsOf(d);
    const far = points.reduce((best, point) =>
      distance(point, [1.5, 7.5]) > distance(best, [1.5, 7.5]) ? point : best,
    );
    // On the diagonal, and inside the destination square rather than past it.
    // The path rounds to four places, so the diagonal is exact only to that.
    assert.ok(Math.abs(far[0] - 1.5 - (7.5 - far[1])) < 1e-3, 'tip left the line');
    assert.ok(distance(far, [5.5, 3.5]) < 0.5, 'tip fell short of the square');
    assert.ok(distance(far, [5.5, 3.5]) > 0, 'tip overshot the centre');
  });

  it('leaves the source square centre clear, so the arrow starts beside its piece', () => {
    const d = arrowPath(ONE_SQUARE);
    assert.ok(d);
    for (const point of pointsOf(d)) {
      assert.ok(distance(point, [4.5, 5.5]) > 0.15, `${point} sits on the source centre`);
    }
  });

  it('still draws a shaft and a head between neighbouring squares', () => {
    // The common case in this game: one step. If the head ever grew to eat the
    // whole span the arrow would silently become a triangle with no direction.
    const d = arrowPath(ONE_SQUARE);
    assert.ok(d);
    const ys = pointsOf(d).map(([, y]) => y);
    const tip = Math.min(...ys);
    const tail = Math.max(...ys);
    const barbs = ys.filter((y) => y > tip + 0.01 && y < tail - 0.01);
    assert.ok(barbs.length >= 4, 'the head swallowed the shaft');
  });

  it('scales the head with the shaft, within bounds a square can hold', () => {
    const widthAcross = (width: number) => {
      const d = arrowPath({ ...ONE_SQUARE, width });
      assert.ok(d);
      const xs = pointsOf(d).map(([x]) => x);
      return Math.max(...xs) - Math.min(...xs);
    };
    assert.ok(widthAcross(0.09) < widthAcross(0.185), 'a fainter arrow drew a wider head');
    assert.ok(widthAcross(0.185) < 0.75, 'the head outgrew its square');
    assert.ok(widthAcross(0.09) > 0.3, 'the head shrank out of sight');
  });

  it('declines the two shapes that would render as a smear', () => {
    assert.equal(arrowPath({ ...ONE_SQUARE, toX: 4.5, toY: 5.5 }), null);
    assert.equal(arrowPath({ ...ONE_SQUARE, toY: 5.4 }), null);
  });
});
