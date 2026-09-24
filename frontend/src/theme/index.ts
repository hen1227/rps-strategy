import type { TextStyle } from 'react-native';

import type { SideColor } from '@/types/game';

import { buildTheme, type MedalTone, type PlayerPalette, type Tokens } from './buildTheme';
import { BOARDS, DEFAULT_BOARD_ID, boardById } from './boards';
import { rebuildSheets } from './sheet';
import type { BoardSpec, ColorScheme, ThemeSpec } from './spec';
import { THEMES, DEFAULT_THEME_ID, themeById } from './themes';

// One palette for the whole app. Screens and components import these tokens
// instead of repeating hex values, so the board, lobby, and tournament views
// stay visually consistent. Anything outside this module that writes a literal
// colour is a bug.
//
// These used to be constants. They are now containers with permanent identity
// whose *contents* are replaced when the player picks a different look — which
// is what lets all 131 importing files go on saying `import {colors} from
// '@/theme'` and reading `colors.surface`, unchanged, and still follow a theme
// they could not have known about. See `applyAppearance` at the foot of this
// file for the order that has to hold, and `./sheet.ts` for the other half:
// stylesheets, which read their colours once and so need refilling too.

export type { BoardSpec, ColorScheme, ThemeSpec, PlayerSeed } from './spec';
export type { MedalTone, PlayerPalette, ShadowLayer, Tokens } from './buildTheme';
export { themedSheet } from './sheet';
// Exported for the appearance picker, which builds a preset's tokens to draw
// its swatch: a chip has to show the theme it is offering, not the one on.
export { buildTheme } from './buildTheme';
export { withAlpha, REACH_BANDS } from './color';
export { BOARDS, boardById, DEFAULT_BOARD_ID } from './boards';
export { THEMES, themeById, DEFAULT_THEME_ID } from './themes';

const initial = buildTheme(themeById(DEFAULT_THEME_ID), boardById(DEFAULT_BOARD_ID));

export const colors = { ...initial.colors };
export const players: Record<SideColor, PlayerPalette> = { ...initial.players };
export const board = { ...initial.board };
export const reach = { ...initial.reach };
export const record = { ...initial.record };
export const moveQuality = { ...initial.moveQuality };
export const evaluationChart = { ...initial.evaluationChart };
export const evalBar = { ...initial.evalBar };
export const clock = { ...initial.clock };
export const shadows = { ...initial.shadows };

/**
 * The avatar hues, hashed from a name.
 *
 * An object rather than the bare array it replaced, because the array has to
 * keep its identity across a theme change and its *contents* are what move.
 */
export const monogram = { hues: initial.monogramHues };

/**
 * The top three of a ladder, best first.
 *
 * The one place in this app where a *rank* is a colour, which is why it is a
 * band of its own rather than three entries in `colors`: nothing outside a
 * podium may use these, because a card wearing gold anywhere else would read as
 * a position somebody holds. Fourth place is a number, not a colour — see
 * `rankTone` in `LadderRows`, which stops here.
 */
export const podium: MedalTone[] = [...initial.podium];

