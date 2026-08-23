import * as Clipboard from 'expo-clipboard';
import { failureMessage } from '@/errors';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput } from 'react-native';

import { colors, radius } from '@/theme';
import ModalCard from '@/ui/ModalCard';

export interface PGNImportModalProps {
  onClose: () => void;
  /** Throws with a readable message when the record cannot be read. */
  onLoad: (pgn: string) => void;
  visible: boolean;
}

export default function PGNImportModal({ onClose, onLoad, visible }: PGNImportModalProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setText('');
    setError(null);
  }, [visible]);

  const pasteFromClipboard = async () => {
    try {
      const clipboardText = await Clipboard.getStringAsync();
      if (!clipboardText.trim()) {
        setError('The clipboard does not contain any text.');
        return;
      }
      setText(clipboardText);
      setError(null);
    } catch (clipboardError) {
      setError(failureMessage(clipboardError, 'The clipboard could not be read.'));
    }
  };

  const load = () => {
    if (!text.trim()) {
      setError('Paste a PGN record first.');
      return;
    }
    try {
      onLoad(text.trim());
    } catch (loadError) {
      setError(failureMessage(loadError, 'This PGN could not be loaded.'));
    }
  };

  return (
    <ModalCard
      closeLabel="Close PGN import"
      eyebrow="LOAD GAME ANALYSIS"
      footer={
        <>
          <Pressable
            accessibilityRole="button"
            onPress={pasteFromClipboard}
            style={({ pressed }) => [styles.pasteButton, pressed && styles.pressed]}
          >
            <Text style={styles.pasteText}>PASTE FROM CLIPBOARD</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={load}
            style={({ pressed }) => [styles.loadButton, pressed && styles.pressed]}
          >
            <Text style={styles.loadText}>ANALYZE GAME</Text>
          </Pressable>
        </>
      }
      onClose={onClose}
      subtitle="The game will be replayed and checked before RPSFish reviews every move."
      title="Paste a PGN"
      visible={visible}
    >

          <TextInput
            accessibilityLabel="PGN text"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={(value) => {
              setText(value);
              setError(null);
            }}
            placeholder={'[Event "RPS Strategy"]\n[ModeId "V5"]\n…'}
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            textAlignVertical="top"
            value={text}
          />

          {error ? (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {error}
            </Text>
          ) : null}

    </ModalCard>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 230,
    maxHeight: 420,
    marginTop: 15,
    padding: 12,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSunken,
    color: colors.text,
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
  },
  error: { color: colors.dangerText, fontSize: 10, lineHeight: 14, marginTop: 8 },
  pasteButton: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 13,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  pasteText: { color: colors.textMuted, fontSize: 8, fontWeight: '900' },
  loadButton: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 17,
    borderRadius: radius.medium,
    backgroundColor: colors.accent,
  },
  loadText: { color: colors.textStrong, fontSize: 9, fontWeight: '900' },
  pressed: { opacity: 0.7 },
});
