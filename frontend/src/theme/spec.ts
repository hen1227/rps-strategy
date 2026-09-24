// What a theme is, written down.
//
// The old `theme.ts` had a private `palette` of named ramp steps — `ink700`,
// `green500` — and a semantic layer that picked one for each role. That works
// for one dark scheme and breaks for a second: `surfaceRaised` is *darker* than
// `background` here, `surfaceSunken` darker still, and there is no monotonic
// ramp a light theme could mirror. The mapping was hand-tuned, and hand-tuned is
// exactly the part a light theme has to redo.
//
// So a spec authors the roles directly. There is no ramp to index into and no
// clever inversion: writing a theme means answering "what colour is a raised
// surface", which is the question, rather than "which step of the ink ramp",
// which is an answer to a different one.
//
// Everything a spec does *not* carry is derived in `buildTheme` — every alpha
// wash, both reach ramps, the arrow ranks, the shadows. See there for why each
// one is derived rather than authored: an author who could set them by hand
// could publish a board nobody can read.

/** Light or dark, for the two things outside the token set that must be told. */
export type ColorScheme = 'dark' | 'light';

/** Everything one side of the board is authored with. The rest is derived. */
export interface PlayerSeed {
  /** The piece colour itself, and the side's arrow. */
  strong: string;
  /** The lighter hue: text on a dark field, and this side's ranked arrow. */
  soft: string;
  /**
   * The palest of the three, for the two places a hue is laid *over* something
   * already dark — the tint border around owned territory, and the distance
   * ramp on a dark square. `soft` sinks into both.
   */
  pale: string;
  /** Light enough to be read on top of `strong`. */
  contrast: string;
  /** The card behind an avatar or a chat badge. */
  surface: string;
  /** That card's edge, and the territory meter's bar. */
  border: string;
}

/** The three colours a medal is drawn with that no other role supplies. */
export interface MedalSeed {
  /** The plinth the first medal stands on: lighter than the gold border. */
  firstSurface: string;
  bronzeText: string;
  bronzeSurface: string;
  bronzeBorder: string;
}

/**
 * The hues that are signals rather than surfaces.
 *
 * Kept apart from the role groups below because none of them is "a surface" or
 * "some text": they are the colours that mean a thing — an annotation, a
 * predator's square, an engine's verdict — and a theme that recolours them
 * without keeping them apart from each other has broken the board rather than
 * restyled it.
 */
export interface SignalSeed {
  /** The board annotation, and the reach overlay's danger. */
  orange: string;
  /** Dark enough to read on an orange wash over a light tile. */
  orangeDeep: string;
  /** Light enough to read on an orange wash over a dark tile. */
  orangeSoft: string;
  /** The review's own two hues, chosen to stand apart from both player fields. */
  purple: string;
  coral: string;
  /**
   * The lit clock panel, the same panel when the time is nearly gone, and the
   * digits on each.
   *
   * The digits are authored beside their panel rather than taken from the text
   * roles, because a clock face is not the page: the lit panel is pale on a
   * dark theme and wants dark digits, and a light theme that keeps a pale panel
   * has nowhere to put light ones. The pair has to be decided together.
   */
  clockFace: string;
  clockFaceText: string;
  clockFaceLow: string;
  clockFaceLowText: string;

  /**
   * The four marks the board draws on itself, before their alpha.
   *
   * Here rather than taken from `gold` and `accent`, which is where they came
   * from when there was one theme. Those two roles are app colours: on a light
   * preset `gold` is a dark ochre that reads as text on a pale card, and half
   * of it laid over a sand tile is mud. A mark on the board has to be legible
   * on the board — on a light square and a dark one both — so it is authored
   * against the board rather than inherited from the page.
   *
   * Every preset here keeps them bright for that reason. The knob exists
   * because a theme may want to tune them; it is not an invitation to dim them.
   */
  selection: string;
  selectionMark: string;
  lastMove: string;
  lastMoveMark: string;
}

