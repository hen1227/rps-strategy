import { useEffect, useState } from 'react';
import { Dimensions, Keyboard, Platform, type KeyboardEvent } from 'react-native';

// Where the software keyboard is, for the one screen that has to work around it.
//
// A scroller does not need this: `automaticallyAdjustKeyboardInsets` hands the
// question to iOS, which pads the content and brings the focused field up out
// from under the keyboard by itself. What needs an answer in points is a card
// pinned to the foot of a column that does not scroll — the chat beside a wide
// board — because nothing in that layout gives way on its own.

/** The keyboard's top edge, and how long it is taking to get there. */
export interface KeyboardFrame {
  /**
   * Window Y of the top of the keyboard, and null while there is no keyboard
   * over the window at all.
   */
  top: number | null;
  /**
   * What iOS says the move will take, so anything following it can be timed to
   * the same curve rather than jumping ahead of it. Zero when there is nothing
   * to match.
   */
  duration: number;
}

const DOWN: KeyboardFrame = { top: null, duration: 0 };

export const useKeyboardFrame = (): KeyboardFrame => {
  const [frame, setFrame] = useState<KeyboardFrame>(DOWN);

  useEffect(() => {
    // iOS only, and deliberately.
    //
    // Android resizes the window instead — `adjustResize`, which is Expo's
    // default — so by the time anything here could read a height, the layout
    // has already been given a shorter window to fit inside and has fitted
    // itself into it. Taking the keyboard off a second time would count it
    // twice. Web has no software keyboard to hear about: react-native-web's
    // `Keyboard` is a stub whose listeners never fire, so this would be dead
    // weight on every page of the site.
    if (Platform.OS !== 'ios') return;

    const onChange = (event: KeyboardEvent) => {
      const { height, screenY } = event.endCoordinates;
      // An undocked or floating iPad keyboard is not over the foot of the
      // window — it hovers, with the page visible under it, and it can be
      // dragged to the middle of the screen. Its `screenY` is a real number
      // and reading it as "everything below this is covered" would shove the
      // layout up for a keyboard that is covering nothing. Only a keyboard
      // sitting on the bottom edge counts.
      const docked = screenY + height >= Dimensions.get('window').height - 1;
      setFrame(
        docked
          ? { top: Math.round(screenY), duration: event.duration }
          : { top: null, duration: event.duration },
      );
    };
    const onHide = (event: KeyboardEvent) =>
      setFrame({ top: null, duration: event.duration });

    // `willChangeFrame` rather than `willShow`, because the keyboard's height
    // changes while it is up: the predictive strip appears, an accessory bar
    // comes and goes, the language switches to one with a candidate row. Each
    // of those is a frame change and none of them is a show.
    const subscriptions = [
      Keyboard.addListener('keyboardWillChangeFrame', onChange),
      Keyboard.addListener('keyboardWillHide', onHide),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, []);

  return frame;
};
