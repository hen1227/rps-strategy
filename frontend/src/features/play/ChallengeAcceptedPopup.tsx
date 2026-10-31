import { Text } from 'react-native';

import { useGameStore } from '@/store/gameStore';
import { colors, space, themedSheet, type } from '@/theme';
import ModalCard from '@/ui/ModalCard';
import { PrimaryButton } from '@/ui/primitives';

// Somebody took your challenge link, and the game is on.
//
// The board has already opened under this — the game starts the moment its
// taker can play and its author is at the screen — so this does not ask
// anything. It says who it is, because the link went to a chat window and the
// person who opened it may not be the one it was sent to, and it says whose
// move it is, because the first-move window is already counting.
//
// Hung beside the stack in the root layout rather than inside the board, so it
// appears over whichever page the author was on when the game took the screen.

export default function ChallengeAcceptedPopup() {
  const link = useGameStore((state) => state.acceptedLink);
  const dismiss = useGameStore((state) => state.dismissAcceptedLink);
  // Read off the board itself rather than worked out from the seat preference:
  // the board is what is on screen, and it cannot disagree with itself.
  const yourMove = useGameStore(
    (state) =>
      Boolean(state.gameState) &&
      state.gameState?.gameId === state.acceptedLink?.gameId &&
      state.gameState?.currentTurn === state.playerColor,
  );
  const taker = link?.taker?.username?.trim() || 'Someone';

  return (
    <ModalCard
      closeLabel="Close and go to the board"
      eyebrow="CHALLENGE ACCEPTED"
      footer={<PrimaryButton accessibilityLabel="Go to the board" label="PLAY ▶" onPress={dismiss} />}
      maxWidth={420}
      onClose={dismiss}
      title={`${taker} took your link`}
      visible={Boolean(link)}
    >
      <Text style={styles.line}>
        {yourMove ? 'The game is on. You move first.' : 'The game is on. They move first.'}
      </Text>
    </ModalCard>
  );
}

const styles = themedSheet(() => ({
  line: { ...type.bodyStrong, color: colors.textSoft, marginTop: space.medium },
}));
