import { Pressable, StyleSheet, Text, View } from 'react-native';

import BotIcon from './BotIcon';
import { engineElo, engineIsAvailable, engineStatus } from '@/features/live/liveSelectors';
import { botIconUrl } from '@/store/api/bots';
import { colors, radius, space, type } from '@/theme';
import type { ModeID } from '@/types/game';
import type { BotPresence } from '@/types/protocol';
import { Badge, PrimaryButton } from '@/ui/primitives';

// One connected engine, as a card.
//
// This was a 54px table row, which is the right shape for eight of something and
// the wrong shape for the twelve-or-more that are online on an ordinary evening:
// a column of near-identical rows reads as a log rather than as a roster, and it
// buries the two things that distinguish one engine from the next — who wrote it
// and how strong it is — in a dim second line. A card gives the rating somewhere
// it can be read at a glance and the author a line of its own.
//
// It also carries the pit control, which is the other half of why this stopped
// being a row. The form that fights two engines used to list every bot's name
// twice in chips of its own, immediately under a list of the same names; two
// buttons on the cards that are already here say the same thing once.

export interface EngineBotCardProps {
  bot: BotPresence;
  /** The mode being offered, which decides the rating shown and availability. */
  modeId: ModeID;
  /** This account registered this engine, which tints the card. */
  mine?: boolean;
  /** Which side of the pit form this engine is on, or absent for neither. */
  pitRole?: 'first' | 'second' | null;
  /** True while a challenge cannot be sent at all — disconnected, or mid-game. */
  challengeDisabled?: boolean;
  onChallenge: (bot: BotPresence) => void;
  onPit: (bot: BotPresence) => void;
}

/**
 * The pit toggle.
 *
 * Its own pressable rather than a `GhostButton`, because it is the one control
 * on the card with a selected state, and a ghost button has no way to look
 * chosen. Reads FIRST or SECOND once it is, so the card says which side of the
 * run it is on without anybody having to look back at the form.
 */
function PitToggle({
  disabled,
  label,
  onPress,
  role,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  role: 'first' | 'second' | null;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled), selected: Boolean(role) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pit,
        Boolean(role) && styles.pitOn,
        disabled && styles.faded,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.pitText, Boolean(role) && styles.pitTextOn]}>
        {role === 'first' ? 'FIRST' : role === 'second' ? 'SECOND' : 'VS'}
      </Text>
    </Pressable>
  );
}

export default function EngineBotCard({
  bot,
  modeId,
  mine,
  pitRole = null,
  challengeDisabled,
  onChallenge,
  onPit,
}: EngineBotCardProps) {
  const status = engineStatus(bot);
  const rating = engineElo(bot, modeId);
  // A bot that is busy, private, shutting down, or does not play this mode
  // cannot take the game being offered, so the button says so instead of
  // failing on press. The first three come from the same place the badge does.
  const playsThisMode = !bot.modes?.length || bot.modes.includes(modeId);
  const unavailable = !engineIsAvailable(bot) || !playsThisMode;
  // What the series form can accept, which is a different question: a private
  // engine is enterable by its owner, and the server settles who that is. Only
  // the three states in which no game can start at all are refused here.
  const pittable = !bot.busy && !bot.draining && !bot.benched;

  return (
    <View style={[styles.card, mine && styles.cardMine, Boolean(pitRole) && styles.cardPitted]}>
      <View style={styles.head}>
        <BotIcon name={bot.name} size={34} uri={botIconUrl(bot.botId, bot.iconSha256)} />
        {/*
          `minWidth: 0` on the copy column, not just `numberOfLines`: an engine
          name like `mocca-v2-20260907-g1360` is one unbreakable word, and a flex
          item will not shrink below one of those without it — the rating beside
          it gets pushed off the card instead.
        */}
        <View style={styles.copy}>
          <Text numberOfLines={1} style={styles.name}>
            {bot.name}
          </Text>
          <Text numberOfLines={1} style={styles.meta}>
            {bot.engineName || 'engine'}
          </Text>
          <Text numberOfLines={1} style={styles.author}>
            {bot.engineAuthor ? `by ${bot.engineAuthor}` : 'author unknown'}
          </Text>
        </View>
        <Text style={[styles.rating, mine && styles.ratingMine]}>{rating}</Text>
      </View>

      <View style={styles.badges}>
        <Badge label={status.label} tone={status.tone} />
        {mine ? <Badge label="YOURS" tone="gold" /> : null}
        {/*
          Only when it matters. An engine that plays the mode on offer has
          nothing to say here, and one that does not needs to say what it does
          play — otherwise its greyed-out PLAY button is unexplained.
        */}
        {playsThisMode ? null : <Badge label={(bot.modes ?? []).join(' · ')} tone="neutral" />}
      </View>

      <View style={styles.actions}>
        <View style={styles.play}>
          <PrimaryButton
            accessibilityLabel={`Challenge ${bot.name}`}
            compact
            disabled={challengeDisabled || unavailable}
            fullWidth
            label="PLAY ▶"
            onPress={() => onChallenge(bot)}
          />
        </View>
        <PitToggle
          disabled={!pittable}
          label={
            pitRole
              ? `Take ${bot.name} out of the series`
              : `Put ${bot.name} in a series against another engine`
          }
          onPress={() => onPit(bot)}
          role={pitRole}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    // Four across a desktop page, two on a tablet, one on a phone, without a
    // breakpoint: the basis is the width a card wants and `flexGrow` divides
    // whatever the row has left. 214 rather than a rounder number because four
    // of them plus three gaps has to clear a padded panel in the ~1000pt column
    // this page gets between the shell's sidebar and its live rail — at 232 it
    // missed by 17 points and dropped to three across with a third of the row
    // empty.
    flexBasis: 214,
    flexGrow: 1,
    minWidth: 0,
    padding: space.small,
    gap: space.snug,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceSunken,
  },
  // Engines this account registered. Gold rather than the accent green, which
  // the pit selection below already owns — the two states are independent and
  // an engine can be in both at once.
  cardMine: { borderColor: colors.goldBorder, backgroundColor: colors.goldSurfaceDeep },
  cardPitted: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceQuiet },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.small },
  copy: { flex: 1, minWidth: 0 },
  name: { ...type.rowTitle, color: colors.text },
  meta: { ...type.meta, fontSize: 10, color: colors.textDim, marginTop: space.hair },
  author: { ...type.meta, fontSize: 10, color: colors.textFaint },
  rating: { fontSize: 15, fontWeight: '900', color: colors.textSubtle },
  ratingMine: { color: colors.goldSoft },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.tight },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  play: { flex: 1, minWidth: 0 },
  pit: {
    minWidth: 54,
    paddingHorizontal: space.small,
    paddingVertical: space.snug,
    alignItems: 'center',
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceMuted,
  },
  pitOn: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceStrong },
  pitText: { ...type.label, color: colors.textMuted },
  pitTextOn: { color: colors.accentTextStrong },
  faded: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
});
