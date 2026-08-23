// Pure derivations over the tournament board. Every screen asks these
// questions instead of re-deriving them, so the home screen, the tournament
// screen, and the persistent match call-out always agree.

import type { BadgeTone } from '@/ui/tones';
import type {
  Tournament,
  TournamentMatch,
  TournamentMatchState,
  TournamentPlayer,
  TournamentStatus,
} from '@/types/protocol';

export interface StatusBadge {
  label: string;
  tone: BadgeTone;
}

export const TOURNAMENT_STATUS: Record<TournamentStatus, StatusBadge> = {
  registration: { label: 'REGISTRATION OPEN', tone: 'accent' },
  in_progress: { label: 'IN PROGRESS', tone: 'warm' },
  completed: { label: 'COMPLETE', tone: 'cool' },
};

export const statusOf = (tournament: Tournament | null | undefined): StatusBadge =>
  TOURNAMENT_STATUS[tournament?.status as TournamentStatus] ?? TOURNAMENT_STATUS.registration;

const EMPTY_MATCH_STATE: TournamentMatchState = {
  matchId: 0,
  live: false,
  gameId: '',
  readyUserIds: [],
};

/** Live state (readiness, running game) for one scheduled match. */
export const matchStateFor = (
  tournament: Tournament | null | undefined,
  matchId: number,
): TournamentMatchState =>
  tournament?.matchStates?.find((state) => state.matchId === matchId) ?? EMPTY_MATCH_STATE;

export const signupFor = (
  tournament: Tournament | null | undefined,
  accountId: string | null | undefined,
): TournamentPlayer | null =>
  tournament?.players?.find((player) => player.userId === accountId) ?? null;

/** The requesting player's seat in a match, plus their opponent. */
export interface MatchSeats {
  me: TournamentPlayer;
  opponent: TournamentPlayer;
}

export const seatsFor = (
  match: TournamentMatch | null | undefined,
  accountId: string | null | undefined,
): MatchSeats | null => {
  if (!match || !accountId) return null;
  if (match.player1?.userId === accountId) {
    return { me: match.player1, opponent: match.player2 };
  }
  if (match.player2?.userId === accountId) {
    return { me: match.player2, opponent: match.player1 };
  }
  return null;
};

export const matchesOf = (tournament: Tournament | null | undefined): TournamentMatch[] =>
  tournament?.matches ?? [];

export const pendingMatchesFor = (
  tournament: Tournament | null | undefined,
  accountId: string | null | undefined,
) =>
  matchesOf(tournament).filter(
    (match) => match.result === 'pending' && seatsFor(match, accountId),
  );

/** Matches with a game running right now, newest schedule slot last. */
export const liveMatchesOf = (tournament: Tournament | null | undefined) =>
  matchesOf(tournament).filter((match) => matchStateFor(tournament, match.matchId).live);

export const playedMatchCount = (tournament: Tournament | null | undefined) =>
  matchesOf(tournament).filter((match) => match.result !== 'pending').length;

export const roundsOf = (
  tournament: Tournament | null | undefined,
): [number, TournamentMatch[]][] => {
  const rounds = new Map<number, TournamentMatch[]>();
  for (const match of matchesOf(tournament)) {
    const matches = rounds.get(match.roundNumber) ?? [];
    matches.push(match);
    rounds.set(match.roundNumber, matches);
  }
  return Array.from(rounds.entries());
};

export const matchResultLabel = (match: TournamentMatch) => {
  if (match.result === 'draw') return 'Drawn';
  if (match.result === 'player1_win') return `${match.player1?.ign} won`;
  if (match.result === 'player2_win') return `${match.player2?.ign} won`;
  return 'Not played yet';
};

// Call-to-action kinds, most urgent first. The persistent banner and the home
// screen both render whichever of these is outstanding.
const CALL_ORDER = ['play', 'ready', 'waiting', 'start'] as const;

/** What this player has to do about one match. */
export type CallKind = (typeof CALL_ORDER)[number];

export interface TournamentCall {
  kind: CallKind;
  tournamentId: string;
  tournamentName: string;
  modeName: string;
  matchId: number;
  match: TournamentMatch;
  opponent: TournamentPlayer;
}

const callForMatch = (
  tournament: Tournament,
  match: TournamentMatch,
  accountId: string,
): TournamentCall | null => {
  const seats = seatsFor(match, accountId);
  if (!seats) return null;
  const state = matchStateFor(tournament, match.matchId);
  const readyUserIds = state.readyUserIds ?? [];
  const iAmReady = readyUserIds.includes(accountId);
  const opponentReady = readyUserIds.includes(seats.opponent.userId);

  let kind: CallKind = 'start';
  if (state.live) kind = 'play';
  else if (opponentReady && !iAmReady) kind = 'ready';
  else if (iAmReady) kind = 'waiting';

  return {
    kind,
    tournamentId: tournament.tournamentId,
    tournamentName: tournament.name,
    modeName: tournament.modeName,
    matchId: match.matchId,
    match,
    opponent: seats.opponent,
  };
};

