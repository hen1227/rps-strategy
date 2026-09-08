// The small pieces the opening-book screens share.
//
// Naming and curating are three surfaces now -- the line you are looking at,
// the moves in front of you, and the queue of everything still unnamed -- and
// they draw the same dot, the same bar and the same input. They live here so
// the three read as one screen rather than three that drifted.

import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { winPercent } from '@/engine/gameReview';
import type { OpeningNameSuggestion } from '@/engine/openingBook';
import { colors, players, radius, space } from '@/theme';
import { GhostButton, PrimaryButton } from '@/ui/primitives';
import {
  FIRST_TO_MOVE,
  opposingColor,
  type ModeID,
  type SideColor,
} from '@/types/game';

import type { OpeningCurator } from './useOpeningCurator';

/**
 * A score past this is a forced result rather than an assessment.
 *
 * RPSFish's own threshold (`search.rs`), which is what the book's scores are
 * written on: past it the number counts plies to the end, not centipawns.
 */
export const FORCED_RESULT = 29_000;

export const forcedLabel = (score: number) =>
  score >= FORCED_RESULT ? 'FORCED WIN' : score <= -FORCED_RESULT ? 'FORCED LOSS' : null;

export const sideOf = (turn: string | undefined, ply: number): SideColor =>
  turn === 'Blue' || turn === 'Red'
    ? turn
    : ply % 2 === 0
      ? FIRST_TO_MOVE
      : opposingColor(FIRST_TO_MOVE);

/**
 * The book scores every position for whoever is to move, so a bar that always
 * fills from Red's side has to turn Blue's numbers around first.
 */
export const redScore = (score: number, turn: SideColor) => (turn === 'Blue' ? -score : score);

/**
 * A date the pre-rendered build and the browser agree on.
 *
 * Deliberately not a locale format, and deliberately not "three days ago":
 * every page here is rendered once in Node at build time, and React throws the
 * whole page away when the first client render disagrees with it.
 */
export const publishedOn = (unixMs: number | undefined) =>
  unixMs ? new Date(unixMs).toISOString().slice(0, 10) : null;

export function TurnDot({ turn }: { turn: SideColor }) {
  return <View style={[ui.turnDot, { backgroundColor: players[turn].strong }]} />;
}

/**
 * How much of the point the side to move expects, drawn as one bar.
 *
 * Measured from the middle rather than from zero. Openings are close by
 * definition — twenty candidate moves here span three percent of expected
 * score — and a bar that filled from the left would be twenty identical
 * half-full bars. From the centre, the same three percent is the difference
 * between leaning one way and leaning the other, which is the thing worth
 * seeing.
 */
export function ExpectationBar({
  modeId,
  score,
  turn,
}: {
  modeId: ModeID;
  score: number;
  turn: SideColor;
}) {
  const share = Math.max(1, Math.min(99, winPercent(score, modeId)));
  const ahead = share >= 50;
  const owner = ahead ? turn : opposingColor(turn);
  return (
    <View
      accessibilityLabel={`${owner} expects ${Math.round(Math.max(share, 100 - share))}% of the point`}
      style={ui.expectation}
    >
      <View
        style={[
          ui.expectationFill,
          {
            backgroundColor: players[owner].strong,
            left: `${ahead ? 50 : share}%`,
            width: `${Math.max(1.2, Math.abs(share - 50))}%`,
          },
        ]}
      />
      <View style={ui.expectationCentre} />
    </View>
  );
}

/** The one text field every naming surface uses. */
export function NameInput(props: TextInputProps) {
  return (
    <TextInput
      maxLength={80}
      placeholderTextColor={colors.textFaint}
      selectionColor={colors.accentBright}
      {...props}
      style={[ui.input, props.style]}
    />
  );
}

/**
 * One name somebody has put forward.
 *
 * Everybody sees the name; a curator sees the two answers to it. Publishing is
 * the ordinary act and gets the solid button, because a queue is cleared by
 * accepting names far more often than by refusing them.
 */
export function SuggestionRow({
  curator,
  suggestion,
}: {
  curator: OpeningCurator;
  suggestion: OpeningNameSuggestion;
}) {
  return (
    <View style={ui.suggestionRow}>
      <Text numberOfLines={2} style={ui.suggestionName}>
        {suggestion.name}
      </Text>
      {curator.active && (
        <View style={ui.suggestionActions}>
          <PrimaryButton
            compact
            label="PUBLISH"
            loading={curator.busy === `approve:${suggestion.suggestionId}`}
            onPress={() => curator.approve(suggestion)}
          />
          <GhostButton
            compact
            disabled={curator.busy === `reject:${suggestion.suggestionId}`}
            label="REJECT"
            onPress={() => curator.reject(suggestion)}
          />
        </View>
      )}
    </View>
  );
}

export const ui = StyleSheet.create({
  pressed: { opacity: 0.7 },
  eyebrow: { color: colors.accentBright, fontSize: 8, fontWeight: '900', letterSpacing: 1.4 },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
    marginBottom: 6,
  },
  hint: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },
  turnDot: { width: 7, height: 7, borderRadius: 4 },
  // A row that has to survive a phone: the field keeps a usable width and the
  // button wraps under it rather than squeezing it to nothing.
  formRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 160,
    minWidth: 0,
    minHeight: 38,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceSunken,
    color: colors.textStrong,
    fontSize: 13,
  },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.small,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceSunken,
  },
  // minWidth: 0 is what lets a long name wrap instead of pushing the buttons
  // off the row.
  suggestionName: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 120,
    minWidth: 0,
    color: colors.textStrong,
    fontSize: 13,
    fontWeight: '800',
  },
  suggestionActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  expectation: {
    position: 'relative',
    height: 6,
    marginTop: 9,
    overflow: 'hidden',
    borderRadius: 3,
    backgroundColor: colors.surfaceDeep,
  },
  expectationFill: { position: 'absolute', top: 0, bottom: 0, borderRadius: 3 },
  expectationCentre: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '50%',
    width: 1,
    backgroundColor: colors.borderStrong,
  },
});
