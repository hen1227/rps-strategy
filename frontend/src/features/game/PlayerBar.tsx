import { useEffect, useRef, useState } from 'react';
import {
  Animated as NativeAnimated,
  Easing,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import CapturedPieces, { TRAY_HEIGHT, type CaptureTray } from '@/features/board/CapturedPieces';
import { useWideLayout } from '@/hooks/useBoardLayout';
import type { TimeExtension } from '@/store/clockSelectors';
import PlayerLink from '@/ui/PlayerLink';
import TitleTag from '@/ui/TitleTag';
import { clock as clockColors, colors, players, radius, themedSheet } from '@/theme';
import {
  opposingColor,
  type ClockState,
  type GameStatus,
  type PlayerColor,
  type PlayerProfile,
  type SideColor,
} from '@/types/game';

const LOW_TIME_MS = 20_000;

// Long enough to be read, short enough that a player in time trouble is not
// waiting on it: the chip has left the clock before the next second ticks.
const BONUS_MS = 900;

// Narrower than this, the captured pieces leave the name's line for the one
// under it. Beside the name they are paid for out of the name's room, and on a
// phone a title, a name and YOU already fill that line before a single piece
// has been taken. Under the name they share a line with one word, and the bar
// stays as tall as it was.
const COMPACT_BELOW = 520;

// How narrow the word beside a compact tray may get before it is dropped
// rather than cut. About the width of `Thinking`, so the common word is shown
// whole or not at all, and a long bot line keeps its level until the tray needs
// that room too. Dropped, it costs nothing a stub like "T…" would have kept:
// the bar's highlight and the avatar's letter say the same thing.
const ACTIVITY_FLOOR = 40;

const formatClock = (milliseconds: number) => {
  const safeMilliseconds = Math.max(0, milliseconds);
  if (safeMilliseconds < LOW_TIME_MS) {
    const seconds = Math.floor(safeMilliseconds / 1000);
    const tenths = Math.floor((safeMilliseconds % 1000) / 100);
    return `0:${String(seconds).padStart(2, '0')}.${tenths}`;
  }

  const totalSeconds = Math.ceil(safeMilliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const remainingForColor = (clock: ClockState | null | undefined, color: SideColor) =>
  color === 'Red' ? clock?.redRemainingMs ?? 0 : clock?.blueRemainingMs ?? 0;

/**
 * The parts of a player the bar actually shows. A bot has no account id.
 *
 * Not the Discord handle, which the bar used to print under the name. It
 * crowded the line on a phone, and a board in front of both players and every
 * spectator is more exposure than a handle needs. Their page still has it.
 */
type BarProfile = Pick<Partial<PlayerProfile>, 'username' | 'title'>;

const profileName = (profile: BarProfile | null | undefined, fallback: string) => {
  const name = profile?.username?.trim();
  return name && name.toLowerCase() !== 'guest' ? name : fallback;
};

interface LiveClockProps {
  clock: ClockState | null | undefined;
  color: SideColor;
  gameStatus: GameStatus;
  /** The bonus both clocks just gained, if one just landed. */
  extension?: TimeExtension | null;
}

/**
 * The three minutes landing, on a clock that is about to read three minutes
 * higher without having been touched.
 *
 * One value runs the whole thing from 0 to 1 and each part reads its own shape
 * out of it, which is why the driver is linear: the eased curves belong to the
 * pop, the wash, and the rise separately, and an eased driver would bend all
 * three at once.
 *
 * It plays on the instant *changing*, not on there being one. That is what
 * lets the store keep the last extension around forever — mounting mid-game,
 * or carrying one across into the next game, finds the instant already seen
 * and stays still.
 */
function useBonusFlourish(extension: TimeExtension | null | undefined) {
  const flourish = useRef(new NativeAnimated.Value(0)).current;
  const at = extension?.at ?? null;
  const played = useRef(at);

  useEffect(() => {
    if (at === null || at === played.current) return undefined;
    played.current = at;
    flourish.setValue(0);
    const animation = NativeAnimated.timing(flourish, {
      toValue: 1,
      duration: BONUS_MS,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [at, flourish]);

  return flourish;
}

function LiveClock({ clock, color, extension, gameStatus }: LiveClockProps) {
  const [now, setNow] = useState(() => Date.now());
  const isActive = gameStatus === 'InProgress' && clock?.activeColor === color;
  const flourish = useBonusFlourish(extension);

  useEffect(() => {
    setNow(Date.now());
    if (!isActive) return undefined;

    const interval = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, [clock?.activeColor, clock?.updatedAtUnixMs, isActive]);

  const snapshot = remainingForColor(clock, color);
  const elapsed = isActive ? Math.max(0, now - (clock?.updatedAtUnixMs ?? now)) : 0;
  const remaining = Math.max(0, snapshot - elapsed);
  const isLow = remaining < LOW_TIME_MS;
  // Measured rather than assumed, so the chip names the bonus the clocks were
  // actually given instead of a three minutes this file believes in.
  const bonus = extension ? `+${formatClock(extension.bonusMs)}` : null;

  return (
    <View style={styles.clockSlot}>
      <NativeAnimated.View
        accessibilityLabel={`${color} clock, ${formatClock(remaining)}`}
        style={[
          styles.clock,
          isActive && styles.clockActive,
          isActive && isLow && styles.clockLow,
          {
            transform: [
              {
                scale: flourish.interpolate({
                  inputRange: [0, 0.14, 0.34, 1],
                  outputRange: [1, 1.06, 1, 1],
                }),
              },
            ],
          },
        ]}
      >
        {/*
          Under the dot and the digits, so the face lights up behind the time
          rather than hiding the one thing anybody is looking at.
        */}
        <NativeAnimated.View
          pointerEvents="none"
          style={[
            styles.clockWash,
            isActive && styles.clockWashLit,
            {
              opacity: flourish.interpolate({
                inputRange: [0, 0.08, 0.4, 0.85, 1],
                outputRange: [0, 1, 0.65, 0, 0],
              }),
            },
          ]}
        />
        <View
          style={[
            styles.clockPulse,
            isActive && styles.clockPulseActive,
            isActive && isLow && styles.clockPulseLow,
          ]}
        />
        <Text
          style={[
            styles.clockText,
            isActive && styles.clockTextActive,
            isActive && isLow && styles.clockTextLow,
          ]}
        >
          {formatClock(remaining)}
        </Text>
      </NativeAnimated.View>
      {/* Outside the pill, so the pop above does not carry the chip with it. */}
      {Boolean(bonus) && (
        <NativeAnimated.View
          pointerEvents="none"
          style={[
            styles.clockBonus,
            {
              opacity: flourish.interpolate({
                inputRange: [0, 0.1, 0.62, 1],
                outputRange: [0, 1, 1, 0],
              }),
              transform: [
                {
                  translateY: flourish.interpolate({
                    inputRange: [0, 0.3, 1],
                    outputRange: [10, -4, -12],
                  }),
                },
                {
                  scale: flourish.interpolate({
                    inputRange: [0, 0.2, 1],
                    outputRange: [0.82, 1, 1],
                  }),
                },
              ],
            },
          ]}
        >
          <Text style={styles.clockBonusText}>{bonus}</Text>
        </NativeAnimated.View>
      )}
    </View>
  );
}

// Shared by the live match and local match viewers. A missing clock means the
// active side comes from `turnColor`, which is how bot games and replays work.
export interface PlayerBarProps {
  /** A short tag beside the name: `BOT`, `SPECTATING`. */
  badge?: string | null;
  /** What this player has taken off the board. */
  captured?: CaptureTray | null;
  /** Absent for a bot game or a replay, which have no clock. */
  clock?: ClockState | null;
  color: SideColor;
  /**
   * The three minutes both clocks just gained. Passed to both bars of a game,
   * because an extension is granted to both sides and should look like it.
   */
  extension?: TimeExtension | null;
  /** The name to show when the profile has none — `You`, `Opponent`. */
  fallbackLabel?: string;
  gameStatus: GameStatus;
  isYou?: boolean;
  /**
   * Draw the name as a link to that player's page.
   *
   * For a spectator, who came to watch two other people and has every reason
   * to ask who they are. Off by default, and deliberately so for the two
   * people playing: the app holds a player at their own live board — see the
   * rule in `app/_layout.tsx` — so a link out of it would navigate and be
   * bounced straight back, which reads as a name that does nothing. A bot game
   * and a shared board leave it off too, because the names there are a
   * practice-ladder profile and whoever is sitting at this browser, and
   * neither has a page.
   */
  linkName?: boolean;
  /** Replaces the `Thinking`/colour line under the name. */
  metaOverride?: string | null;
  profile?: BarProfile | null;
  /** Whose turn it is, for a game with no clock to say. */
  turnColor?: PlayerColor | null;
}

export default function PlayerBar({
  badge,
  captured,
  clock,
  color,
  extension,
  fallbackLabel,
  gameStatus,
  isYou,
  linkName,
  metaOverride,
  profile,
  turnColor,
}: PlayerBarProps) {
  const isActive =
    gameStatus === 'InProgress' &&
    (clock ? clock.activeColor === color : turnColor === color);
  const label = fallbackLabel ?? (isYou ? 'You' : 'Opponent');
  const activity = metaOverride ?? (isActive ? 'Thinking' : color);

  // Measured on the bar rather than read off the window, because the bar is
  // as wide as the board it sits against, and a wide window with a short board
  // has bars as cramped as a phone's. Until the bar has been measured, the
  // screen's own layout is the guess, so neither a phone nor a desktop
  // rearranges its bars once they have been drawn. Safe against oscillating:
  // the bar fills its parent either way, so the layout cannot change the width
  // it reads.
  const wideLayout = useWideLayout();
  const [barWidth, setBarWidth] = useState<number | null>(null);
  const measureBar = (event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.width);
    setBarWidth((current) => (current === measured ? current : measured));
  };
  const compact = barWidth === null ? !wideLayout : barWidth < COMPACT_BELOW;
  // Compact, the word is given whatever the tray leaves, so its own width is
  // that leftover. Hidden rather than removed, so it goes on being measured
  // and comes back by itself if the room does.
  const [activityWidth, setActivityWidth] = useState<number | null>(null);
  const measureActivity = (event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.width);
    setActivityWidth((current) => (current === measured ? current : measured));
  };
  const activityCrowded = compact && activityWidth !== null && activityWidth < ACTIVITY_FLOOR;

  const activityLine = (
    <Text
      numberOfLines={compact ? 1 : undefined}
      onLayout={compact ? measureActivity : undefined}
      style={[
        styles.playerMeta,
        compact && styles.playerMetaCompact,
        activityCrowded && styles.playerMetaCrowded,
        isActive && styles.playerMetaActive,
      ]}
    >
      {activity}
    </Text>
  );
  const tray = (
    <CapturedPieces
      advantage={captured?.advantage ?? 0}
      color={opposingColor(color)}
      tally={captured?.tally}
    />
  );

  return (
    <View onLayout={measureBar} style={[styles.playerBar, isActive && styles.playerBarActive]}>
      <View style={[styles.avatar, color === 'Red' ? styles.redAvatar : styles.blueAvatar]}>
        <Text style={styles.avatarText}>{color.slice(0, 1)}</Text>
      </View>
      <View style={styles.playerCopy}>
        <View style={styles.playerNameRow}>
          {/*
            Before the name, the way a chess pairing card writes it. Renders
            nothing when there is no title, which is most players.
          */}
          <TitleTag size="medium" title={profile?.title} />
          {/*
            Addressed by the username rather than by the name on screen: the
            fallback label is `Red player` or `You`, and an unnamed guest reads
            as one of those. `PlayerLink` draws a name with no account behind
            it as the plain text it already was.
          */}
          <PlayerLink
            handle={profile?.username ?? ''}
            name={profileName(profile, label)}
            numberOfLines={1}
            plain={!linkName}
            style={styles.playerName}
          />
          {isYou && <Text style={styles.youLabel}>YOU</Text>}
          {Boolean(badge) && <Text style={styles.botLabel}>{badge}</Text>}
        </View>
        {compact ? (
          // The pieces keep the width they need and the word beside them takes
          // the rest, so a long bot line gives way before the tray does.
          <View style={styles.metaRow}>
            {activityLine}
            <View style={styles.metaTray}>{tray}</View>
          </View>
        ) : (
          activityLine
        )}
      </View>
      {compact ? null : tray}
      {Boolean(clock) && (
        <LiveClock clock={clock} color={color} extension={extension} gameStatus={gameStatus} />
      )}
    </View>
  );
}

const styles = themedSheet(() => ({
  playerBar: {
    width: '100%',
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 5,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  playerBarActive: {
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurface,
  },
  avatar: {
    width: 35,
    height: 35,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.medium,
    borderWidth: 1,
  },
  redAvatar: { backgroundColor: players.Red.surface, borderColor: players.Red.border },
  blueAvatar: { backgroundColor: players.Blue.surface, borderColor: players.Blue.border },
  avatarText: { color: colors.textStrong, fontSize: 14, fontWeight: '900' },
  playerCopy: { flex: 1, minWidth: 0, paddingHorizontal: 9 },
  playerNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  playerName: { maxWidth: '75%', color: colors.text, fontSize: 13, fontWeight: '800' },
  youLabel: {
    color: colors.accentBright,
    fontSize: 7,
    fontWeight: '900',
    letterSpacing: 1,
  },
  botLabel: {
    color: colors.goldBright,
    fontSize: 7,
    fontWeight: '900',
    letterSpacing: 1,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: radius.small,
    backgroundColor: colors.goldSurface,
  },
  playerMeta: { color: colors.textFaint, fontSize: 9, fontWeight: '700', marginTop: 2 },
  playerMetaActive: { color: colors.accentSoft },
  // As tall as a tray whether or not anything has been taken yet, so the first
  // capture does not nudge the name up to make room for it.
  metaRow: {
    minHeight: TRAY_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  playerMetaCompact: { flex: 1, minWidth: 0, marginTop: 0 },
  playerMetaCrowded: { opacity: 0 },
  // Its own width, up to the whole line: past that the tray wraps inside
  // itself rather than running under the clock.
  metaTray: { flexShrink: 0, maxWidth: '100%' },
  // The pill's own box, held still so the pop below cannot shove the row
  // around and the chip has an edge to rise from.
  clockSlot: { position: 'relative' },
  clock: {
    minWidth: 100,
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 7,
    paddingHorizontal: 11,
    borderRadius: radius.small,
    backgroundColor: clockColors.idleSurface,
  },
  clockActive: { backgroundColor: clockColors.activeSurface },
  clockLow: { backgroundColor: clockColors.lowSurface },
  clockWash: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.small,
    backgroundColor: clockColors.bonusWash,
  },
  clockWashLit: { backgroundColor: clockColors.bonusWashLit },
  clockBonus: {
    position: 'absolute',
    right: 4,
    bottom: '100%',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: clockColors.bonusChipBorder,
    backgroundColor: clockColors.bonusChip,
  },
  clockBonusText: {
    color: clockColors.bonusChipText,
    fontSize: 12,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  clockPulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: clockColors.idlePulse,
  },
  clockPulseActive: { backgroundColor: clockColors.activePulse },
  clockPulseLow: { backgroundColor: clockColors.lowPulse },
  clockText: {
    color: clockColors.idleText,
    fontSize: 22,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.6,
  },
  clockTextActive: { color: clockColors.activeText },
  clockTextLow: { color: clockColors.lowText },
}));
