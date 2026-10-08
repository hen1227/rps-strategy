import type { ModeDefinition, ModeID } from '@/types/game';
import type { BotPresence, RankedMatchTerms } from '@/types/protocol';

// What RANKED does with the engines in the pit.
//
// The rule is short enough to say on the page, which is the whole reason it was
// rewritten. There used to be three ranked buttons here — a host's, PLAY NOW's
// and a challenge the other owner had a day to accept — and nobody could tell
// which one a press would be. Now there is one, and it works with any engines:
//
//   - One engine in the pit: the server draws its opponent.
//   - Two engines: those two.
//
// Either way it is one pair at a clock the server draws, both engines have to be
// entered in the ranked ladder, and two of one person's engines never rate each
// other. A host's RANKED between two engines is the exception: the host's own
// run, at whatever the host sets.
//
// Pure, so the pinned bar and the panel cannot describe the same press
// differently, and so the tests can reach it.

/** What RANKED would do with the pit as it stands. */
export type RankedPress =
  /** Nothing RANKED can do yet, and why — the hint says what to change. */
  | { kind: 'none'; reason: string }
  /** One engine: the server draws the opponent. */
  | { kind: 'random'; engine: BotPresence }
  /** Two engines: those two, now. */
  | { kind: 'chosen'; first: BotPresence; second: BotPresence }
  /** A host's run between the two engines, at the host's settings. */
  | { kind: 'host'; first: BotPresence; second: BotPresence };

/** Two engines one person registered, which the ladder never rates. */
const oneOwner = (first: BotPresence, second: BotPresence) =>
  Boolean(first.ownerUserId) && first.ownerUserId === second.ownerUserId;

export const SAME_OWNER_REASON = 'SAME OWNER · CASUAL ONLY';

/**
 * What RANKED would do with these two engines.
 *
 * Signed in, because a ranked match is credited to whoever started it, and a
 * block or a sanction has to have somebody to apply to.
 */
export const rankedPress = ({
  asHost = false,
  first,
  second,
  signedIn,
}: {
  /** The host token is unlocked, so RANKED between two engines is the host's run. */
  asHost?: boolean;
  first: BotPresence | null;
  second: BotPresence | null;
  signedIn: boolean;
}): RankedPress => {
  if (first && second) {
    if (oneOwner(first, second)) return { kind: 'none', reason: SAME_OWNER_REASON };
    if (asHost) return { kind: 'host', first, second };
  }
  if (!signedIn) return { kind: 'none', reason: 'SIGN IN TO PLAY RANKED' };
  if (first && second) return { kind: 'chosen', first, second };
  const engine = first ?? second;
  return engine ? { kind: 'random', engine } : { kind: 'none', reason: 'PICK AN ENGINE' };
};

/** The engines a press would seat, in seat order. */
const enginesOf = (press: RankedPress): BotPresence[] =>
  press.kind === 'random' ? [press.engine] : press.kind === 'none' ? [] : [press.first, press.second];

/** An engine in the press that has not entered the ranked ladder, if any. */
export const notEntered = (press: RankedPress): BotPresence | undefined =>
  press.kind === 'host' ? undefined : enginesOf(press).find((bot) => !bot.enterLadder);

/**
 * Why the ranked press cannot be made, or null when it can.
 *
 * Worded for the bar's hint line, which is capitals and short: the server
 * would refuse each of these, so the button says so before rather than after.
 */
export const rankedBlocker = ({
  available = 2,
  modeId,
  modes,
  press,
  terms,
}: {
  /** How many engines are free for a pairing, the one in the pit included. */
  available?: number;
  modeId: ModeID;
  modes: ModeDefinition[];
  press: RankedPress;
  terms: RankedMatchTerms | null;
}): string | null => {
  if (press.kind === 'none') return press.reason;
  if (press.kind === 'host') return null;
  if (!terms) return 'RANKED IS UNAVAILABLE RIGHT NOW';
  if (!terms.modes.includes(modeId)) {
    const names = terms.modes.map((id) => modes.find((mode) => mode.id === id)?.name ?? id);
    return `RANKED IS ${names.join(' OR ').toUpperCase()} ONLY`;
  }
  const missing = notEntered(press);
  if (missing) return `${missing.name.toUpperCase()} ISN'T IN THE RANKED LADDER`;
  // Nobody to draw. The server has the last word, but an empty field is the
  // case worth saying before the press rather than after it.
  if (press.kind === 'random' && available < 2) return 'NO OTHER ENGINE IS FREE';
  return null;
};

/** The ranked press in a few words, for the pinned bar. */
export const rankedLine = (press: RankedPress, terms: RankedMatchTerms | null): string => {
  if (press.kind === 'none' || press.kind === 'host' || !terms) return '';
  const games = `${terms.pairs * 2} games`;
  return press.kind === 'random' ? `${games} vs a random opponent` : games;
};

/** The button for a ranked press, and what it does for a screen reader. */
export const rankedButton = (press: RankedPress): { label: string; action: string } => {
  const label = 'START RANKED ▶';
  switch (press.kind) {
    case 'random':
      return { label, action: `Start a ranked match: ${press.engine.name} against a random opponent` };
    case 'chosen':
    case 'host':
      return { label, action: `Start a ranked match: ${press.first.name} against ${press.second.name}` };
    default:
      return { label, action: 'Start a ranked match' };
  }
};
