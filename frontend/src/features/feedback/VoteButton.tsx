import { Pressable, Text } from 'react-native';

import { colors, radius, space, themedSheet, type } from '@/theme';

// The tally, and the way to join it.
//
// One control rather than a count beside a button, because they are one thing:
// the number *is* the state of the button. Splitting them is how you end up
// with a row where the arrow says one thing and the figure beside it says
// another for a moment after a tap.
//
// Disabled rather than hidden when the visitor may not vote. A board whose
// tallies are invisible until you sign in is a board that gives a stranger no
// reason to — the count is the argument.

export interface VoteButtonProps {
  votes: number;
  youVoted?: boolean;
  /** Absent for a reader who may not vote: signed out, unverified, or muted. */
  onPress?: (() => void) | null;
  /** Why it is disabled, for a screen reader and for a long press. */
  refusal?: string;
  title: string;
  large?: boolean;
}

export default function VoteButton({
  votes,
  youVoted,
  onPress,
  refusal,
  title,
  large,
}: VoteButtonProps) {
  const allowed = Boolean(onPress);
  return (
    <Pressable
      accessibilityHint={allowed ? undefined : refusal}
      accessibilityLabel={
        youVoted
          ? `Remove your vote from ${title}. ${votes} so far`
          : `Vote for ${title}. ${votes} so far`
      }
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(youVoted), disabled: !allowed }}
      disabled={!allowed}
      onPress={onPress ?? undefined}
      style={({ pressed }) => [
        styles.button,
        large && styles.buttonLarge,
        youVoted && styles.buttonVoted,
        !allowed && styles.buttonQuiet,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.arrow, youVoted && styles.arrowVoted]}>▲</Text>
      <Text style={[styles.count, large && styles.countLarge, youVoted && styles.countVoted]}>
        {votes}
      </Text>
    </Pressable>
  );
}

const styles = themedSheet(() => ({
  button: {
    minWidth: 44,
    paddingVertical: space.snug,
    paddingHorizontal: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    gap: space.hair,
  },
  buttonLarge: { minWidth: 56, paddingVertical: space.small },
  buttonVoted: {
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurface,
  },
  // Not greyed into invisibility: the number still has to be readable, because
  // it is the reason a signed-out reader might sign in.
  buttonQuiet: { backgroundColor: colors.surfaceSunken },
  pressed: { opacity: 0.7 },
  arrow: { fontSize: 9, color: colors.textFaint },
  arrowVoted: { color: colors.accentText },
  count: { ...type.rowTitle, color: colors.text },
  countLarge: { ...type.cardTitle, color: colors.text },
  countVoted: { color: colors.accentTextStrong },
}));