export interface ThemeSpec {
  id: string;
  /** What the picker calls it. */
  name: string;
  /** One line under the name, in the picker. */
  blurb: string;
  /**
   * Drives the status bar and the browser's chrome colour. Nothing in the token
   * arithmetic reads it — a light theme is light because its roles say so, not
   * because a flag flipped.
   */
  scheme: ColorScheme;

  /**
   * The dark everything dims and shadows with.
   *
   * Deliberately *not* the inverse of the page: a shadow under a card is dark
   * on a pale theme too, and a modal's scrim that went light on a light theme
   * would stop being a scrim. This is the one anchor that does not flip.
   */
  scrim: string;
  /**
   * The page-relative light end.
   *
   * One wash is measured against it — the rim shared by every title tag, which
   * lifts a pill off the row behind it. That is the only place the app asks
   * "which way is up from the page", so it is the only thing here that has to
   * invert for a light preset.
   */
  rim: string;

  surface: {
    background: string;
    surface: string;
    surfaceRaised: string;
    surfaceSunken: string;
    surfaceMuted: string;
    surfaceWell: string;
    surfaceDeep: string;
  };
  border: {
    border: string;
    borderStrong: string;
    borderSoft: string;
    borderLight: string;
    borderFaint: string;
  };
  text: {
    text: string;
    textStrong: string;
    textSoft: string;
    textSubtle: string;
    textMuted: string;
    textDim: string;
    textFaint: string;
    /** Letters on top of the accent, or on a lit clock face. */
    textInverse: string;
  };
  accent: {
    accent: string;
    accentBright: string;
    accentSoft: string;
    accentText: string;
    accentTextStrong: string;
    accentSurfaceQuiet: string;
    accentSurface: string;
    accentSurfaceRaised: string;
    accentSurfaceStrong: string;
    accentBorder: string;
  };
  gold: {
    gold: string;
    goldBright: string;
    goldSoft: string;
    goldMuted: string;
    goldDot: string;
    goldSurface: string;
    goldSurfaceDeep: string;
    goldBorder: string;
  };
  danger: {
    danger: string;
    dangerStrong: string;
    dangerSurface: string;
    dangerSurfaceQuiet: string;
    dangerBorder: string;
    dangerText: string;
    dangerSoft: string;
  };
  /** A live match: the rail, the badge, the pulsing dot. */
  live: { live: string; liveSoft: string; liveSurface: string; liveBorder: string };
  notice: { noticeSurface: string; noticeText: string };
  /**
   * The app standing in for Discord on a panel about it. Discord's own brand
   * blurple is not here: a sign-in button is expected to look like the service
   * it signs into, so it is fixed in `buildTheme` and no preset may move it.
   */
  discord: { discordBorder: string; discordSurface: string };
  /** The tag worn by a title this client has never heard of. */
  title: { titleBackground: string; titleText: string };

  players: { Red: PlayerSeed; Blue: PlayerSeed };
  medal: MedalSeed;
  signals: SignalSeed;

  /**
   * The avatar hues, hashed from a name.
   *
   * Six, and they were a literal in `ui/Monogram.tsx` until themes existed.
   * They have to clear the theme's own surfaces, which is why they travel with
   * it rather than staying behind as the app's last hardcoded colours.
   */
  monogram: readonly string[];
}

/**
 * A board is its own axis, not part of the theme.
 *
 * Because half a dozen tokens are keyed to *tile* lightness rather than to the
 * app's: the rank and file letters, the reach overlay's distances, both of the
 * hunter's two-tone answers. A light app theme over the same green-and-sand
 * board must not flip any of them, and it will if they are measured against the
 * theme's `scrim` and `rim`. Measuring them against the board's own two anchors
 * is what keeps "light mode" and "brown board" independent questions.
 */
export interface BoardSpec {
  id: string;
  name: string;
  blurb: string;
  lightTile: string;
  darkTile: string;
  /** The edge drawn around the whole board. */
  frame: string;
  /** The rank and file letters, before their alpha: one per square colour. */
  labelOnLight: string;
  labelOnDark: string;
  /** The two anchors anything written *on a square* is measured against. */
  ink: string;
  paper: string;
}
