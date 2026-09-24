import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, themedSheet, type } from '@/theme';
import type { BotBench } from '@/types/protocol';

// The strip at the top of every page that says what the server is doing.
//
// Three things end up here and they are deliberately one component, because
// they are one slot: a page can only usefully carry one of these at a time, and
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
//   - **A coming bench.** The engines go off at a known hour for an event
//     elsewhere, and somebody who plays the ladder every evening should hear
//     that before they sit down to it rather than from a refusal.
//
// They rank in that order, and the order is how urgent the thing is to the page
// in front of you: an update is about to take this tab away, a notice is
// somebody talking to you now, a bench is a thing happening later today. The
// notice is not lost under an update — an administrator posting one during a
// drain is almost always explaining that same drain, and the drain's own `note`
// is where that sentence belongs.
//
// The update banner is not dismissible. A notice is: it is somebody's sentence,
// it has been read, and it should go when the reader says so. An update is a
// live fact about the connection, and a banner you can close while it is still
// true is a banner that lies. The bench heads-up is dismissible for the notice's
// reason and then some — it stands for a day, and a banner that cannot be put
// down is a banner somebody reads past on every page for twenty-four hours.

// How long before a bench the heads-up goes up. A day, so that somebody who
// plays at the same time each evening sees it during the session before the one
// they would otherwise be turned away from.
const BENCH_LEAD_MS = 24 * 60 * 60 * 1000;

export default function ServerBanner() {
  const update = useGameStore((state) => state.serverUpdate);
  const notice = useGameStore((state) => state.serverNotice);
  const dismissNotice = useGameStore((state) => state.dismissServerNotice);
  const bench = useBenchHeadsUp();

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
  if (bench) return <BenchBanner bench={bench} />;
  return null;
}

// The coming bench, or null when there is nothing to say about one.
//
// Unlike the other two banners, this one becomes due by the clock rather than
// by anything arriving: the window is broadcast once, hours ahead, and then
// simply sits in the future. So it carries its own tick — and only while there
// is an undismissed window still to come, because a timer that runs forever on
// every page for a thing that happens twice a month is not worth the wakeups.
function useBenchHeadsUp() {
  const bench = useGameStore((state) => state.botBench);
  const dismissedFrom = useGameStore((state) => state.dismissedBenchFrom);
  // An active window is not this banner's business: the ladder itself already
  // says every engine is benched and why, and a page cannot usefully carry the
  // same fact twice.
  const from = bench && !bench.active ? bench.fromUnixMs : undefined;
  const pending = from !== undefined && from !== dismissedFrom;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [pending]);

  if (!pending || from === undefined) return null;
  const lead = from - now;
  if (lead <= 0 || lead > BENCH_LEAD_MS) return null;
  return bench;
}

function BenchBanner({ bench }: { bench: BotBench }) {
  const dismiss = useGameStore((state) => state.dismissBotBench);
  const from = bench.fromUnixMs;
  const until = bench.untilUnixMs;
  if (from === undefined) return null;

  return (
    <View style={styles.banner}>
      <View style={styles.lines}>
        <Text style={styles.small}>
          The engines go offline {whenLabel(from)}
          {bench.reason ? ` for ${bench.reason}` : ''}
          {until === undefined ? '.' : `, and are back at ${clockLabel(until)}.`}
        </Text>
      </View>
      <Pressable
        accessibilityLabel="Dismiss engine bench notice"
        accessibilityRole="button"
        hitSlop={8}
        onPress={dismiss}
      >
        <Text style={styles.close}>×</Text>
      </Pressable>
    </View>
  );
}

// Both labels are in the reader's own zone, which is the point of sending
// instants rather than the server's wall clock. `untilLabel` on the server side
// is a written-out Eastern time and stays where it is — it belongs to the
// refusal, which quotes the event's own announcement back at somebody who tried
// to start a game.
const clockLabel = (unixMs: number) =>
  new Date(unixMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const whenLabel = (unixMs: number) => {
  const when = new Date(unixMs);
  const sameDay = when.toDateString() === new Date().toDateString();
  const time = clockLabel(unixMs);
  return sameDay
    ? `at ${time}`
    : `${when.toLocaleDateString(undefined, { weekday: 'long' })} at ${time}`;
};

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
            ? "Restarting. Reconnecting automatically…"
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

const styles = themedSheet(() => ({
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
  // The heads-up is quieter than the other two on purpose: it is the only one
  // that is neither happening now nor addressed to the reader personally.
  small: { ...type.meta, flex: 1, minWidth: 0, color: colors.textStrong },
  detail: { ...type.meta, color: colors.textMuted },
  close: { ...type.bodyStrong, color: colors.textMuted, paddingHorizontal: space.tight },
}));
