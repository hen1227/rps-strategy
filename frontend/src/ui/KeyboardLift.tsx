import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LayoutAnimation, View, type StyleProp, type ViewStyle } from 'react-native';

import { useKeyboardFrame } from '@/hooks/useKeyboardFrame';

// Holds what it wraps above the software keyboard.
//
// For a card at the foot of a column that does not scroll, which is what the
// chat is on a wide board: the panel beside the board is exactly as tall as the
// board, the chat is pinned to the bottom of it, and a keyboard over the bottom
// half of an iPad covers the composer and most of the conversation with it.
// Nothing in that layout gives way on its own — the column's height is the
// board's, and shrinking the board to a thumbnail every time somebody says
// "good game" is a worse answer than the one here.
//
// So the card rises over the panel instead, far enough to sit on top of the
// keyboard, and the board, the clock and the move list stay exactly where they
// were. It is an offset rather than a change of position, so nothing around it
// moves and no sibling reflows; the card simply paints over the rows it used to
// sit under, and drops back the moment the keyboard goes down.
//
// A scroller wants none of this. `automaticallyAdjustKeyboardInsets` gives iOS
// the same job and it does it better, padding the content and bringing the
// focused field up itself — that is what the phone layouts use.

export interface KeyboardLiftProps {
  children?: ReactNode;
  /** The style the wrapper would carry anyway: it stands in for its child's slot. */
  style?: StyleProp<ViewStyle>;
}

export default function KeyboardLift({ children, style }: KeyboardLiftProps) {
  const keyboard = useKeyboardFrame();
  const view = useRef<View | null>(null);
  // What the last measurement was taken against, kept out of state because
  // reading it is how the next measurement is corrected rather than something
  // to render.
  const lifted = useRef(0);
  const [lift, setLift] = useState(0);

  useEffect(() => {
    const { duration, top } = keyboard;
    if (top === null) {
      lifted.current = 0;
      setLift(0);
      return;
    }
    // Measured the moment the keyboard moves rather than followed as the layout
    // changes, because where this card's foot sits is a question about the
    // window and `onLayout` answers a different one: where it sits inside its
    // parent, which is the same number whether the parent is on screen or
    // underneath a keyboard. Everything between the two — a header that grew, a
    // safe area, the room a floating call-out reserves — is accounted for by
    // not being counted.
    view.current?.measureInWindow((_x, y, _width, height) => {
      // The current lift added back on, because `y` is where the card is *now*
      // and what the next one has to be measured against is where it would sit
      // with none. Without this a keyboard that changes height mid-edit — the
      // predictive strip appearing — measures an already-lifted card and lifts
      // it again.
      const foot = y + height + lifted.current;
      const next = Math.max(0, Math.round(foot - top));
      if (next === lifted.current) return;
      lifted.current = next;
      // Timed to the keyboard's own move, so the card rides up with it instead
      // of arriving first. `keyboard` is the curve iOS is using; the duration
      // floor is the smallest one RN's own layout animations accept.
      if (duration > 10) {
        LayoutAnimation.configureNext({
          duration,
          update: { duration, type: 'keyboard' },
        });
      }
      setLift(next);
    });
  }, [keyboard]);

  return (
    <View
      // Nothing to flatten away: this view is measured, and on Android a
      // collapsed one has no instance to measure.
      collapsable={false}
      ref={view}
      // `zIndex` only while it is up. A lifted card overlaps the rows it was
      // sitting under and has to paint over them, and being last in the panel
      // is not enough to promise that everywhere.
      style={[style, lift > 0 && { bottom: lift, zIndex: 1 }]}
    >
      {children}
    </View>
  );
}