// --------------------------------------------------------------------------
// The title tags, which are the one place in this app where the colour is the
// information — and so the one band of colour a theme may not touch. A hue that
// also meant something on the board would make a tag look like a state, and a
// hue that moved with the theme would make the same title look like two.
//
// All but three sit in the same narrow lightness range: dark enough to carry
// white letters at eight pixels — every one of them clears 4.5:1, which is the
// bar for text this small — and far enough apart to be told from each other at
// that size.
// --------------------------------------------------------------------------
const titleHues = {
  stone: '#5c646f',
  teal: '#26806f',
  indigo: '#3f5aa6',
  // The top of the ladder, and the one hue here that was not chosen: red is
  // what a chess player has read as Grandmaster for as long as there have been
  // title tags, so GM wears it and the ramp below it leads up to it.
  scarlet: '#a02525',

  crimson: '#a62f4a',
  cyan: '#1a708c',
  periwinkle: '#544bb0',
  fire: '#c25211',
  sienna: '#96422c',

  // The one hue in here borrowed from outside the app, because the title it
  // marks is about somewhere else: Discord's blurple, darkened out of the
  // brand's own value so that white letters clear 4.5:1 like every other tag.
  blurple: '#4550cf',

  ochre: '#7a6a2a',
  steel: '#3a6a87',
  navy: '#44567d',
  sage: '#4f6b5c',
  oxblood: '#7b3b3f',
  // The one purple in the muted band, and kept muted on purpose even though the
  // title it marks is about engines: the two bright engine-owner hues are
  // achievements read off a ladder, and this one is a thank you from the host.
  // Far enough round from periwinkle above — forty-odd degrees, and duller —
  // that the two do not read as the same tag at eight pixels.
  plum: '#6b4270',

  // The one tag that is not the house being modest about itself. WGG belongs to
  // the person who invented these games and to nobody else, so it gets a hue of
  // its own — and a deliberately warm one, since it is the only granted title
  // that is a thank you rather than a role.
  goat: '#8a5a1f',

  // And the second of those, on the same grounds: a title that is one person
  // rather than a role gets a hue that is his. Green for the obvious reason,
  // and a grass green rather than another blue-green — teal and sage are both
  // in here already, so this one sits a good sixty degrees warmer than either
  // so that three greens in one palette stay three.
  clover: '#3d7a24',

  // The engine pool. A family of its own, because a player reading a ladder
  // should be able to tell at a glance that a tag belongs to a machine.
  //
  // Two of them. The crown is filled gold with dark letters, because a crown
  // that is not gold is not this app's crown; the cup is quiet on purpose, since
  // gold is the thing that is true this week and a tag that has been true for
  // months should not be competing with it.
  crownGold: '#f0c964',
  graphite: '#4a4f5c',
};

/** What one title tag is drawn with. The border is derived; see `TitleTag`. */
export interface TitleTone {
  /** The letters. */
  text: string;
  /** The pill behind them. */
  background: string;
}

// Which colour each title wears, by id.
//
// Three families, and the family is meant to be readable before the letters
// are: the rating ladder is a ramp climbing to Grandmaster's red; achievements
// each take a hue of their own; granted titles are the muted ones.
//
// Keyed by id rather than by kind, and read through `titleTone` so that a title
// the server knows and this build does not still renders — in the neutral
// below rather than not at all.
const titleTones: Record<string, TitleTone> = {
  // The ladder.
  CM: { text: '#ffffff', background: titleHues.stone },
  FM: { text: '#ffffff', background: titleHues.teal },
  IM: { text: '#ffffff', background: titleHues.indigo },
  GM: { text: '#ffffff', background: titleHues.scarlet },

  // Earned at the board.
  TC: { text: '#ffffff', background: titleHues.crimson },
  ARC: { text: '#ffffff', background: titleHues.cyan },
  BM: { text: '#ffffff', background: titleHues.periwinkle },
  STK: { text: '#ffffff', background: titleHues.fire },
  BSL: { text: '#ffffff', background: titleHues.sienna },

  // Not earned at the board at all, and the commonest tag there is.
  D: { text: '#ffffff', background: titleHues.blurple },

  // Handed out by the host.
  VET: { text: '#ffffff', background: titleHues.ochre },
  DEV: { text: '#ffffff', background: titleHues.steel },
  MOD: { text: '#ffffff', background: titleHues.navy },
  CON: { text: '#ffffff', background: titleHues.sage },
  PIO: { text: '#ffffff', background: titleHues.plum },
  FND: { text: '#ffffff', background: titleHues.oxblood },

  // Exactly one person wears each of these two. See `titleHues.goat`.
  WGG: { text: '#ffffff', background: titleHues.goat },
  PIZ: { text: '#ffffff', background: titleHues.clover },

  // Engines. The crown is the gold one, and dark-lettered; see `titleHues`.
  RC: { text: '#171613', background: titleHues.crownGold },
  CUP: { text: '#ffffff', background: titleHues.graphite },
};

