// What a game *is*, described once.
//
// A matchmaking search and a posted challenge are the same thing carrying
// different setups, so every screen that shows one — the play screen's open
// board, the live rail, the invitation inbox, the game screen itself — is
// answering the same question: what is unusual about this game? Answering it in
// four places is how a row ends up saying "custom position" while the board
// beside it shows the standard one.
//
// Pure functions over a GameSetup, in the same spirit as `spectateSelectors.ts`.

import type {
  GameSetup,
  ModeDefinition,
  RuleFlags,
  SideColor,
  StartingPosition,
  TimeControl,
} from '@/types/game';

/**
 * The clock a game gets when nobody chose one. Mirrors
 * `game.DefaultTimeControl` in the backend; the server sends its own copy as
 * `defaultTimeControl` on connect, and `defaultTimeControlOf` prefers that.
 */
export const FALLBACK_TIME_CONTROL: TimeControl = {
  initialTimeMs: 5 * 60 * 1000,
  incrementMs: 3 * 1000,
};

export const defaultTimeControlOf = (fromServer?: TimeControl | null): TimeControl =>
  fromServer ?? FALLBACK_TIME_CONTROL;

/** `5+3`, the way every chess clock has been written for a century. */
export const timeControlLabel = ({ initialTimeMs, incrementMs }: TimeControl): string => {
  const minutes = initialTimeMs / 60_000;
  // A 30-second clock is a real time control, and rounding it to "0+2" would
  // make it look broken.
  const initial = minutes >= 1 ? String(Math.round(minutes)) : `${Math.round(initialTimeMs / 1000)}s`;
  return `${initial}+${Math.round(incrementMs / 1000)}`;
};

const sameRows = (first: StartingPosition, second: StartingPosition): boolean =>
  (first?.rows ?? []).length === (second?.rows ?? []).length &&
  (first?.rows ?? []).every((row, index) => row === second?.rows?.[index]);

const sameTimeControl = (first: TimeControl, second: TimeControl): boolean =>
  first?.initialTimeMs === second?.initialTimeMs && first?.incrementMs === second?.incrementMs;

const noRuleFlags = (rules: RuleFlags | undefined): boolean =>
  !rules?.noRepetitionDraw &&
  !rules?.noDrawOffers &&
  !rules?.noTimeExtensions &&
  !rules?.moveLimit;

/** The normal game for a mode: its own board, the default clock, rated. */
export const standardSetup = (
  mode: ModeDefinition,
  defaultTimeControl?: TimeControl | null,
): GameSetup => ({
  modeId: mode.id,
  timeControl: defaultTimeControlOf(defaultTimeControl),
  startingPosition: mode.startingPosition,
  rules: {},
});

/**
 * Whether this is the plain rated game nobody had to configure.
 *
 * The server asks the same question and answers it the same way, which is what
 * makes a posted game with nothing changed become a matchmaking search instead
 * of a row duplicating one. Asking here too lets the button say so first.
 */
export const isStandardSetup = (
  setup: GameSetup,
  mode: ModeDefinition | null | undefined,
  defaultTimeControl?: TimeControl | null,
): boolean =>
  Boolean(mode) &&
  setup.modeId === mode!.id &&
  !setup.casual &&
  !setup.preferredColor &&
  noRuleFlags(setup.rules) &&
  sameTimeControl(setup.timeControl, defaultTimeControlOf(defaultTimeControl)) &&
  sameRows(setup.startingPosition, mode!.startingPosition);

export const hasCustomPosition = (
  setup: GameSetup,
  mode: ModeDefinition | null | undefined,
): boolean => Boolean(mode) && !sameRows(setup.startingPosition, mode!.startingPosition);

/**
 * Move a setup to another mode.
 *
 * A board the author drew is theirs and follows them across; a board that is
 * just the old mode's opening does not, because carrying it would silently turn
 * "I changed my mind about the mode" into a custom game.
 */
export const withMode = (
  setup: GameSetup,
  mode: ModeDefinition,
  previousMode: ModeDefinition | null | undefined,
): GameSetup => ({
  ...setup,
  modeId: mode.id,
  startingPosition: hasCustomPosition(setup, previousMode)
    ? setup.startingPosition
    : mode.startingPosition,
});

