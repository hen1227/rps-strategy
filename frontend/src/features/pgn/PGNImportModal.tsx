import * as Clipboard from 'expo-clipboard';
import { failureMessage } from '@/errors';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput } from 'react-native';

import { decodePosition, encodePositionPGN } from '@/engine/pgn';
import { colors, radius, themedSheet } from '@/theme';
import ModalCard from '@/ui/ModalCard';
import type { ModeDefinition } from '@/types/game';

// A record, or one position out of one.
//
// The export dialog's plain answer is a FEN — the shortest true thing about a
// board, and the one people already paste at each other — so this box has to
// take one. A position is not a game, though, and the thing every caller of
// this modal wants is a game, so a pasted position is wrapped into the
// shortest record containing it and handed on as that. One code path
// downstream, and the wrapping is where the missing piece gets filled in: a
// FEN cannot say which mode it is, and `positionMode` is the screen answering
// on its behalf. A screen that cannot answer takes records only, and says so.

/** A position never contains a tag pair; a record always opens with one. */
const looksLikeAPosition = (text: string) => !text.includes('[');

export interface PGNImportModalProps {
  onClose: () => void;
  /** Throws with a readable message when the record cannot be read. */
  onLoad: (pgn: string) => void;
  /**
   * The mode a bare position is read against.
   *
   * Absent on a screen that is not open on one board — the lobby — where a
   * position is refused with an explanation rather than guessed at.
   */
  positionMode?: ModeDefinition | null;
  visible: boolean;
}

export default function PGNImportModal({
  onClose,
  onLoad,
  positionMode,
  visible,
}: PGNImportModalProps) {
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

  /** A pasted position as the shortest record holding it. Throws if it cannot. */
  const asRecord = (position: string) => {
    if (!positionMode) {
      throw new Error(
        'That is a position rather than a game. Open the analysis board for the mode it was played in and paste it there.',
      );
    }
    const { grid, currentTurn } = decodePosition(position);
    const board = positionMode.startingPosition.rows;
    if (grid.length !== board.length || (grid[0]?.length ?? 0) !== (board[0]?.length ?? 0)) {
      throw new Error(
        `That is a ${grid[0]?.length ?? 0} by ${grid.length} board. ${positionMode.name} is played on ${board[0]?.length ?? 0} by ${board.length}.`,
      );
    }
    return encodePositionPGN({ grid, currentTurn, mode: positionMode });
  };

  const load = () => {
    const pasted = text.trim();
    if (!pasted) {
      setError(positionMode ? 'Paste a record or a position first.' : 'Paste a PGN record first.');
      return;
    }
    try {
      onLoad(looksLikeAPosition(pasted) ? asRecord(pasted) : pasted);
    } catch (loadError) {
      setError(failureMessage(loadError, 'This could not be loaded.'));
    }
  };

  return (
    <ModalCard
      closeLabel="Close PGN import"
      eyebrow={positionMode ? 'LOAD A BOARD' : 'LOAD GAME ANALYSIS'}
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
            <Text style={styles.loadText}>{positionMode ? 'LOAD' : 'ANALYZE GAME'}</Text>
          </Pressable>
        </>
      }
      onClose={onClose}
      subtitle={
        positionMode
          ? 'A game is replayed and checked before it opens. A position on its own opens on this board.'
          : 'The game will be replayed and checked before it opens in the review.'
      }
      title={positionMode ? 'Paste a game or a position' : 'Paste a PGN'}
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
            placeholder={
              positionMode
                ? '3SSS3/3PPP3/3RRR3/9/9/9/3rrr3/3ppp3/3sss3 b\n\nor a full [Event "…"] record'
                : '[Event "RPS Strategy"]\n[ModeId "V5"]\n…'
            }
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

const styles = themedSheet(() => ({
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
}));
