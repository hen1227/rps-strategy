import type { GradeKey } from '@/engine/gameReview';
import type { TextStyle } from 'react-native';

import type { SideColor } from '@/types/game';

// One palette for the whole app. Screens and components import these tokens
// instead of repeating hex values, so the board, lobby, and tournament views
// stay visually consistent.
//
// Swapping the app to a different look means editing `palette` below and
// nothing else: every semantic token, board colour, player identity, and clock
// state is derived from it. Anything outside this file that writes a literal
// colour is a bug.

// Tints and overlays derive from the palette so a recoloured scheme carries
// through to them instead of drifting out of step.
const withAlpha = (hex: string, alpha: number) => {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
        .split('')
        .map((channel) => channel + channel)
        .join('')
      : value;
  const red = parseInt(full.slice(0, 2), 16);
  const green = parseInt(full.slice(2, 4), 16);
  const blue = parseInt(full.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
};

// --------------------------------------------------------------------------
// The raw scheme. Warm neutrals, a green accent, and the two player hues.
// --------------------------------------------------------------------------
const palette = {
  // Warm neutral ramp, darkest to lightest.
  ink950: '#171613',
  ink900: '#1f1e1b',
  ink850: '#211f1d',
  ink800: '#262522',
  ink750: '#302e2a',
  ink700: '#312e2b',
  ink650: '#3a3833',
  ink600: '#3d3a36',
  ink550: '#45423e',
  ink500: '#514e49',
  ink450: '#53514c',
  ink400: '#68645e',
  ink350: '#77736d',
  ink300: '#8f8c86',
  ink250: '#aaa7a2',
  ink200: '#c2bfb9',
  ink150: '#d9d6d0',
  ink100: '#f5f5f5',
  white: '#ffffff',

  // Green accent, plus the darker green the board's dark squares use.
  green100: '#e5f4d9',
  green200: '#a9c497',
  green300: '#b8d993',
  green400: '#a3d160',
  green500: '#81b64c',
  green600: '#769656',
  green700: '#5f7950',
  green750: '#3b4a30',
  green800: '#35462e',
  green900: '#303a2b',
  green950: '#2b3026',

  // Player red and the warm sand of the board's light squares.
  red200: '#dd8e85',
  red300: '#c85e58',
  red400: '#c84b44',
  red500: '#a85d52',
  red600: '#8f3a30',
  red650: '#6e3a35',
  red700: '#5a302d',
  red750: '#3a2724',
  red050: '#ffd2ce',
  sand: '#d7c5a3',

  // Player blue.
  blue200: '#a3c0e1',
  blue300: '#8fb4d8',
  blue400: '#3f77aa',
  blue500: '#527da1',
  blue700: '#2f3f52',
  blue050: '#d8ecff',

  // Review annotations need to stand apart from both player fields.
  purple400: '#9b6fe8',
  coral400: '#f0643e',

  // Signals: a live match, a tournament medal, a board annotation.
  live: '#e07a5f',
  liveSoft: '#f0b8a5',
  liveSurface: '#432f2a',
  liveBorder: '#7a4b3c',
  gold200: '#f4dda3',
  gold300: '#f0deb0',
  gold500: '#f0c964',
  gold600: '#d5ae4f',
  gold650: '#ad9d75',
  gold700: '#725f32',
  gold800: '#4a4027',
  gold900: '#29251b',
  orange: '#f2811d',

  // The active clock face reads as a lit panel against the dark board.
  clockFace: '#e9e5dc',
  clockFaceLow: '#f3ded9',
};

export const colors = {
  background: palette.ink700,
  surface: palette.ink800,
  surfaceRaised: palette.ink750,
  surfaceSunken: palette.ink850,
  surfaceMuted: palette.ink650,
  surfaceWell: palette.ink900,
  surfaceDeep: palette.ink950,

  border: palette.ink550,
  borderStrong: palette.ink500,
  borderSoft: palette.ink600,
  borderLight: palette.ink400,
  borderFaint: palette.ink450,

  accent: palette.green500,
  accentBright: palette.green400,
  accentSoft: palette.green300,
  accentText: palette.green200,
  accentTextStrong: palette.green100,
  accentSurfaceQuiet: palette.green950,
  accentSurface: palette.green900,
  accentSurfaceRaised: palette.green800,
  accentSurfaceStrong: palette.green750,
  accentBorder: palette.green700,

  text: palette.ink100,
  textStrong: palette.white,
  textSoft: palette.ink150,
  textSubtle: palette.ink200,
  textMuted: palette.ink250,
  textDim: palette.ink300,
  textFaint: palette.ink350,
  textInverse: palette.ink850,

  live: palette.live,
  liveSoft: palette.liveSoft,
  liveSurface: palette.liveSurface,
  liveBorder: palette.liveBorder,

  gold: palette.gold500,
  goldBright: palette.gold300,
  goldSoft: palette.gold200,
  goldMuted: palette.gold650,
  goldDot: palette.gold600,
  goldSurface: palette.gold800,
  goldSurfaceDeep: palette.gold900,
  goldBorder: palette.gold700,

  danger: palette.red400,
  dangerStrong: palette.red600,
  dangerSurface: palette.red700,
  dangerSurfaceQuiet: palette.red750,
  dangerBorder: palette.red650,
  dangerText: palette.red050,
  dangerSoft: palette.red300,
  noticeSurface: '#30462c',
  noticeText: '#d5efca',
};

/** Everything one side is drawn with. */
export interface PlayerPalette {
  strong: string;
  soft: string;
  contrast: string;
  surface: string;
  border: string;
  territory: string;
  tint: string;
  tintBorder: string;
  territoryMark: string;
}

// The two sides. `surface`/`border` dress avatars and chat badges; `tint` washes
// owned territory on the board; `strong` is the piece colour itself.
export const players: Record<SideColor, PlayerPalette> = {
  Red: {
    strong: palette.red400,
    soft: palette.red300,
    contrast: palette.red050,
    surface: palette.red700,
    border: palette.red500,
    territory: palette.red500,
    tint: withAlpha(palette.red400, 0.42),
    tintBorder: withAlpha(palette.red200, 0.68),
    territoryMark: withAlpha(palette.red050, 0.62),
  },
  Blue: {
    strong: palette.blue400,
    soft: palette.blue300,
    contrast: palette.blue050,
    surface: palette.blue700,
    border: palette.blue500,
    territory: palette.blue500,
    tint: withAlpha(palette.blue400, 0.42),
    tintBorder: withAlpha(palette.blue200, 0.68),
    territoryMark: withAlpha(palette.blue050, 0.62),
  },
};

// Board surface. The lobby thumbnail, the how-to-play diagram, and the live
// board all read from here, so they cannot drift apart.
export const board = {
  frame: palette.ink950,
  lightTile: palette.sand,
  darkTile: palette.green600,
  labelOnLight: withAlpha(palette.green700, 0.85),
  labelOnDark: withAlpha(palette.sand, 0.9),

  goalOutline: withAlpha(palette.white, 0.28),
  selectionTint: withAlpha(palette.gold500, 0.50),
  selectionMark: withAlpha(palette.gold200, 0.9),
  lastMoveFrom: withAlpha(palette.green400, 0.5),
  lastMoveTo: withAlpha(palette.green400, 0.7),
  lastMoveMark: withAlpha(palette.green100, 0.72),
  moveHint: withAlpha(palette.ink950, 0.42),
  annotation: palette.orange,
  annotationTint: withAlpha(palette.orange, 0.78),
  annotationMark: withAlpha(palette.white, 0.76),

  // Ranked engine suggestions: best line first.
  analysisArrows: [palette.green400, palette.blue300, palette.gold500],
};

// Engine verdict on a move, best to worst. Used for badges and history rows,
// always with `colors.textInverse` on top.
export const moveQuality: Record<GradeKey, string> = {
  best: palette.green400,
  great: palette.purple400,
  excellent: palette.blue300,
  good: palette.green300,
  inaccuracy: palette.gold500,
  mistake: palette.orange,
  blunder: palette.coral400,
};

// The game review timeline uses brighter layered fills than the surrounding
// cards so small changes in expected score remain visible at a glance.
export const evaluationChart = {
  background: palette.ink950,
  blueArea: palette.blue700,
  blueHighlight: palette.blue400,
  redArea: palette.red700,
  redHighlight: palette.red400,
  line: palette.ink100,
  lineGlow: withAlpha(palette.ink950, 0.55),
  selection: palette.green400,
  selectionWash: withAlpha(palette.green400, 0.16),
};

// The analysis eval bar: two player-coloured halves with a floating score.
export const evalBar = {
  divider: palette.ink100,
  badgeOnRed: withAlpha(palette.white, 0.9),
  badgeOnRedText: palette.red600,
  badgeOnBlue: withAlpha(palette.ink950, 0.86),
  badgeOnBlueText: palette.blue050,
};

// A running clock lights up; under 20 seconds it turns red.
export const clock = {
  idleSurface: palette.ink650,
  idleText: palette.ink200,
  idlePulse: palette.ink400,

  activeSurface: palette.clockFace,
  activeText: palette.ink850,
  activePulse: palette.green500,

  lowSurface: palette.clockFaceLow,
  lowText: palette.red600,
  lowPulse: palette.red400,
};

/** One shadow layer, in the shape React Native's `boxShadow` takes. */
export interface ShadowLayer {
  offsetX: number;
  offsetY: number;
  blurRadius: number;
  color: string;
}

// Shared shadow recipes so raised surfaces match across screens.
export const shadows: Record<'board' | 'piece' | 'banner' | 'modal', ShadowLayer[]> = {
  board: [{ offsetX: 0, offsetY: 10, blurRadius: 16, color: withAlpha(palette.ink950, 0.38) }],
  piece: [{ offsetX: 0, offsetY: 6, blurRadius: 4, color: withAlpha(palette.ink950, 0.58) }],
  banner: [{ offsetX: 0, offsetY: 5, blurRadius: 8, color: withAlpha(palette.ink950, 0.36) }],
  modal: [{ offsetX: 0, offsetY: 12, blurRadius: 22, color: withAlpha(palette.ink950, 0.55) }],
};

export const overlay = withAlpha(palette.ink950, 0.78);

export const radius = { small: 6, medium: 9, large: 13, xlarge: 18 };

// --------------------------------------------------------------------------
// Spacing and type.
//
// These were the last magic numbers left. Every screen wrote its own font
// sizes, weights, letter-spacings and gaps inline, which is how the same badge
// ended up at 8px in one file and 9px in the next, and why "what size is a
// section heading" had eleven answers. Naming them does not make the old files
// wrong, but nothing new should invent a twelfth.
// --------------------------------------------------------------------------

/** The spacing steps this app actually uses, smallest first. */
export const space = {
  hair: 2,
  tight: 4,
  snug: 6,
  small: 8,
  medium: 12,
  large: 16,
  xlarge: 24,
  xxlarge: 32,
} as const;

/**
 * Named text roles rather than a size ramp, because a size on its own has never
 * been the decision: an eyebrow is small *and* heavy *and* letter-spaced, and
 * splitting that into three tokens would just move the guessing.
 */
export const type = {
  /** The tiny all-caps kicker above a heading. */
  eyebrow: { fontSize: 8, fontWeight: '900', letterSpacing: 1.4 },
  /** Button and badge lettering. */
  label: { fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  /** The dim second line of a row. */
  meta: { fontSize: 10, lineHeight: 15 },
  body: { fontSize: 11, lineHeight: 17 },
  bodyStrong: { fontSize: 12, lineHeight: 18 },
  /** The first line of a list row. */
  rowTitle: { fontSize: 12, fontWeight: '800' },
  cardTitle: { fontSize: 15, fontWeight: '900' },
  sectionTitle: { fontSize: 18, fontWeight: '900' },
  screenTitle: { fontSize: 22, fontWeight: '900' },
  hero: { fontSize: 26, fontWeight: '800' },
} as const satisfies Record<string, TextStyle>;

/**
 * How wide a page's content may get.
 *
 * Screens used to pick this by hand and picked eleven different numbers —
 * 640, 760, 900, 1100, 1180, 1200, 1240 — none of which were decisions.
 * `reading` is prose and forms, `standard` is a page of panels, `wide` is a
 * page with a board or a table on it.
 */
export const contentWidth = { reading: 640, standard: 900, page: 1180, wide: 1240 } as const;

// Layout breakpoint where a screen splits into two columns. Read it through
// `useWideLayout` rather than comparing against it by hand.
export const WIDE_LAYOUT_WIDTH = 900;
