import { Pressable, StyleSheet, Text, View } from 'react-native';

import BotIcon from './BotIcon';
import { engineElo, engineIsAvailable, engineStatus } from '@/features/live/liveSelectors';
import { botIconUrl } from '@/store/api/bots';
import { colors, radius, space, themedSheet, type } from '@/theme';
import type { ModeID } from '@/types/game';
import type { BotPresence } from '@/types/protocol';
import PlayerLink from '@/ui/PlayerLink';
import TitleTag from '@/ui/TitleTag';
import { Badge, GhostButton } from '@/ui/primitives';

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

/**
 * How wide a card wants to be, before `flexGrow` divides up what the row has
 * left over.
 *
 * Exported because the grid holding these has to pad its last row with fillers
 * of exactly this basis — see the note there — and a second copy of the number
 * is a silent way for the two to drift apart.
 */
export const ENGINE_CARD_BASIS = 214;

export interface EngineBotCardProps {
  bot: BotPresence;
  /** The mode being offered, which decides the rating shown and availability. */
  modeId: ModeID;
  /** This account registered this engine, which tints the card. */
  mine?: boolean;
  /** Which side of the pit form this engine is on, or absent for neither. */
  pitRole?: 'first' | 'second' | null;
  /**
   * The engine already in the form, when this card is not one of the two. Named
   * on the button, so the press that completes a pairing says who it is
   * against rather than repeating what the control is called.
   */
  pitOpponentName?: string | null;
  /** True while a challenge cannot be sent at all — disconnected, or mid-game. */
  challengeDisabled?: boolean;
  onChallenge: (bot: BotPresence) => void;
  onPit: (bot: BotPresence) => void;
}

/**
 * The pit button, which is what this card is mostly for.
 *
 * Its own pressable rather than a `PrimaryButton` for two reasons. It is the
 * one control on the card with a selected state, and a primary button has no
 * way to look chosen — filled while it is an invitation, outlined in the same
 * accent once the engine is in. And its label carries another engine's name,
 * which has to be allowed to truncate: `mocca-v2-20260907-g1360` would
 * otherwise widen the card it is sitting on.
 *
 * That label is relational, and it is the half of the change that is not about
 * size. `VS` alone names the button rather than saying what pressing it does,
 * so once one side is taken every other card names the engine its press would
 * fight. The question "how do I put two of these against each other" is
 * answered on the control, at the moment it becomes the question, instead of in
 * a sentence above the grid that nobody reads.
 */
function PitButton({
  disabled,
  label,
  onPress,
  opponent,
  role,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  /** The engine a press would enter this one against, when a side is taken. */
  opponent?: string | null;
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
      <Text numberOfLines={1} style={[styles.pitText, Boolean(role) && styles.pitTextOn]}>
        {role === 'first'
          ? 'FIRST ✓'
          : role === 'second'
            ? 'SECOND ✓'
            : opponent
              ? `VS ${opponent.toUpperCase()}`
              : 'PICK FOR VS'}
      </Text>
    </Pressable>
  );
}

export default function EngineBotCard({
  bot,
  modeId,
  mine,
  pitRole = null,
  pitOpponentName = null,
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
          {/*
            The engine's own tag, in the row with its name rather than down
            among the badges below. It is an identity mark and not a status: a
            crown says which engine this is, the way a title in front of a
            player's name does, and the badges say what it is doing right now.

            The name beside it leads to the engine's own page, which is where
            its rating history, its games and its owner are. It is the only
            thing on the card that could honestly lead there — the two buttons
            below are both about starting a game.
          */}
          <View style={styles.nameRow}>
            <TitleTag title={bot.title} />
            <PlayerLink name={bot.name} numberOfLines={1} style={styles.name} />
          </View>
          {/* The build after the name, and only when the engine declared one:
              most do not, and an empty separator would read as a missing
              value rather than as an absent one. */}
          <Text numberOfLines={1} style={styles.meta}>
            {bot.engineName || 'engine'}
            {bot.engineVersion ? ` ${bot.engineVersion}` : ''}
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

      {/*
        Two actions, and the wide one is the series. Pitting two engines against
        each other is what this page has a panel for and what most of the people
        on it came to do; challenging one yourself is the errand that can also be
        run from the lobby. The card used to give the whole width to PLAY and 54
        points to VS, which said the opposite loudly enough that the sentence
        above the grid — the one explaining which button did what — was doing
        work the buttons should have been doing themselves.
      */}
      <View style={styles.actions}>
        <PitButton
          disabled={!pittable}
          label={
            pitRole
              ? `Take ${bot.name} out of the series`
              : pitOpponentName
                ? `Put ${bot.name} in a series against ${pitOpponentName}`
                : `Put ${bot.name} in a series against another engine`
          }
          onPress={() => onPit(bot)}
          opponent={pitOpponentName}
          role={pitRole}
        />
        <GhostButton
          accessibilityLabel={`Challenge ${bot.name} yourself`}
          compact
          disabled={challengeDisabled || unavailable}
          label="PLAY ▶"
          onPress={() => onChallenge(bot)}
        />
      </View>
    </View>
  );
}

const styles = themedSheet(() => ({
  card: {
    // Three or four across a desktop page, two on a tablet, one on a phone,
    // without a breakpoint: the basis is the width a card wants and `flexGrow`
    // divides whatever the row has left. The column this page actually gets,
    // between the shell's sidebar and its live rail, is a good deal narrower
    // than the page's 1180 cap suggests — 784 points at a 1400-point window —
    // so this is sized to give three there and four on a wide monitor.
    flexBasis: ENGINE_CARD_BASIS,
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
  // `minWidth: 0` again on the row and on the name inside it, for the reason
  // the copy column has it: the tag is fixed width and the name is one long
  // unbreakable word, so without it the name pushes the tag out of the card
  // rather than truncating.
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.hair, minWidth: 0 },
  name: { ...type.rowTitle, color: colors.text, flexShrink: 1, minWidth: 0 },
  meta: { ...type.meta, fontSize: 10, color: colors.textDim, marginTop: space.hair },
  author: { ...type.meta, fontSize: 10, color: colors.textFaint },
  rating: { fontSize: 15, fontWeight: '900', color: colors.textSubtle },
  ratingMine: { color: colors.goldSoft },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.tight },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  // A filled accent button, taking whatever PLAY leaves. Its height is
  // `GhostButton`'s compact 34 rather than `PrimaryButton`'s 36: these two sit
  // side by side on a card, and lining up with the button it is next to matters
  // more than lining up with a button on another panel.
  pit: {
    flex: 1,
    minWidth: 0,
    minHeight: 34,
    paddingHorizontal: space.medium,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  // Chosen rather than offered: the same accent, drawn as an outline. The card
  // around it is tinted too (see cardPitted), so all this has to do is stop
  // looking like something asking to be pressed.
  pitOn: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceStrong },
  pitText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.9, color: colors.textStrong },
  pitTextOn: { color: colors.accentTextStrong },
  faded: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
}));
