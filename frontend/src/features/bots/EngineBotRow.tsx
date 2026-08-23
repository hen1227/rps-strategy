import { StyleSheet, Text, View } from 'react-native';

import BotIcon from './BotIcon';
import { botIconUrl } from '@/store/api/bots';
import { colors } from '@/theme';
import type { ModeID } from '@/types/game';
import type { BotPresence } from '@/types/protocol';
import { Badge, GhostButton } from '@/ui/primitives';
import type { BadgeTone } from '@/ui/tones';

// One engine in the online-bot list.
//
// Built from the same row shape as the live-games table next to it, so the two
// read as siblings rather than as two people's ideas of a list.

const statusOf = (bot: BotPresence): { label: string; tone: BadgeTone } => {
  if (bot.busy) return { label: 'PLAYING', tone: 'live' };
  if (!bot.allowPublicPlay) return { label: 'PRIVATE', tone: 'neutral' };
  return { label: 'IDLE', tone: 'accent' };
};

export interface EngineBotRowProps {
  bot: BotPresence;
  /** The mode being offered, which decides the rating shown and availability. */
  modeId: ModeID;
  disabled?: boolean;
  onChallenge: (bot: BotPresence) => void;
}

export default function EngineBotRow({
  bot,
  modeId,
  disabled,
  onChallenge,
}: EngineBotRowProps) {
  const status = statusOf(bot);
  const plays = (bot.modes ?? []).join(' · ');
  const rating = bot.modeRatings?.[modeId] ?? bot.elo;
  // A bot that is busy, private, or does not play this mode cannot take the
  // game being offered, so the button says so instead of failing on press.
  const playsThisMode = !bot.modes?.length || bot.modes.includes(modeId);
  const unavailable = bot.busy || !bot.allowPublicPlay || !playsThisMode;

  return (
    <View style={styles.row}>
      <BotIcon name={bot.name} size={34} uri={botIconUrl(bot.botId, bot.iconSha256)} />
      <View style={styles.copy}>
        <Text numberOfLines={1} style={styles.name}>
          {bot.name} <Text style={styles.rating}>({rating})</Text>
        </Text>
        <Text numberOfLines={1} style={styles.meta}>
          {bot.engineName || 'engine'}
          {plays ? ` · ${plays}` : ''}
        </Text>
      </View>
      <Badge label={status.label} tone={status.tone} />
      <GhostButton
        accessibilityLabel={`Challenge ${bot.name}`}
        compact
        disabled={disabled || unavailable}
        label="PLAY"
        onPress={() => onChallenge(bot)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  copy: { flex: 1 },
  name: { color: colors.text, fontSize: 12, fontWeight: '800' },
  rating: { color: colors.textFaint, fontSize: 10, fontWeight: '600' },
  meta: { color: colors.textFaint, fontSize: 10, marginTop: 2 },
});
