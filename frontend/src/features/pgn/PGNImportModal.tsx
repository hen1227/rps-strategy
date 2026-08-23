import * as Clipboard from 'expo-clipboard';
import { failureMessage } from '@/errors';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, overlay, radius, shadows } from '@/theme';

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
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.root}
      >
        <Pressable
          accessibilityLabel="Close PGN import"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
        />
        <View accessibilityViewIsModal style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.eyebrow}>LOAD GAME ANALYSIS</Text>
              <Text style={styles.title}>Paste a PGN</Text>
              <Text style={styles.subtitle}>
                The game will be replayed and checked before RPSFish reviews every move.
              </Text>
            </View>
            <Pressable
              accessibilityLabel="Close PGN import"
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <Text style={styles.closeMark}>×</Text>
            </Pressable>
          </View>

          <TextInput
            accessibilityLabel="PGN text"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={(value) => {
              setText(value);
              setError(null);
            }}
            placeholder={'[Event "RPS Strategy"]\n[ModeId "V1"]\n…'}
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

          <View style={styles.footer}>
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
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 14 },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: overlay },
  card: {
    width: '100%',
    maxWidth: 620,
    maxHeight: '94%',
    padding: 17,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    boxShadow: shadows.modal,
    elevation: 18,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  headerCopy: { flex: 1 },
  eyebrow: { color: colors.accentBright, fontSize: 8, fontWeight: '900', letterSpacing: 1.4 },
  title: { color: colors.textStrong, fontSize: 20, fontWeight: '900', marginTop: 4 },
  subtitle: { color: colors.textMuted, fontSize: 10, lineHeight: 15, marginTop: 4 },
  closeButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceRaised,
  },
  closeMark: { color: colors.textMuted, fontSize: 23, lineHeight: 25 },
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
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
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
