import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { fastReplayDuration } from '@/engine/replayAnimation';
import { haptic } from '@/haptics/haptics';
import { burstOffsets, type HapticEvent } from '@/haptics/recipes';
import { colors, radius, themedSheet } from '@/theme';
import { arrows } from '@/ui/arrows';

// How long an arrow is held before it starts to repeat, and how fast it then
// walks the game. A detent every 90ms is quick enough to cross a long game in a
// few seconds and slow enough that every move is still a tap of its own.
const HOLD_DELAY_MS = 350;
const HOLD_REPEAT_MS = 90;

/** A step that lands on either end of the game is felt as a stop. */
const detentAt = (position: number, total: number): HapticEvent =>
  position <= 0 || position >= total ? 'stop' : 'step';

export interface ReplayControlsProps {
  /**
   * Drawn at the right-hand end of the row, level with the buttons.
   *
   * For something that belongs with the controls but is not one of them and
   * comes and goes — the live board's way back to the live position. It gets a
   * zone of its own so that appearing costs the buttons nothing: they stay
   * centred on the row, in the place the viewer last reached for them, instead
   * of being pushed along by it.
   */
  accessory?: ReactNode;
  /** Where the viewer is standing, counted in moves. */
  current: number;
  /** What the badge calls the position — `MOVE`, or `LIVE` at the live edge. */
  label?: string;
  onFirst: () => void;
  onLast: () => void;
  onNext: () => void;
  onPrevious: () => void;
  total: number;
}

