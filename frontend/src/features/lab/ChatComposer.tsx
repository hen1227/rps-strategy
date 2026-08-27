import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius, space, type } from '@/theme';

// The one place you talk to it.
//
// Enter sends and Shift+Enter starts a line, on the web, because that is what
// every chat box does and a person will try it before reading anything. On a
// phone the return key is a return key: there is no modifier to hold, and a box
// you cannot put a second line in is worse than a button you have to press.

export interface ChatComposerProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  running?: boolean;
  placeholder?: string;
  /** Rendered under the input: the tools pill, a key prompt, a queued notice. */
  footer?: React.ReactNode;
  autoFocus?: boolean;
  /** The big first-run version: taller, and the label spelled out. */
  size?: 'rail' | 'stage';
}

export default function ChatComposer({
  onSend,
  onStop,
  running = false,
  placeholder = 'Describe a change…',
  footer,
  autoFocus = false,
  size = 'rail',
}: ChatComposerProps) {
  const [text, setText] = useState('');

  const send = () => {
    const message = text.trim();
    if (!message) return;
    setText('');
    onSend(message);
  };

  return (
    <View style={[styles.frame, size === 'stage' && styles.frameStage]}>
      <TextInput
        accessibilityLabel="What should your game do?"
        autoFocus={autoFocus}
        multiline
        onChangeText={setText}
        onKeyPress={(event) => {
          if (Platform.OS !== 'web') return;
          const key = event.nativeEvent as unknown as { key?: string; shiftKey?: boolean };
          if (key.key === 'Enter' && !key.shiftKey) {
            event.preventDefault?.();
            send();
          }
        }}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        style={[styles.input, size === 'stage' && styles.inputStage]}
        submitBehavior="newline"
        value={text}
      />
      <View style={styles.tray}>
        <View style={styles.footer}>{footer}</View>
        {running && onStop ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop the agent"
            onPress={onStop}
            style={({ pressed }) => [styles.stop, pressed && styles.pressed]}
          >
            <Text style={styles.stopGlyph}>■</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            disabled={text.trim() === ''}
            onPress={send}
            style={({ pressed }) => [
              styles.send,
              text.trim() === '' && styles.sendIdle,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.sendGlyph, text.trim() === '' && styles.sendGlyphIdle]}>▶</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    backgroundColor: colors.surfaceSunken,
    borderColor: colors.border,
    borderRadius: radius.large,
    borderWidth: 1,
    padding: space.small,
    gap: space.snug,
  },
  frameStage: { padding: space.medium, gap: space.small },
  input: {
    ...type.body,
    color: colors.text,
    maxHeight: 160,
    minHeight: 38,
    // The web input draws its own focus ring over our border.
    ...Platform.select({ web: { outlineStyle: 'none' as never } }),
  },
  inputStage: { ...type.bodyStrong, minHeight: 62 },
  tray: { flexDirection: 'row', alignItems: 'center', gap: space.small },
  footer: { flex: 1, minWidth: 0 },
  send: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radius.large,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  sendIdle: { backgroundColor: colors.surfaceMuted },
  sendGlyph: { ...type.meta, color: colors.textInverse, fontWeight: '900', marginLeft: 1 },
  sendGlyphIdle: { color: colors.textFaint },
  stop: {
    alignItems: 'center',
    backgroundColor: colors.dangerSurface,
    borderColor: colors.dangerBorder,
    borderWidth: 1,
    borderRadius: radius.large,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  stopGlyph: { ...type.meta, color: colors.dangerText, fontWeight: '900' },
  pressed: { opacity: 0.7 },
});
