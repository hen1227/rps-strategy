import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, type } from '@/theme';

// The strip at the top of every page that says what the server is doing.
//
// Two things end up here and they are deliberately one component, because they
// are one slot: a page can only usefully carry one of these at a time, and
// stacking a restart warning under an apology for a restart is how a lobby ends
// up more chrome than content.
//
//   - **An update.** The server has stopped taking new games and is playing out
//     the ones on the board. This is the whole reason a player is told anything:
//     without it, a deploy looks from the outside like the play button quietly
//     not working, followed by every tab dropping at once.
//   - **A notice.** Something an administrator typed — usually an apology for
//     the restart they are about to do the blunt way, which is the case the
//     update banner cannot cover because there is no drain to announce.
//
// The update wins when both are up, and it is not close: the notice is context,
// and the update is the thing that is about to happen to the page you are
// looking at. The notice is not lost — an administrator posting one during a
// drain is almost always explaining that same drain, and the drain's own `note`
// is where that sentence belongs.
//
// The update banner is not dismissible. A notice is: it is somebody's sentence,
// it has been read, and it should go when the reader says so. An update is a
// live fact about the connection, and a banner you can close while it is still
// true is a banner that lies.

export default function ServerBanner() {
  const update = useGameStore((state) => state.serverUpdate);
  const notice = useGameStore((state) => state.serverNotice);
  const dismissNotice = useGameStore((state) => state.dismissServerNotice);

  if (update?.updating) return <UpdateBanner />;
  if (notice) {
    return (
      <View style={[styles.banner, notice.tone === 'warning' && styles.warning]}>
        <Text style={styles.text}>{notice.text}</Text>
        <Pressable
          accessibilityLabel="Dismiss announcement"
          accessibilityRole="button"
          hitSlop={8}
          onPress={dismissNotice}
        >
          <Text style={styles.close}>×</Text>
        </Pressable>
      </View>
    );
  }
  return null;
}

function UpdateBanner() {
  const update = useGameStore((state) => state.serverUpdate);
  // Re-rendered on a timer rather than only when a message arrives, so "in a
  // moment" does not sit there while the games it is counting finish. The
  // server does broadcast on every change, but the *reason* the count moves is
  // games ending elsewhere, and a second of staleness on a banner people are
  // watching is a second of it looking stuck.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((count) => count + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!update?.updating) return null;

  const remaining = update.gamesRemaining;
  const restarting = update.settled || remaining === 0;

  return (
    <View style={[styles.banner, styles.update]}>
      <View style={styles.dot} />
      <View style={styles.lines}>
        <Text style={styles.text}>
          {update.note}{' '}
          {restarting
            ? 'Restarting now — this page will reconnect on its own.'
            : 'New games are paused while the games already being played finish.'}
        </Text>
        {!restarting && (
          <Text style={styles.detail}>
            {/*
              The count is the reassurance. "An update is coming" with no
              horizon is the state somebody reloads the page over; "waiting on
              one game" is a thing to wait through.
            */}
            {remaining === 1 ? 'Waiting on 1 game' : `Waiting on ${remaining} games`}
            {update.waitingOn.length > 0 ? `: ${update.waitingOn.join(', ')}` : ''}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: space.large,
    marginTop: space.medium,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    paddingVertical: space.small,
    paddingHorizontal: space.medium,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.noticeSurface,
  },
  warning: { borderColor: colors.dangerBorder, backgroundColor: colors.dangerSurfaceQuiet },
  update: { borderColor: colors.liveBorder, backgroundColor: colors.liveSurface },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.live,
  },
  // minWidth: 0 is what lets a long list of game names wrap instead of forcing
  // the row wider than the column it sits in.
  lines: { flex: 1, minWidth: 0, gap: space.hair },
  text: { ...type.body, flex: 1, minWidth: 0, color: colors.textStrong },
  detail: { ...type.meta, color: colors.textMuted },
  close: { ...type.bodyStrong, color: colors.textMuted, paddingHorizontal: space.tight },
});
