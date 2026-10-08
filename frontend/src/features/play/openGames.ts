import { isOpenChallenge, type Challenge } from '@/types/protocol';

// Every game request the lobby has to show, in the one order it shows them.
//
// There used to be two places for these, at opposite ends of the page. A
// challenge addressed to you, and your own game waiting for an answer, opened a
// panel at the very top — which pushed the whole lobby down the screen at the
// moment one arrived. Everybody else's open games were a panel at the very
// bottom, which on a phone meant nobody knew somebody was waiting unless they
// scrolled past everything else to find out. Now they are one strip near the
// top that keeps its height whatever it holds, so a request arriving changes
// the strip and nothing around it.

export type OpenGameCard =
  /** Addressed to you, by name. */
  | { kind: 'incoming'; key: string; challenge: Challenge }
  /** Yours, waiting for somebody to take it. */
  | { kind: 'outgoing'; key: string; challenge: Challenge }
  /** Why your last search or challenge ended, when it ended without a game. */
  | { kind: 'notice'; key: string; message: string }
  /** Somebody else's, and anyone may take it. */
  | { kind: 'open'; key: string; challenge: Challenge };

export interface OpenGamesSource {
  incomingChallenges: readonly Challenge[];
  outgoingChallenge: Challenge | null;
  openChallenges: readonly Challenge[];
  challengeNotice: string | null;
  accountId: string | null;
}

/**
 * The strip's cards, first to last.
 *
 * What is yours to answer comes first, then your own game, then the reason a
 * search ended. Everybody else's follow oldest first, so that a new arrival
 * joins the end of the row rather than sliding every card under somebody's
 * finger one place along — the row is the one thing on the page that moves,
 * and it moves by growing at the end.
 *
 * Your own search is not a card: the floating bar at the foot of every screen
 * is where a search lives, and a second copy here would be a card offering to
 * play yourself. Your own posted game appears once, as the outgoing card, even
 * though the server lists it among the open games too.
 */
export const openGameCards = (source: OpenGamesSource): OpenGameCard[] => {
  const incomingIds = new Set(source.incomingChallenges.map((challenge) => challenge.id));
  const outgoing = source.outgoingChallenge;

  const others = source.openChallenges
    .filter(isOpenChallenge)
    .filter(
      (challenge) =>
        challenge.challenger.userId !== source.accountId &&
        challenge.id !== outgoing?.id &&
        !incomingIds.has(challenge.id),
    )
    .slice()
    .sort(
      (first, second) =>
        (first.createdAtUnixMs ?? 0) - (second.createdAtUnixMs ?? 0) ||
        first.id.localeCompare(second.id),
    );

  return [
    ...source.incomingChallenges.map(
      (challenge): OpenGameCard => ({ kind: 'incoming', key: `in:${challenge.id}`, challenge }),
    ),
    ...(outgoing
      ? [{ kind: 'outgoing', key: `out:${outgoing.id}`, challenge: outgoing } as const]
      : []),
    ...(source.challengeNotice?.trim()
      ? [{ kind: 'notice', key: 'notice', message: source.challengeNotice.trim() } as const]
      : []),
    ...others.map(
      (challenge): OpenGameCard => ({ kind: 'open', key: `open:${challenge.id}`, challenge }),
    ),
  ];
};
