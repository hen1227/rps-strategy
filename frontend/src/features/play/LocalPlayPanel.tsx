import { StyleSheet, Text, View } from 'react-native';

import { useGameStore } from '@/store/gameStore';
import { colors, space, themedSheet, type } from '@/theme';
import { Badge, Panel, PrimaryButton, SectionHeading } from '@/ui/primitives';
import type { ModeDefinition } from '@/types/game';

// The other answer to "how do I get into a game against a person".
//
// It sits on this page rather than beside the bots because the opponent is a
// person, which is what this section is about — the only difference from the
// panels above it is that they find you somebody and this one assumes you have
// already found them, and they are sitting next to you.
//
// One button per mode, the same shape the bot ladder uses, because the choice
// really is that small: there is nothing to configure, since the two things a
// game is usually set up with — a clock and a rating — are exactly what a board
// two people share does not have.

export interface LocalPlayPanelProps {
  /** Whether some other board already owns the screen. */
  disabled: boolean;
  modes: readonly ModeDefinition[];
}

export default function LocalPlayPanel({ disabled, modes }: LocalPlayPanelProps) {
  const startLocalGame = useGameStore((state) => state.startLocalGame);

  if (modes.length === 0) return null;

  return (
    <Panel>
      <SectionHeading
        eyebrow="ONE DEVICE"
        title="Pass and play"
        trailing={<Badge label="OFFLINE" />}
      />
      <Text style={styles.help}>
        Play against a friend on the same device.
      </Text>
      <View style={styles.buttonRow}>
        {modes.map((mode) => (
          <View key={mode.id} style={styles.buttonCell}>
            <PrimaryButton
              accessibilityLabel={`Play ${mode.name} against someone on this device`}
              disabled={disabled}
              label={`${mode.name.toUpperCase()} ▶`}
              onPress={() => startLocalGame({ mode })}
              tone="quiet"
            />
          </View>
        ))}
      </View>
    </Panel>
  );
}

const styles = themedSheet(() => ({
  help: { ...type.body, color: colors.textMuted, marginTop: space.small },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.small, marginTop: space.medium },
  buttonCell: { flexBasis: 180, flexGrow: 1 },
}));
