import type { GradeKey } from '@/engine/gameReview';

import type { SideColor } from '@/types/game';

import { REACH_BANDS, reachRamp, withAlpha } from './color';
import type { BoardSpec, PlayerSeed, ThemeSpec } from './spec';

// One theme's worth of tokens, assembled from a spec.
//
// Everything in here that is not copied straight out of the spec is derived,
// and each of those is derived rather than authored on purpose: a wash over a
// board, the ranked arrow colours, and both distance ramps are places where a
// free hand produces a board that cannot be read. A preset chooses hues; this
// file decides what is done with them.

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
  /** Reach bands over a light square, index = moves. See `REACH_BANDS`. */
  reachOnLight: readonly string[];
  /** The same bands over a dark square, in the lighter hue. */
  reachOnDark: readonly string[];
}

/** What one medal is drawn with. */
export interface MedalTone {
  /** The rank number, and the name beside it. */
  text: string;
  /** The card behind them. */
  surface: string;
  border: string;
}

/** One shadow layer, in the shape React Native's `boxShadow` takes. */
export interface ShadowLayer {
  offsetX: number;
  offsetY: number;
  blurRadius: number;
  color: string;
}

const playerPalette = (seed: PlayerSeed): PlayerPalette => ({
  strong: seed.strong,
  soft: seed.soft,
  contrast: seed.contrast,
  surface: seed.surface,
  border: seed.border,
  territory: seed.border,
  tint: withAlpha(seed.strong, 0.42),
  tintBorder: withAlpha(seed.pale, 0.68),
  territoryMark: withAlpha(seed.contrast, 0.62),
  reachOnLight: reachRamp(seed.strong, 0.44, 0.05),
  reachOnDark: reachRamp(seed.pale, 0.4, 0.04),
});