export default function ReplayControls({
  accessory,
  current,
  label = 'MOVE',
  onFirst,
  onLast,
  onNext,
  onPrevious,
  total,
}: ReplayControlsProps) {
  // What the accessory takes up, mirrored as empty space on the other side so
  // the buttons stay centred on the row. Measured rather than guessed: the
  // caller's button is the caller's, and a number agreed by hand here would be
  // wrong the first time anybody changed its label.
  //
  // Held on to once measured, rather than released while the accessory is away.
  // Nothing is riding on the space, and keeping it means the row a viewer steps
  // back into is laid out exactly like the one they left — which matters on a
  // panel narrow enough that the buttons have to give up a pixel or two to fit
  // the accessory beside them. A screen that never passes one measures nothing
  // and reserves nothing.
  const [reserved, setReserved] = useState(0);
  const measure = (event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    setReserved((previous) => (previous === width ? previous : width));
  };

  const atFirst = current <= 0;
  const atLast = current >= total;

  // Every move is a detent under the finger, the way a dial clicks: a step taps,
  // a held arrow taps once per move it walks, and the end of the game is a stop.
  // A held arrow outlives the render that started it, so it reads where the
  // viewer stands, and the step to take, through refs: a caller's step can be a
  // closure over the position it was drawn at, and walking with that one would
  // take the same step over and over. It keeps its own count of where it has
  // walked to, so it knows the end is coming before the render that shows it.
  const standing = useRef({ current, total });
  standing.current = { current, total };
  const steps = useRef({ onNext, onPrevious });
  steps.current = { onNext, onPrevious };
  const walk = useRef<{ at: number; timer: ReturnType<typeof setTimeout> | null }>({
    at: 0,
    timer: null,
  });
  const stopWalking = () => {
    if (walk.current.timer) clearTimeout(walk.current.timer);
    walk.current.timer = null;
  };
  useEffect(() => stopWalking, []);

  const stepBy = (direction: -1 | 1, move: () => void) => () => {
    const next = standing.current.current + direction;
    move();
    haptic(detentAt(next, standing.current.total));
  };

  const walkBy = (direction: -1 | 1) => () => {
    stopWalking();
    walk.current.at = standing.current.current;
    const tick = () => {
      const next = walk.current.at + direction;
      if (next < 0 || next > standing.current.total) {
        walk.current.timer = null;
        return;
      }
      walk.current.at = next;
      if (direction < 0) steps.current.onPrevious();
      else steps.current.onNext();
      const detent = detentAt(next, standing.current.total);
      haptic(detent);
      walk.current.timer = detent === 'stop' ? null : setTimeout(tick, HOLD_REPEAT_MS);
    };
    tick();
  };

  // A jump winds the whole way in one animation, and is felt winding: a run of
  // taps spread over the time the board takes to draw it, ending in the stop.
  const jumpTo = (target: number, move: () => void) => () => {
    const moves = Math.abs(target - standing.current.current);
    move();
    const offsets = burstOffsets(moves, moves > 1 ? fastReplayDuration(moves) : 0);
    offsets.forEach((offset, index) => {
      const event = index === offsets.length - 1 ? 'stop' : 'step';
      if (offset === 0) haptic(event);
      else setTimeout(() => haptic(event), offset);
    });
  };

  const control = (
    accessibilityLabel: string,
    text: string,
    onPress: () => void,
    disabled = false,
    hint?: string,
    onHold?: () => void,
  ): ReactNode => (
    <Pressable
      accessibilityHint={hint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      delayLongPress={HOLD_DELAY_MS}
      disabled={disabled}
      onLongPress={onHold}
      onPress={onPress}
      onPressOut={onHold ? stopWalking : undefined}
      style={({ pressed }) => [
        styles.button,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={styles.buttonText}>{text}</Text>
    </Pressable>
  );

  return (
    <View style={styles.controls}>
      {/*
        Two zones of equal share either side of the buttons, holding the same
        width whether or not the accessory is there — which is the whole point
        of them. The buttons are centred between the zones, so they sit in one
        place all game and stepping off the live edge does not shove them along.
      */}
      <View style={styles.side}>
        <View style={{ width: reserved }} />
      </View>
      <View style={styles.group}>
        {control('Jump to the starting position', arrows.jumpBack, jumpTo(0, onFirst), atFirst)}
        {control(
          'Previous position',
          arrows.back,
          stepBy(-1, onPrevious),
          atFirst,
          'You can also press the left arrow key, or hold this to walk back.',
          walkBy(-1),
        )}
        <View style={styles.badge}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.value}>
            {current}/{total}
          </Text>
        </View>
        {control(
          'Next position',
          arrows.forward,
          stepBy(1, onNext),
          atLast,
          'You can also press the right arrow key, or hold this to walk forward.',
          walkBy(1),
        )}
        {control(
          'Jump to the latest position',
          arrows.jumpForward,
          jumpTo(total, onLast),
          atLast,
        )}
      </View>
      <View style={[styles.side, styles.sideEnd]}>
        {accessory ? <View onLayout={measure}>{accessory}</View> : null}
      </View>
    </View>
  );
}

const styles = themedSheet(() => ({
  controls: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    // Between the buttons and the zones either side of them, so an accessory
    // never ends up shoulder to shoulder with the last button on a narrow row.
    gap: 5,
    marginTop: 8,
  },
  // `flexShrink` here as well as on the buttons: the buttons cannot give up
  // what this does not pass down to them, and without it a narrow row overflows
  // the card instead of tightening.
  group: {
    flexDirection: 'row',
    flexShrink: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  // Sized by what is in them and given an equal share of the rest, so the row
  // is symmetrical however wide the panel is. Neither zone shrinks: on a panel
  // too narrow for both — a small window, where the score sheet's column is at
  // its floor — the buttons give up a few pixels each instead, which is what
  // `flexShrink` on them below is for. The alternative is an accessory drawn
  // over the button beside it.
  side: { flexGrow: 1, flexShrink: 0, flexBasis: 'auto' },
  sideEnd: { alignItems: 'flex-end' },
  button: {
    width: 42,
    height: 36,
    flexShrink: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  disabled: { opacity: 0.3 },
  pressed: { opacity: 0.68 },
  buttonText: { color: colors.textSoft, fontSize: 15, fontWeight: '900' },
  // Gives up a few pixels alongside the buttons on a narrow row, rather than
  // making them pay for all of it: four buttons squeezed to nothing around a
  // badge at full width is the wrong picture of what is short of room.
  badge: {
    minWidth: 60,
    flexShrink: 1,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceSunken,
  },
  label: { color: colors.textFaint, fontSize: 7, fontWeight: '900', letterSpacing: 1 },
  value: { color: colors.textStrong, fontSize: 11, fontWeight: '900', marginTop: 1 },
}));
