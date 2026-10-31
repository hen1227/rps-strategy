import { Text } from 'react-native';

import { buzz, canVibrate, haptic, hapticsAvailable } from '@/haptics/haptics';
import {
  setHaptics,
  setVibration,
  useHapticsEnabled,
  useVibrationEnabled,
} from '@/haptics/preference';
import { colors, space, themedSheet, type } from '@/theme';
import { OptionChips, Panel, SectionHeading } from '@/ui/primitives';

// How the game feels: the taps under a finger, and the buzz for the moments a
// player may not be looking.
//
// Each switch answers in its own voice when it is turned on, the way picking a
// sound pack plays it: turning the taps on taps, and turning the buzz on buzzes.
// Absent on the website, on an iPad and on a build made before haptics were
// added — a switch that cannot do anything there reads as a broken one.

const OPTIONS = [
  { value: true, label: 'On' },
  { value: false, label: 'Off' },
] as const;

export default function HapticsSettings() {
  const hapticsOn = useHapticsEnabled();
  const vibrationOn = useVibrationEnabled();
  return (
    <>
      {hapticsAvailable() ? (
        <Panel>
          <SectionHeading
            eyebrow="TOUCH"
            title="Haptics"
            trailing={
              <OptionChips
                options={OPTIONS}
                value={hapticsOn}
                onChange={(on) => {
                  setHaptics(on);
                  if (on) haptic('toggleOn');
                }}
              />
            }
          />
          <Text style={styles.body}>Taps when you move pieces and press buttons.</Text>
        </Panel>
      ) : null}
      {canVibrate() ? (
        <Panel>
          <SectionHeading
            eyebrow="ALERTS"
            title="Vibration"
            trailing={
              <OptionChips
                options={OPTIONS}
                value={vibrationOn}
                onChange={(on) => {
                  setVibration(on);
                  if (on) buzz('gameStart');
                }}
              />
            }
          />
          <Text style={styles.body}>Buzzes when a game starts and when your clock runs low.</Text>
        </Panel>
      ) : null}
    </>
  );
}

const styles = themedSheet(() => ({
  body: { ...type.body, color: colors.textMuted, marginTop: space.small },
}));
