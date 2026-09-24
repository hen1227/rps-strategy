import { Text, View } from 'react-native';

import type { RecordedPlayer } from '@/engine/gameReview';
import { archivedRatingCaveat } from '@/features/ratings/scale';
import { colors, players as playerColors, radius, space, themedSheet, type } from '@/theme';
import PlayerLink from '@/ui/PlayerLink';
import { SIDE_COLORS, type PlayerColor, type SideColor } from '@/types/game';

// Who played which side, and what they were rated at the time.
//
// Both were things the review used to leave unsaid. The record card under this
// one says how the game ended in a result token, the board is drawn from one
// player's point of view, and the only thing on the screen that named a colour
// at all was the accuracy card — which belongs to RPSFish and disappears with
// it, so switching the engine off took the answer to "which one was Red" off
// the page entirely. That answer is the record's, not the engine's, which is
// why this card is beside `TerritoryMeter` and `QuietMoveMeter` in being
// drawn either way rather than beside `AccuracyCard` in being gated.
//
// The rating is the one the player carried *into* this game, because that is
// the question a record answers: how strong were these two when they sat down.
// What it moved to is the smaller line under it.

/** How a rating reads when the record has no number for it. */
const missingRating = (ranked: boolean) => (ranked ? 'Not recorded' : 'Unrated');

/** A rating change, written the way the record's own `RatingDiff` tag is. */
const signed = (change: number) => (change > 0 ? `+${change}` : String(change));

export interface PlayersCardProps {
  /** Who the record says played each side. */
  players: Record<SideColor, RecordedPlayer>;
  /** Whether the game moved anybody's rating. */
  ranked: boolean;
  /**
   * The scale the ratings are on, straight from the record. Anything that is
   * not today's is called out rather than quietly printed.
   */
  ratingSystem: string | null;
  /** The side the person reading this played, marked `YOU`. */
  viewerColor?: PlayerColor | null;
}

export default function PlayersCard({
  players: profiles,
  ranked,
  ratingSystem,
  viewerColor,
}: PlayersCardProps) {
  const rated = SIDE_COLORS.some((color) => profiles[color]?.elo !== null);
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>PLAYERS</Text>
      {SIDE_COLORS.map((color) => {
        const profile = profiles[color];
        const elo = profile?.elo ?? null;
        const after = profile?.eloAfter ?? null;
        const name = profile?.name || color;
        return (
          <View key={color} style={styles.side}>
            {/*
              The same square with the side's initial in it that a live board
              puts a player's name beside, so the association is learned once.
              Hidden from a screen reader rather than labelled: it is the
              colour drawn, and the colour is already written in words below
              the name — a label here would only read it out twice.
            */}
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[styles.avatar, color === 'Red' ? styles.redAvatar : styles.blueAvatar]}
            >
              <Text style={styles.avatarText}>{color.slice(0, 1)}</Text>
            </View>
            <View style={styles.identity}>
              <View style={styles.nameRow}>
                {/*
                  Addressed by user id where the record has one: a name off a
                  pasted PGN is whatever the file said, and `PlayerLink` draws a
                  name with no account behind it as plain text.
                */}
                <PlayerLink
                  handle={profile?.userId || name}
                  name={name}
                  numberOfLines={1}
                  style={styles.name}
                />
                {viewerColor === color ? <Text style={styles.youLabel}>YOU</Text> : null}
              </View>
              {/* The colour in words as well as in the square beside it. */}
              <Text style={styles.colorName}>{color}</Text>
            </View>
            <View style={styles.ratingBlock}>
              <Text style={[styles.rating, elo === null && styles.ratingMissing]}>
                {elo === null ? missingRating(ranked) : elo}
              </Text>
              {elo !== null && after !== null && after !== elo ? (
                <Text
                  style={[
                    styles.ratingChange,
                    after > elo ? styles.ratingUp : styles.ratingDown,
                  ]}
                >
                  {signed(after - elo)} → {after}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
      {/*
        Nothing to footnote when neither side carries a number: the two rows
        have already said so in the place the number would have been.

        The wording is `features/ratings/scale`'s rather than this card's,
        because what a stored rating is worth is a property of the scale and not
        of the screen showing it — and because the interesting case, a record
        from before the rebuild whose numbers are on the old 1200-centred scale,
        is one this card has no way to recognise on its own.
      */}
      {rated ? <Text style={styles.note}>{archivedRatingCaveat(ratingSystem)}</Text> : null}
    </View>
  );
}

const styles = themedSheet(() => ({
  card: {
    gap: space.small,
    padding: 13,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  eyebrow: { ...type.eyebrow, color: colors.textFaint },
  side: { flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.medium,
    borderWidth: 1,
  },
  redAvatar: {
    backgroundColor: playerColors.Red.surface,
    borderColor: playerColors.Red.border,
  },
  blueAvatar: {
    backgroundColor: playerColors.Blue.surface,
    borderColor: playerColors.Blue.border,
  },
  avatarText: { color: colors.textStrong, fontSize: 13, fontWeight: '900' },
  // `minWidth: 0` rather than `flex: 1` alone: without it a long engine name
  // sets the column's floor and pushes the rating off the card.
  identity: { flex: 1, minWidth: 0, paddingHorizontal: 9 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flexShrink: 1, color: colors.text, fontSize: 13, fontWeight: '800' },
  youLabel: { ...type.label, color: colors.accentBright, fontSize: 7 },
  colorName: { color: colors.textFaint, fontSize: 9, fontWeight: '700', marginTop: 2 },
  // Held to the right and allowed to keep its width, so the name gives way
  // first — a truncated name is still a name, a truncated rating is a
  // different number.
  ratingBlock: { alignItems: 'flex-end', flexShrink: 0 },
  rating: { color: colors.accentBright, fontSize: 17, fontWeight: '900' },
  ratingMissing: { color: colors.textMuted, fontSize: 10, fontWeight: '800' },
  ratingChange: { fontSize: 9, fontWeight: '800', marginTop: 1 },
  ratingUp: { color: colors.accentSoft },
  ratingDown: { color: colors.dangerText },
  note: { color: colors.textFaint, fontSize: 8, lineHeight: 12 },
}));
