import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import CapturedPieces, { type CaptureTray } from '@/features/board/CapturedPieces';
import { clock as clockColors, colors, players, radius } from '@/theme';
import {
  opposingColor,
  type ClockState,
  type GameStatus,
  type PlayerColor,
  type PlayerProfile,
  type SideColor,
} from '@/types/game';

const LOW_TIME_MS = 20_000;

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

/** The parts of a player the bar actually shows. A bot has no account id. */
type BarProfile = Pick<Partial<PlayerProfile>, 'username' | 'discord'>;

const profileName = (profile: BarProfile | null | undefined, fallback: string) => {
  const name = profile?.username?.trim();
  return name && name.toLowerCase() !== 'guest' ? name : fallback;
};

interface LiveClockProps {
  clock: ClockState | null | undefined;
  color: SideColor;
  gameStatus: GameStatus;
}

function LiveClock({ clock, color, gameStatus }: LiveClockProps) {
  const [now, setNow] = useState(() => Date.now());
  const isActive = gameStatus === 'InProgress' && clock?.activeColor === color;

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

  return (
    <View
      accessibilityLabel={`${color} clock, ${formatClock(remaining)}`}
      style={[
        styles.clock,
        isActive && styles.clockActive,
        isActive && isLow && styles.clockLow,
      ]}
    >
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
  /** The name to show when the profile has none — `You`, `Opponent`. */
  fallbackLabel?: string;
  gameStatus: GameStatus;
  isYou?: boolean;
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
  fallbackLabel,
  gameStatus,
  isYou,
  metaOverride,
  profile,
  turnColor,
}: PlayerBarProps) {
  const isActive =
    gameStatus === 'InProgress' &&
    (clock ? clock.activeColor === color : turnColor === color);
  const label = fallbackLabel ?? (isYou ? 'You' : 'Opponent');
  const discord = profile?.discord?.trim();
  const activity = metaOverride ?? (isActive ? 'Thinking' : color);

  return (
    <View style={[styles.playerBar, isActive && styles.playerBarActive]}>
      <View style={[styles.avatar, color === 'Red' ? styles.redAvatar : styles.blueAvatar]}>
        <Text style={styles.avatarText}>{color.slice(0, 1)}</Text>
      </View>
      <View style={styles.playerCopy}>
        <View style={styles.playerNameRow}>
          <Text style={styles.playerName} numberOfLines={1}>
            {profileName(profile, label)}
          </Text>
          {isYou && <Text style={styles.youLabel}>YOU</Text>}
          {Boolean(badge) && <Text style={styles.botLabel}>{badge}</Text>}
        </View>
        <Text style={[styles.playerMeta, isActive && styles.playerMetaActive]}>
          {discord ? `Discord: ${discord} · ${activity}` : activity}
        </Text>
      </View>
      <CapturedPieces
        advantage={captured?.advantage ?? 0}
        color={opposingColor(color)}
        tally={captured?.tally}
      />
      {Boolean(clock) && <LiveClock clock={clock} color={color} gameStatus={gameStatus} />}
    </View>
  );
}

const styles = StyleSheet.create({
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
});
