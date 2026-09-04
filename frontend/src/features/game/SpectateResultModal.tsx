import { StyleSheet, Text, View } from 'react-native';

import { endReasonPhrase } from './resultLabels';
import { colors, radius, space, type } from '@/theme';
import type { GameEndReason, PlayerColor } from '@/types/game';
import ModalCard from '@/ui/ModalCard';
import { GhostButton, PrimaryButton } from '@/ui/primitives';

// How a watched game ends.
//
// A spectator used to be told by a line in a card at the side of the board
// quietly changing what it said. Watching two engines, that is easy to miss
// completely: nothing moves for a second or two either way, the board looks the
// same as it did, and the next thing that happens is a different game appearing
// underneath you. A result you have to notice for yourself is not a result.
//
// So it interrupts, once per game, and every way out of it is a button: back to
// the board you were watching, back to the lobby, or on to the next game —
// because "what do I watch now" is the real question at the end of a watched
// game, and the run or the event is the only thing that knows the answer.
//
// Deliberately spectators only. A player who has just lost is already looking
// straight at the board, and already has a card offering them a rematch and a
// review; putting their own result over the top of it would be telling somebody
// something they were in the room for.

export interface SpectateResultModalProps {
  /** The seats, so the result reads with names in it rather than colours. */
  redName: string;
  blueName: string;
  winner: PlayerColor;
  endReason: GameEndReason | string | null;
  /** Close it and go on looking at the final position. */
  onDismiss: () => void;
  onReturnToLobby: () => void;
  /**
   * The next thing to watch, when the run or the event this game belonged to
   * has one going. Absent leaves the button out rather than offering a dead
   * one, which is the ordinary case for a single game between two people.
   */
  next?: { label: string; onWatch: () => void } | null;
  visible: boolean;
}

export default function SpectateResultModal({
  blueName,
  endReason,
  next,
  onDismiss,
  onReturnToLobby,
  redName,
  visible,
  winner,
}: SpectateResultModalProps) {
  const drawn = winner === 'Neutral';
  const winnerName = winner === 'Red' ? redName : blueName;
  const loserName = winner === 'Red' ? blueName : redName;
  const reason = endReasonPhrase(endReason);
  const sentence = drawn
    ? `${redName} and ${blueName} drew${reason ? ` by ${reason}` : ''}.`
    : `${winnerName} beat ${loserName}${reason ? ` by ${reason}` : ''}.`;

  return (
    <ModalCard
      closeLabel="Close the result and go back to the board"
      eyebrow="FINAL"
      maxWidth={420}
      onClose={onDismiss}
      subtitle={sentence}
      title={drawn ? 'Drawn' : `${winnerName} won`}
      visible={visible}
      footer={
        <>
          <GhostButton label="Back to lobby" onPress={onReturnToLobby} />
          <GhostButton label="View board" onPress={onDismiss} />
          {next ? <PrimaryButton label={next.label} onPress={next.onWatch} /> : null}
        </>
      }
    >
      {/*
        The colour, under a sentence written in names. Somebody who has been
        following the board for twenty moves has been thinking in Red and Blue
        the whole time, and this is the one line that joins the two up.
      */}
      {drawn ? null : (
        <View style={styles.side}>
          <View style={[styles.tag, winner === 'Red' ? styles.tagRed : styles.tagBlue]}>
            <Text
              style={[
                styles.tagText,
                winner === 'Red' ? styles.tagRedText : styles.tagBlueText,
              ]}
            >
              {winner.toUpperCase()} WINS
            </Text>
          </View>
        </View>
      )}
    </ModalCard>
  );
}

const styles = StyleSheet.create({
  side: { flexDirection: 'row', marginTop: space.medium },
  tag: {
    paddingHorizontal: space.small,
    paddingVertical: 3,
    borderRadius: radius.small,
    borderWidth: 1,
  },
  tagText: { ...type.label },
  tagRed: { backgroundColor: colors.dangerSurfaceQuiet, borderColor: colors.dangerBorder },
  tagRedText: { color: colors.dangerSoft },
  tagBlue: { backgroundColor: colors.accentSurface, borderColor: colors.accentBorder },
  tagBlueText: { color: colors.accentSoft },
});
