import { useContext, useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

// How far the app has to stand clear of the software keyboard, on Android.
//
// Android used to resize the window for the keyboard (`adjustResize`), and this
// app is laid out on that assumption — see `useKeyboardFrame.ts`. Apps that
// target Android 15 are drawn edge to edge and the window is no longer resized,
// so the keyboard simply covers whatever is under it, a focused field included.
// Padding the root by what the keyboard covers hands the layout back the
// shorter window it was written for, and a scroller with a field focused in it
// brings that field into view as it shrinks, exactly as it did before.
//
// What it covers is the keyboard and the navigation bar under it. React Native
// reports the keyboard alone, so the bottom inset is added back: a page whose
// scroller runs to the foot of the screen — the board on a phone does — would
// otherwise keep that much of itself, and its composer, behind the keyboard.
// The one thing that pads itself by the inset as well, the tab bar, lets go of
// it while the keyboard is up (`ShellLayout`), so nothing is counted twice.
//
// Always zero on iOS, which pads its own scrollers, and on the web, which has
// no keyboard to hear about.
export const useKeyboardRoom = (): number => {
  const [keyboard, setKeyboard] = useState(0);
  // The context rather than the hook, which throws with no provider above it.
  const bottomInset = useContext(SafeAreaInsetsContext)?.bottom ?? 0;

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    // Android has no "will" events. React Native sends `keyboardDidShow` again
    // when the height changes while the keyboard is up, which covers an emoji
    // panel or a candidate strip coming and going.
    const subscriptions = [
      Keyboard.addListener('keyboardDidShow', (event) =>
        setKeyboard(Math.max(0, Math.round(event.endCoordinates.height))),
      ),
      Keyboard.addListener('keyboardDidHide', () => setKeyboard(0)),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, []);

  return keyboard > 0 ? keyboard + bottomInset : 0;
};