export const buildTheme = (spec: ThemeSpec, boardSpec: BoardSpec) => {
  const { scrim, rim, signals } = spec;
  const players: Record<SideColor, PlayerPalette> = {
    Red: playerPalette(spec.players.Red),
    Blue: playerPalette(spec.players.Blue),
  };

  const colors = {
    ...spec.surface,
    ...spec.border,
    ...spec.accent,
    ...spec.text,

    ...spec.discord,
    // The brand itself, worn only by the button that starts a Discord sign-in.
    // Fixed across every preset: the two above are the app's blue standing in
    // for Discord on a panel about it; these two are Discord's. The second is
    // Discord's own darker step, used when the button is pressed.
    discordBrand: '#5865f2',
    discordBrandPressed: '#4752c4',

    ...spec.title,
    // The rim shared by every tag: the light end at low alpha, which lifts a
    // pill off a row without needing a second colour per title. It disappears
    // into the one light tag, which does not need lifting.
    titleBorder: withAlpha(rim, 0.22),

    ...spec.live,
    ...spec.gold,
    ...spec.danger,
    ...spec.notice,

    /** The dim behind a modal. */
    overlay: withAlpha(scrim, 0.78),
    /**
     * The same dim, for something that sits *over* a page rather than replacing
     * it: a menu hung off the tab bar wants the page to fall back, not go dark.
     */
    overlayQuiet: withAlpha(scrim, 0.38),
  };

  // Board surface. The lobby thumbnail, the how-to-play diagram, and the live
  // board all read from here, so they cannot drift apart.
  const board = {
    frame: boardSpec.frame,
    lightTile: boardSpec.lightTile,
    darkTile: boardSpec.darkTile,
    // The same two squares over a mode's own background picture. Translucent so
    // the picture reads and the chequer still does — an author who could set
    // this themselves could publish a board nobody can play on, so it is fixed
    // here rather than in the rule format.
    lightTileOverArt: withAlpha(boardSpec.lightTile, 0.62),
    darkTileOverArt: withAlpha(boardSpec.darkTile, 0.62),
    labelOnLight: withAlpha(boardSpec.labelOnLight, 0.85),
    labelOnDark: withAlpha(boardSpec.labelOnDark, 0.9),

    goalOutline: withAlpha(boardSpec.paper, 0.28),
    selectionTint: withAlpha(signals.selection, 0.5),
    selectionMark: withAlpha(signals.selectionMark, 0.9),
    lastMoveFrom: withAlpha(signals.lastMove, 0.5),
    lastMoveTo: withAlpha(signals.lastMove, 0.7),
    lastMoveMark: withAlpha(signals.lastMoveMark, 0.72),
    moveHint: withAlpha(boardSpec.ink, 0.42),
    // The thin dark edge every arrow on a board carries — the board's own ink,
    // not the theme's, for the same reason the marks above are the board's.
    //
    // An arrow crosses light squares and dark ones on its way, and a colour
    // that separates from one sinks into the other. Rather than restrict the
    // arrows to colours that read on both -- there are not many, and the
    // ranked ones must be told apart from each other as well as from the
    // board -- each is edged, so the outline does the separating and the fill
    // is left free to mean something.
    arrowOutline: withAlpha(boardSpec.ink, 0.5),

    annotation: signals.orange,
    annotationTint: withAlpha(signals.orange, 0.78),
    annotationMark: withAlpha(boardSpec.paper, 0.76),

    // Ranked suggestions, best first — and one colour per rank, all the way to
    // the five the board will draw. The last two are the review's own
    // annotation hues, which were chosen to stand apart from both players'
    // fields: the property an arrow crossing a board full of pieces needs most.
    analysisArrows: [
      signals.lastMove,
      players.Blue.soft,
      signals.selection,
      signals.purple,
      signals.coral,
    ],
  };

  // The reach overlay's own colours — everything about it that is not one side's
  // distance ramp. The hues are chosen against what the board already uses: gold
  // is the selection, the accent is the last move, so a safe run is purple and a
  // square a predator owns is orange. Nothing here may be mistaken for a control.
  const reach = {
    /** A square the piece that captures this one reaches first. */
    danger: withAlpha(signals.orange, 0.44),
    dangerRing: withAlpha(signals.orange, 0.92),

    // The hunter's own distance, written on top of that wash. Plain orange text
    // on an orange wash is the one combination that does not work, so this is
    // the same two-tone answer the bands and `clock.bonusWash` give.
    hunterOnLight: withAlpha(signals.orangeDeep, 0.95),
    hunterOnDark: signals.orangeSoft,

    /** The run itself, square by square. */
    path: withAlpha(signals.purple, 0.5),
    pathRing: withAlpha(signals.purple, 0.95),

    /** Both sides arrive on the same move, so neither of them owns it. */
    contestedTie: withAlpha(boardSpec.paper, 0.3),

    /** The outline at exactly the distance being asked about. */
    frontierRing: withAlpha(boardSpec.paper, 0.72),

    /** A piece that is not really there. */
    ghostRing: withAlpha(signals.selection, 0.9),
    ghostFill: withAlpha(signals.selection, 0.22),

    // Distances are read off the squares themselves, so they need more contrast
    // than the rank and file letters, which only have to be findable — and they
    // are measured against the *board's* two anchors rather than the theme's,
    // because a light app theme does not make a dark square light.
    numberOnLight: withAlpha(boardSpec.ink, 0.88),
    numberOnDark: withAlpha(boardSpec.paper, 0.92),
  };

  /**
   * The top three of a ladder, best first.
   *
   * Gold, silver and bronze rather than three steps of the accent, because
   * these are the colours a medal has meant for longer than this game has
   * existed and an invented ramp would have to be learned. Second place is the
   * theme's own neutrals, so only the other two need seeding.
   */
  const podium: readonly MedalTone[] = [
    { text: colors.goldBright, surface: spec.medal.firstSurface, border: colors.goldBorder },
    { text: colors.textSoft, surface: colors.surfaceRaised, border: colors.borderStrong },
    {
      text: spec.medal.bronzeText,
      surface: spec.medal.bronzeSurface,
      border: spec.medal.bronzeBorder,
    },
  ];

  /**
   * The three parts of a win-draw-loss ratio.
   *
   * Reusing the accent for wins and the muted danger for losses, because those
   * already mean going well and going badly everywhere else on the site. Draws
   * take a neutral: a draw is neither, and giving it a hue of its own would make
   * a drawish engine look like it had a third kind of result.
   */
  const record = {
    win: colors.accent,
    draw: colors.borderFaint,
    loss: spec.players.Red.border,
  };

  // Engine verdict on a move, best to worst. Used for badges and history rows,
  // always with `colors.textInverse` on top.
  const moveQuality: Record<GradeKey, string> = {
    best: colors.accentBright,
    great: signals.purple,
    excellent: players.Blue.soft,
    good: colors.accentSoft,
    inaccuracy: colors.gold,
    mistake: signals.orange,
    blunder: signals.coral,
  };

  // The game review timeline uses brighter layered fills than the surrounding
  // cards so small changes in expected score remain visible at a glance.
  const evaluationChart = {
    background: colors.surfaceDeep,
    blueArea: players.Blue.surface,
    blueHighlight: players.Blue.strong,
    redArea: players.Red.surface,
    redHighlight: players.Red.strong,
    line: colors.text,
    lineGlow: withAlpha(scrim, 0.55),
    selection: colors.accentBright,
    selectionWash: withAlpha(colors.accentBright, 0.16),
  };

  // The analysis eval bar: two player-coloured halves with a floating score.
  const evalBar = {
    divider: colors.text,
    // White rather than the theme's light end: this chip sits on the *red half
    // of the bar*, which is a player's colour and the same weight on every
    // preset. Measuring it against the page would turn it black on a light one.
    badgeOnRed: withAlpha('#ffffff', 0.9),
    badgeOnRedText: colors.dangerStrong,
    badgeOnBlue: withAlpha(scrim, 0.86),
    badgeOnBlueText: players.Blue.contrast,
  };

  // A running clock lights up; under 20 seconds it turns red.
  const clock = {
    idleSurface: colors.surfaceMuted,
    idleText: colors.textSubtle,
    idlePulse: colors.borderLight,

    activeSurface: signals.clockFace,
    activeText: signals.clockFaceText,
    activePulse: colors.accent,

    lowSurface: signals.clockFaceLow,
    lowText: signals.clockFaceLowText,
    lowPulse: colors.danger,

    // The wash that runs over a clock face when the players agree to more time,
    // and the chip that rises off it saying how much. Translucent so it reads as
    // light thrown across the face rather than a fourth clock state.
    //
    // Two washes because the two faces read light on dark and dark on light, and
    // one accent cannot brighten both: the one that lifts the lit panel drops
    // the idle panel's grey digits to 1.8:1, which is a flourish that costs you
    // the time it is announcing. The darker step does the same job at 5.3:1.
    bonusWash: withAlpha(colors.accentSurfaceStrong, 0.9),
    bonusWashLit: withAlpha(colors.accentBright, 0.62),
    bonusChip: colors.accentSurfaceRaised,
    bonusChipBorder: colors.accentBorder,
    bonusChipText: colors.accentTextStrong,
  };

  // Shared shadow recipes so raised surfaces match across screens.
  //
  // `rail` is the live rail's own, which had been written inline there with a
  // hardcoded rgba — the last colour outside this file. It is a recipe rather
  // than a reuse of `banner` because the geometry is genuinely its own: the
  // rail is a tall panel floating beside a page and is thrown further than a
  // banner sitting on one.
  const shadows: Record<'board' | 'piece' | 'banner' | 'modal' | 'rail', ShadowLayer[]> = {
    board: [{ offsetX: 0, offsetY: 10, blurRadius: 16, color: withAlpha(scrim, 0.38) }],
    piece: [{ offsetX: 0, offsetY: 6, blurRadius: 4, color: withAlpha(scrim, 0.58) }],
    banner: [{ offsetX: 0, offsetY: 5, blurRadius: 8, color: withAlpha(scrim, 0.36) }],
    modal: [{ offsetX: 0, offsetY: 12, blurRadius: 22, color: withAlpha(scrim, 0.55) }],
    rail: [{ offsetX: 0, offsetY: 6, blurRadius: 14, color: withAlpha(scrim, 0.34) }],
  };

  return {
    colors,
    players,
    board,
    reach,
    podium,
    record,
    moveQuality,
    evaluationChart,
    evalBar,
    clock,
    shadows,
    monogramHues: spec.monogram,
    REACH_BANDS,
  };
};

/** Every colour token the app draws with, for one theme and one board. */
export type Tokens = ReturnType<typeof buildTheme>;
