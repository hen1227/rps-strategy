// What is happening on the server right now, derived once.
//
// The desktop rail, the phone's collapsed summary bar, and — later — the game
// screen all want the same handful of answers, and three copies of "which of
// these live games is a bot fight" is how one of them ends up counting a
// tournament board twice. Pure functions over store state, in the same spirit
// as `store/tournamentSelectors.ts`.

import { isOpenChallenge } from '@/types/protocol';
import type { BotPresence, Challenge, LiveGameSummary, Tournament } from '@/types/protocol';
import type { ModeDefinition, ModeID } from '@/types/game';

/** Somebody who wants a game and has not got one. */
export interface WaitingSeat {
  /** Stable across renders: the id of the seek behind it. */
  key: string;
  /** Who is waiting. */
  label: string;
  /** The mode they are waiting in, so joining them needs no parsing. */
  modeId: ModeID;
  /** The game on offer. Every waiting seat has one, and it is takeable. */
  challenge: Challenge;
  /**
   * The mode its setup names, resolved here rather than by each screen. A board
   * thumbnail needs the definition to tint itself, and a screen that looked it
   * up would be the second place that knows how.
   */
  mode: ModeDefinition | null;
  /**
   * True when this is the viewer's own row. It stays on the board rather than
   * being hidden — seeing your own game waiting is the point of posting it —
   * but it is offered as something to cancel, not to accept, since the server
   * refuses anybody playing themselves.
   */
  mine: boolean;
  /** How many people this row stands for. Always one: every row is a person. */
  count: number;
}

export interface LiveSnapshot {
  /** People connected to the lobby, however they are spending their time. */
  onlineCount: number;
  /** Games between people. */
  playerGames: LiveGameSummary[];
  /** Games that are one game of a bot-versus-bot series. */
  botFights: LiveGameSummary[];
  /** People practising against a bot in their own browser. */
  botPlayerCount: number;
  /** Engines connected from somebody's machine. */
  connectedBots: BotPresence[];
  /** Open challenges plus anyone sitting in matchmaking. */
  waiting: WaitingSeat[];
  /** The tournament worth mentioning, if any. */
  activeTournament: Tournament | null;
}

/** The slice of the store this module reads. Narrow on purpose: it is testable. */
export interface LiveSource {
  /** Who is looking. Decides which open challenge is the viewer's own. */
  accountId: string;
  onlineCount: number;
  liveGames: LiveGameSummary[];
  botPlayerCount: number;
  engineBots: BotPresence[];
  openChallenges: Challenge[];
  tournaments: Tournament[];
  modes: ModeDefinition[];
}

/**
 * A tournament is worth a line in the rail when it is running, and otherwise
 * when its signup is open. A completed event is history and belongs on its own
 * page.
 */
const activeTournamentOf = (tournaments: Tournament[]): Tournament | null =>
  tournaments.find((tournament) => tournament.status === 'in_progress') ??
  tournaments.find((tournament) => tournament.status === 'registration') ??
  null;

export const liveSnapshot = (source: LiveSource): LiveSnapshot => {
  const playerGames: LiveGameSummary[] = [];
  const botFights: LiveGameSummary[] = [];
  for (const liveGame of source.liveGames ?? []) {
    // `series` is the server's own marker that a row is one game of a run, so
    // splitting on it needs no guess about who the players are.
    (liveGame.series ? botFights : playerGames).push(liveGame);
  }

  // One list, because there is one thing to list. Matchmaking used to be an
  // anonymous count beside these rows, which double-counted everybody: a person
  // pressing play and a person posting a game now produce the same kind of
  // seek, and the server publishes both here by name.
  //
  // Searching players first. Somebody who pressed play is sitting there
  // expecting a game right now; a posted game will wait ten minutes for one.
  const waiting: WaitingSeat[] = (source.openChallenges ?? [])
    .filter(isOpenChallenge)
    .map((challenge) => ({
      key: challenge.id,
      label: challenge.challenger.username || 'Someone',
      modeId: challenge.setup.modeId,
      challenge,
      mode: (source.modes ?? []).find((mode) => mode.id === challenge.setup.modeId) ?? null,
      mine: challenge.challenger.userId === source.accountId,
      count: 1,
    }))
    .sort(
      (first, second) =>
        Number(Boolean(second.challenge.queued)) - Number(Boolean(first.challenge.queued)),
    );

  return {
    onlineCount: source.onlineCount ?? 0,
    playerGames,
    botFights,
    botPlayerCount: source.botPlayerCount ?? 0,
    connectedBots: source.engineBots ?? [],
    waiting,
    activeTournament: activeTournamentOf(source.tournaments ?? []),
  };
};

/** How many people the snapshot says are waiting for an opponent. */
export const waitingCount = (snapshot: LiveSnapshot): number =>
  snapshot.waiting.reduce((total, seat) => total + seat.count, 0);

/**
 * The one line a phone has room for.
 *
 * Only the parts that are non-zero, so a quiet server reads "3 online" rather
 * than "3 online · 0 live · 0 waiting", which looks broken.
 */
export const liveHeadline = (snapshot: LiveSnapshot): string => {
  const parts = [`${snapshot.onlineCount} online`];
  const live = snapshot.playerGames.length + snapshot.botFights.length;
  if (live > 0) parts.push(`${live} live`);
  const waiting = waitingCount(snapshot);
  if (waiting > 0) parts.push(`${waiting} waiting`);
  if (snapshot.activeTournament?.status === 'in_progress') parts.push('tournament on');
  return parts.join(' · ');
};
