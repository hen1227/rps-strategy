import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated as NativeAnimated,
  Easing,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

// How far a board travels on its way out, and where the next one starts from.
// Deliberately small: this is a hand-off between two boards of the same event,
// not a change of page.
const SHIFT = 26;
const LEAVE_MS = 150;
const ARRIVE_MS = 300;

export interface GameTransitionProps {
  children: ReactNode;
  /** The game on screen. Changing it plays the arrival. */
  gameKey: string | null;
  /** True from asking for another board until that board lands. */
  leaving: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * The hand-off from one watched board to the next.
 *
 * One value carries both halves of it: -1 is gone to the left, 0 is settled,
 * and +1 is waiting off to the right. Leaving runs the value out to -1, and
 * arriving drops it to +1 and brings it home. The jump across the middle
 * happens at zero opacity, so a board that lands part-way through a slide
 * takes over unseen instead of snapping into place.
 */
export default function GameTransition({
  children,
  gameKey,
  leaving,
  style,
}: GameTransitionProps) {
  const phase = useRef(new NativeAnimated.Value(0)).current;
  // Seeded with the first game so that opening the screen is not itself a
  // transition. Only a *change* of board is one.
  const previousKey = useRef(gameKey);

  useEffect(() => {
    if (previousKey.current === gameKey) return undefined;
    previousKey.current = gameKey;
    if (!gameKey) return undefined;
    phase.setValue(1);
    const arrival = NativeAnimated.timing(phase, {
      toValue: 0,
      duration: ARRIVE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    arrival.start();
    return () => arrival.stop();
  }, [gameKey, phase]);

  useEffect(() => {
    if (!leaving) return undefined;
    const departure = NativeAnimated.timing(phase, {
      toValue: -1,
      duration: LEAVE_MS,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    departure.start();
    return () => departure.stop();
  }, [leaving, phase]);

  return (
    <NativeAnimated.View
      style={[
        style,
        {
          opacity: phase.interpolate({ inputRange: [-1, 0, 1], outputRange: [0, 1, 0] }),
          transform: [
            {
              translateX: phase.interpolate({
                inputRange: [-1, 0, 1],
                outputRange: [-SHIFT, 0, SHIFT],
              }),
            },
            {
              scale: phase.interpolate({
                inputRange: [-1, 0, 1],
                outputRange: [0.97, 1, 0.97],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </NativeAnimated.View>
  );
}