/**
 * The neutral worn by a title with no colour of its own.
 *
 * Deliberately a neutral rather than a spare hue: a title added to the server's
 * catalogue tomorrow should read as one nothing is known about, not as a
 * borrowed identity. This one *does* follow the theme, because it is the app's
 * own surface rather than a title's identity.
 */
export const defaultTitleTone: TitleTone = {
  text: colors.titleText,
  background: colors.titleBackground,
};

/** How a title is drawn. Anything unrecognised gets the neutral. */
export const titleTone = (id?: string | null): TitleTone =>
  titleTones[(id ?? '').trim()] ?? defaultTitleTone;

export const radius = { small: 6, medium: 9, large: 13, xlarge: 18 };

// --------------------------------------------------------------------------
// Spacing and type.
//
// Not themed, and not by omission. Both are `as const`, and several dozen
// call sites spread `type.label` into a style and rely on `fontWeight` being
// the literal `'900'` rather than `string`. Letting a preset move them would
// widen those types and break the spread sites — and a density setting is a
// different feature from a colour scheme anyway.
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
 * `reading` is prose and forms, `standard` is a page of panels, `wide` is a
 * page with a board or a table on it.
 */
export const contentWidth = { reading: 640, standard: 900, page: 1180, wide: 1240 } as const;

// Layout breakpoint where a screen splits into two columns. Read it through
// `useWideLayout` rather than comparing against it by hand.
export const WIDE_LAYOUT_WIDTH = 900;

// --------------------------------------------------------------------------
// Changing the look.
// --------------------------------------------------------------------------

let activeThemeSpec: ThemeSpec = themeById(DEFAULT_THEME_ID);
let activeBoardSpec: BoardSpec = boardById(DEFAULT_BOARD_ID);

/** Which theme and board are on screen right now. */
export const activeAppearance = () => ({ theme: activeThemeSpec, board: activeBoardSpec });

/** Light or dark, for the status bar and the browser's own chrome. */
export const activeScheme = (): ColorScheme => activeThemeSpec.scheme;

/**
 * Put a theme and a board on screen.
 *
 * The order below is the whole of it, and it is the only order that works. The
 * stylesheet factories read these containers as they run, so every token has to
 * be current before `rebuildSheets` is called; and nothing may render between
 * the two, or half the tree would draw with new colours and half with old.
 *
 * Which is also why this must be called synchronously from the event handler
 * that chose the look — never inside a transition and never after an `await`.
 * The containers live outside React, so React's tearing guarantees do not cover
 * them: a mutation landing in the middle of a time-sliced render would leave
 * the components already rendered in that pass holding the previous colours.
 *
 * Returns a key naming what is now showing, which is what the subscribers
 * outside re-render on.
 */
export const applyAppearance = (themeId: string, boardId: string): string => {
  activeThemeSpec = themeById(themeId);
  activeBoardSpec = boardById(boardId);
  const next = buildTheme(activeThemeSpec, activeBoardSpec);

  // One level of assignment, with fresh objects underneath. Only the module
  // bindings themselves need permanent identity — that is what `import` binds —
  // and everything below is read through its container at render time, so
  // replacing it wholesale is both simpler and safer than splicing contents:
  // an identity-preserving mutation is exactly what native prop diffing is
  // least likely to notice.
  Object.assign(colors, next.colors);
  Object.assign(players, next.players);
  Object.assign(board, next.board);
  Object.assign(reach, next.reach);
  Object.assign(record, next.record);
  Object.assign(moveQuality, next.moveQuality);
  Object.assign(evaluationChart, next.evaluationChart);
  Object.assign(evalBar, next.evalBar);
  Object.assign(clock, next.clock);
  Object.assign(shadows, next.shadows);
  monogram.hues = next.monogramHues;
  podium.length = 0;
  podium.push(...next.podium);
  defaultTitleTone.text = colors.titleText;
  defaultTitleTone.background = colors.titleBackground;

  const key = `${activeThemeSpec.id}/${activeBoardSpec.id}`;
  rebuildSheets(key);
  return key;
};
