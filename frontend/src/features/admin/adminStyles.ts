import { StyleSheet } from 'react-native';

import { colors, radius, space, themedSheet, type } from '@/theme';

// The look every admin panel shares.
//
// These styles were all in one file when the admin screen was one screen. It is
// six panels now, and each of them draws the same three things — a gold panel,
// a search row, and a table of rows with buttons at the trailing edge. Copying
// that into six files is how the fifth one ends up with a different row height.
//
// What is *not* here: anything one panel does on its own. A panel with its own
// layout keeps it in its own file, so that this stays the set of things that
// genuinely have to match rather than a dumping ground.

export const adminStyles = themedSheet(() => ({
  // The gold frame that says "this panel is the host's". Deliberately the same
  // colour as the tournament screen's host block, so the two read as one set of
  // tools that happen to live in two places.
  panel: {
    borderColor: colors.goldBorder,
    backgroundColor: colors.goldSurfaceDeep,
    borderRadius: radius.large,
  },

  searchRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.small },
  searchField: { flex: 1 },

  list: { gap: 1, marginTop: space.small },
  row: {
    minHeight: 54,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.small,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingVertical: space.snug,
  },
  // minWidth rather than width, so a row wraps its buttons onto a second line
  // on a phone instead of truncating the name — which is the only part of the
  // row that identifies what the buttons will act on.
  rowCopy: { flex: 1, minWidth: 180 },
  rowName: { ...type.rowTitle, color: colors.text },
  rowMeta: { ...type.meta, color: colors.textFaint, marginTop: 2 },
  rowNumber: { ...type.body, color: colors.textMuted, fontWeight: '700' },

  // The inset block a row expands into. Darker and rule-edged so that a delete
  // button inside it reads as belonging to the row above rather than to the
  // list.
  detail: {
    marginLeft: space.medium,
    marginBottom: space.small,
    paddingLeft: space.medium,
    borderLeftWidth: 2,
    borderLeftColor: colors.goldBorder,
  },
  detailHeading: {
    ...type.eyebrow,
    color: colors.textFaint,
    marginTop: space.small,
  },
  detailNote: { ...type.meta, color: colors.textFaint, paddingVertical: space.snug },

  subRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.small,
    paddingVertical: 5,
  },
  subRowName: { ...type.body, color: colors.text, fontWeight: '700' },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.snug },

  help: { ...type.body, color: colors.textFaint, marginTop: space.medium },
}));

// The destructive button, and the states it moves through.
//
// Separate from the set above because it is a component's styles rather than a
// panel's, and because `ConfirmButton` is the only thing that should be drawing
// them: an armed-looking button that is not actually armed is worse than no
// confirmation at all.
export const confirmStyles = themedSheet(() => ({
  // Matched to GhostButton, so a quiet destructive action beside one reads as a
  // button rather than as a disabled one.
  button: {
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.medium,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceRaised,
  },
  danger: {
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurfaceQuiet,
  },
  // An armed button is filled rather than merely relabelled: the difference
  // between "delete" and "yes, really" should be visible from across the row.
  armed: {
    borderColor: colors.dangerStrong,
    backgroundColor: colors.dangerSurface,
  },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  text: { ...type.label, color: colors.textSubtle },
  textDanger: { color: colors.dangerSoft },
  textArmed: { color: colors.dangerText },
}));