/**
 * The one thing this account should do next across every running tournament:
 * join a live board, answer a waiting opponent, or open their next match.
 */
export const tournamentCallToAction = (
  tournaments: Tournament[] | null | undefined,
  accountId: string | null | undefined,
): TournamentCall | null => {
  if (!accountId) return null;
  let best: TournamentCall | null = null;
  for (const tournament of tournaments ?? []) {
    if (tournament.status !== 'in_progress' || !signupFor(tournament, accountId)) continue;
    for (const match of pendingMatchesFor(tournament, accountId)) {
      const call = callForMatch(tournament, match, accountId);
      if (!call) continue;
      if (
        !best ||
        CALL_ORDER.indexOf(call.kind) < CALL_ORDER.indexOf(best.kind) ||
        (call.kind === best.kind && call.matchId < best.matchId)
      ) {
        best = call;
      }
    }
  }
  return best;
};

export interface CallCopy {
  title: (call: TournamentCall) => string;
  detail: (call: TournamentCall) => string;
  action: string;
}

export const CALL_TO_ACTION_COPY: Record<CallKind, CallCopy> = {
  play: {
    title: (call: TournamentCall) => `Your match against ${call.opponent?.ign ?? 'your opponent'} is live`,
    detail: (call: TournamentCall) => `${call.tournamentName} · your board is waiting`,
    action: 'PLAY NOW',
  },
  ready: {
    title: (call: TournamentCall) => `${call.opponent?.ign ?? 'Your opponent'} is ready to play you`,
    detail: (call: TournamentCall) => `${call.tournamentName} · ${call.modeName}`,
    action: 'PLAY NOW',
  },
  waiting: {
    title: (call: TournamentCall) => `Waiting for ${call.opponent?.ign ?? 'your opponent'}`,
    detail: (call: TournamentCall) => `${call.tournamentName} · you are ready, the match starts when they are`,
    action: 'LEAVE QUEUE',
  },
  start: {
    title: (call: TournamentCall) => `You are due to play ${call.opponent?.ign ?? 'your opponent'}`,
    detail: (call: TournamentCall) => `${call.tournamentName} · ${call.modeName}`,
    action: 'READY UP',
  },
};

// Home screen priority: an event this player is playing in outranks an open
// signup, which outranks someone else's live game.
const homeRank = (tournament: Tournament, accountId: string | null | undefined) => {
  const entered = Boolean(signupFor(tournament, accountId));
  if (tournament.status === 'in_progress' && entered) return 0;
  if (tournament.status === 'registration') return entered ? 1 : 2;
  return 3;
};

/**
 * Tournaments worth putting on the home screen: signups that are open, events
 * this player is part of, and anything with a game running to watch. Capped so
 * a busy board cannot push the rest of the lobby off the screen.
 */
export const homeTournaments = (
  tournaments: Tournament[] | null | undefined,
  accountId: string | null | undefined,
  limit = 3,
): Tournament[] =>
  (tournaments ?? [])
    .filter((tournament) => {
      if (tournament.status === 'registration') return true;
      if (tournament.status === 'completed') return false;
      return Boolean(signupFor(tournament, accountId)) || liveMatchesOf(tournament).length > 0;
    })
    .sort((first, second) => homeRank(first, accountId) - homeRank(second, accountId))
    .slice(0, limit);

/**
 * Events that are over, most recent first.
 *
 * The counterpart to `homeTournaments`, which deliberately drops `completed`
 * because the home screen is about what needs attention. A finished event needs
 * none, but it is the only record of who won, so it belongs on the tournament
 * board rather than nowhere.
 */
export const pastTournaments = (
  tournaments: Tournament[] | null | undefined,
): Tournament[] =>
  (tournaments ?? [])
    .filter((tournament) => tournament.status === 'completed')
    .sort(
      (first, second) =>
        (second.completedAtUnixMs ?? second.createdAtUnixMs) -
        (first.completedAtUnixMs ?? first.createdAtUnixMs),
    );

/** Events still worth acting on: signups open, or a round in progress. */
export const currentTournaments = (
  tournaments: Tournament[] | null | undefined,
): Tournament[] =>
  (tournaments ?? []).filter((tournament) => tournament.status !== 'completed');

/** Who won, when an event has finished and anybody played in it. */
export const championOf = (tournament: Tournament): string | null =>
  tournament.status === 'completed' ? tournament.standings?.[0]?.ign ?? null : null;

/** How many home-screen tournaments were left off by the cap. */
export const hiddenHomeTournamentCount = (
  tournaments: Tournament[] | null | undefined,
  accountId: string | null | undefined,
  limit = 3,
) =>
  Math.max(0, homeTournaments(tournaments, accountId, Infinity).length - limit);