/**
 * One fact about a game, small enough to sit under a thumbnail board.
 *
 * `custom` separates the two kinds. A clock and a rating status are true of
 * every game and are shown plainly; everything else on the list is a departure
 * from the normal game and is shown as one.
 */
export interface SetupBullet {
  key: string;
  /** A single glyph. Rendered beside the label, not instead of it. */
  icon: string;
  label: string;
  custom: boolean;
}

const seatLabel = (color: SideColor): string =>
  color === 'Red' ? 'Wants Red · 1st' : 'Wants Blue · 2nd';

/**
 * Everything worth knowing about a game before taking it, in reading order:
 * the two facts every game has, then each way this one departs from normal.
 *
 * Deliberately not the mode. The board beside these bullets says which mode it
 * is more clearly than a word would, and repeating it here would push the
 * unusual things — the reason this list exists — further down.
 */
export const describeSetup = (
  setup: GameSetup,
  mode: ModeDefinition | null | undefined,
  defaultTimeControl?: TimeControl | null,
): SetupBullet[] => {
  const bullets: SetupBullet[] = [
    {
      key: 'clock',
      icon: '◔',
      label: timeControlLabel(setup.timeControl ?? defaultTimeControlOf(defaultTimeControl)),
      custom: !sameTimeControl(
        setup.timeControl ?? defaultTimeControlOf(defaultTimeControl),
        defaultTimeControlOf(defaultTimeControl),
      ),
    },
    setup.casual
      ? { key: 'casual', icon: '☆', label: 'Casual', custom: true }
      : { key: 'rated', icon: '★', label: 'Rated', custom: false },
  ];
  if (hasCustomPosition(setup, mode)) {
    bullets.push({ key: 'position', icon: '▦', label: 'Custom position', custom: true });
  }
  if (setup.preferredColor) {
    bullets.push({
      key: 'seat',
      icon: '◧',
      label: seatLabel(setup.preferredColor),
      custom: true,
    });
  }
  return [...bullets, ...ruleBullets(setup.rules)];
};

/**
 * The rules this game dropped, one bullet each.
 *
 * Separate from describeSetup because the game screen has the rules and nothing
 * else: it already shows the clock and who is playing, and what it is missing is
 * what the two players agreed to change. Both go through here so a game cannot
 * describe itself one way in the lobby and another way once it starts.
 */
export const ruleBullets = (rules: RuleFlags | undefined): SetupBullet[] => {
  const bullets: SetupBullet[] = [];
  if (rules?.moveLimit) {
    bullets.push({
      key: 'moveLimit',
      icon: '⇥',
      label: `${rules.moveLimit}-move cap`,
      custom: true,
    });
  }
  if (rules?.noRepetitionDraw) {
    bullets.push({ key: 'noRepetitionDraw', icon: '↻', label: 'No repetition draw', custom: true });
  }
  if (rules?.noDrawOffers) {
    bullets.push({ key: 'noDrawOffers', icon: '½', label: 'No draw offers', custom: true });
  }
  if (rules?.noTimeExtensions) {
    bullets.push({ key: 'noTimeExtensions', icon: '⧗', label: 'No extra time', custom: true });
  }
  return bullets;
};

/** The dropped rules as one line, or empty when they are the normal ones. */
export const ruleSummary = (rules: RuleFlags | undefined): string =>
  ruleBullets(rules)
    .map((bullet) => bullet.label)
    .join(' · ');

/** The customizations alone, for a place with room for one line. */
export const setupSummary = (
  setup: GameSetup,
  mode: ModeDefinition | null | undefined,
  defaultTimeControl?: TimeControl | null,
): string =>
  describeSetup(setup, mode, defaultTimeControl)
    .map((bullet) => bullet.label)
    .join(' · ');

/** How many ways this game departs from the normal one. */
export const customizationCount = (
  setup: GameSetup,
  mode: ModeDefinition | null | undefined,
  defaultTimeControl?: TimeControl | null,
): number =>
  describeSetup(setup, mode, defaultTimeControl).filter((bullet) => bullet.custom).length;
