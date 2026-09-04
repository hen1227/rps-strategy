import { Pressable, Text } from 'react-native';

import { confirmStyles } from './adminStyles';

// A destructive button that arms on the first press and fires on the second.
//
// The confirmation state lives in the parent rather than in here, and that is
// the whole design: pressing anything else on the screen has to disarm it. An
// armed delete that stays armed while the host goes off to search for something
// else is a trap — they come back, press what they think is a fresh button, and
// have deleted something.
//
// Hence `armed` and `onArm` rather than internal state. The parent holds one
// key naming whichever button is armed, and setting it disarms every other one
// for free.

export interface ConfirmButtonProps {
  /** Whether this is the button the parent is currently holding armed. */
  armed: boolean;
  busy: boolean;
  label: string;
  onArm: () => void;
  onConfirm: () => void;
  /**
   * `danger` is red and is the default. `quiet` is for a destructive action
   * that is nonetheless the *right* one — anonymizing an account rather than
   * deleting it — which should not shout louder than the worse option beside
   * it.
   */
  tone?: 'danger' | 'quiet';
}

export default function ConfirmButton({
  armed,
  busy,
  label,
  onArm,
  onConfirm,
  tone = 'danger',
}: ConfirmButtonProps) {
  return (
    <Pressable
      accessibilityLabel={armed ? `Confirm: ${label}` : label}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={armed ? onConfirm : onArm}
      style={({ pressed }) => [
        confirmStyles.button,
        tone === 'danger' && confirmStyles.danger,
        armed && confirmStyles.armed,
        busy && confirmStyles.disabled,
        pressed && confirmStyles.pressed,
      ]}
    >
      <Text
        style={[
          confirmStyles.text,
          tone === 'danger' && confirmStyles.textDanger,
          armed && confirmStyles.textArmed,
        ]}
      >
        {armed ? 'CONFIRM?' : label}
      </Text>
    </Pressable>
  );
}
