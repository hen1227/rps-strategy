import { StyleSheet, View } from 'react-native';

import QueueCallout from '@/features/queue/QueueCallout';
import TournamentCallout from '@/features/tournaments/TournamentCallout';
import { useBottomInset } from '@/features/shell/bottomInset';
import { useQueueCall } from '@/hooks/useQueueCall';
import { useTournamentCall } from '@/hooks/useTournamentCall';
import { space } from '@/theme';

// The one strip of screen that floats above everything, and who gets it.
//
// Two things now want the bottom of the page: a tournament match waiting to be
// played, and a queue you are sitting in. Stacking them would put two cards
// over the board; letting either own the layer would mean one of them is
// sometimes invisible when it matters most. So the layer is a place rather than
// a component, and one rule decides what goes in it.
//
// **The tournament wins.** A named opponent standing at a scheduled board is a
// firmer commitment than a search, and the queue's own cancel button is also on
// the lobby screen and in the rail, while the tournament's is only here. There
// is no longer a third contender: a match no longer produces a card at all,
// because pairing opens the board and the board takes the whole screen.
//
// It also, finally, reads `bottomInset`. The shell has measured the phone's tab
// bar and summary bar into that store since it was written, and the tournament
// call-out hard-coded a padding of 14 instead — so on a phone the floating card
// has been sitting on top of the navigation. A card that appears for four
// seconds can get away with that. One that is on screen for ten minutes cannot.

export default function CalloutLayer() {
  const queueCall = useQueueCall();
  const tournamentCall = useTournamentCall();
  const bottomInset = useBottomInset((state) => state.bottomInset);

  const showQueue = queueCall && !tournamentCall;

  if (!showQueue && !tournamentCall) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.layer, { paddingBottom: bottomInset + space.medium }]}
    >
      {showQueue ? <QueueCallout call={queueCall} /> : <TournamentCallout call={tournamentCall!} />}
    </View>
  );
}

/**
 * How much room a screen leaves at its foot so the floating card clears the end
 * of its content. Exported so every screen agrees on the number.
 *
 * Generous rather than measured: the card is two lines and a button most of the
 * time, and three lines and two buttons while it is offering alerts. Reserving
 * for the taller one costs a little blank space below the last panel and saves
 * the last panel from being unreachable.
 */
export const CALLOUT_RESERVE = 140;

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: space.medium,
  },
});
