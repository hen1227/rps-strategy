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
  // A draft only ever reaches an administrator — the public board and the
  // socket broadcast both filter them out — so this label is only ever read on
  // the admin screen. It is here rather than there so that every status is
  // described in one place.
  draft: { label: 'DRAFT', tone: 'neutral' },
  registration: { label: 'REGISTRATION OPEN', tone: 'accent' },
  in_progress: { label: 'IN PROGRESS', tone: 'warm' },
  completed: { label: 'COMPLETE', tone: 'cool' },
  cancelled: { label: 'CANCELLED', tone: 'live' },
};

/**
 * Whether an event is one of the recurring weekend bot arenas.
 *
 * They ride the same broadcast as every other tournament — which is what gives
 * the weekend page live boards for free — and are filtered out of the lists
 * that are *about* tournaments. One a day would bury the events people came
 * for, and the weekend arena has a page of its own.
 */
export const isWeekendArena = (tournament: Tournament | null | undefined) =>
  // The stored kind still reads "nightly", from the year this ran every night.
  // See TournamentKind in the backend for why renaming it would rewrite history.
  tournament?.kind === 'nightly';

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

/**
 * The entry this account is answerable for: their own, or their bot's.
 *
 * The pair to `signupFor`, and the difference matters on exactly one screen
 * state — an owner who entered an engine is *in*, and a page that only compared
 * their own account id would keep offering them the registration form for an
 * event they have already filled their one place in.
 *
 * Deliberately not used for pairings. A bot's matches belong to the bot, which
 * turns up for them by itself; giving its owner a Ready button would be
 * offering to play somebody else's game.
 */
export const entryFor = (
  tournament: Tournament | null | undefined,
  accountId: string | null | undefined,
  botUserIds: readonly string[] = [],
): TournamentPlayer | null => {
  const own = signupFor(tournament, accountId);
  if (own) return own;
  if (botUserIds.length === 0) return null;
  return (
    tournament?.players?.find((player) => botUserIds.includes(player.userId)) ?? null
  );
};

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

/** A score as a table writes it: whole numbers, halves as ½. */
const scorePart = (points: number) => {
  const whole = Math.floor(points);
  const half = points - whole >= 0.5;
  if (!half) return String(whole);
  return whole === 0 ? '½' : `${whole}½`;
};

/**
 * The running score of a pairing that plays more than one game, or null when
 * there is nothing to say.
 *
 * Null rather than "0–0" on a match that has not started, and null on the
 * ordinary one-game match, where `matchResultLabel` already says everything and
 * a score line would be noise on every row of every event.
 */
export const matchScoreLabel = (
  tournament: Tournament | null | undefined,
  match: TournamentMatch,
): string | null => {
  const target = tournament?.gamesPerMatch ?? 1;
  const played = match.gamesPlayed ?? 0;
  if (target <= 1 || played === 0) return null;
  const score = `${scorePart(match.player1Points ?? 0)}–${scorePart(match.player2Points ?? 0)}`;
  return played >= target ? score : `${score} after ${played} of ${target}`;
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
//
// "Playing in" counts an engine this account entered. The owner has no button
// to press for it — see `entryFor` — but an event their bot is competing in is
// the one they most want on the front page, and ranking it below a stranger's
// live game would bury it.
const homeRank = (
  tournament: Tournament,
  accountId: string | null | undefined,
  botUserIds: readonly string[],
) => {
  const entered = Boolean(entryFor(tournament, accountId, botUserIds));
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
  botUserIds: readonly string[] = [],
): Tournament[] =>
  (tournaments ?? [])
    .filter((tournament) => {
      // The weekend arena has its own page and its own countdown; putting it in the
      // home rotation as well would mean the front page carries it every day.
      if (isWeekendArena(tournament)) return false;
      if (tournament.status === 'registration') return true;
      if (tournament.status === 'completed') return false;
      return (
        Boolean(entryFor(tournament, accountId, botUserIds)) ||
        liveMatchesOf(tournament).length > 0
      );
    })
    .sort(
      (first, second) =>
        homeRank(first, accountId, botUserIds) - homeRank(second, accountId, botUserIds),
    )
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
    .filter((tournament) => tournament.status === 'completed' && !isWeekendArena(tournament))
    .sort(
      (first, second) =>
        (second.completedAtUnixMs ?? second.createdAtUnixMs) -
        (first.completedAtUnixMs ?? first.createdAtUnixMs),
    );

/** Events still worth acting on: signups open, or a round in progress. */
export const currentTournaments = (
  tournaments: Tournament[] | null | undefined,
): Tournament[] =>
  (tournaments ?? []).filter(
    (tournament) => tournament.status !== 'completed' && !isWeekendArena(tournament),
  );

/** Who won, when an event has finished and anybody played in it. */
export const championOf = (tournament: Tournament): string | null =>
  tournament.status === 'completed' ? tournament.standings?.[0]?.ign ?? null : null;

/** How many home-screen tournaments were left off by the cap. */
export const hiddenHomeTournamentCount = (
  tournaments: Tournament[] | null | undefined,
  accountId: string | null | undefined,
  limit = 3,
  botUserIds: readonly string[] = [],
) =>
  Math.max(
    0,
    homeTournaments(tournaments, accountId, Infinity, botUserIds).length - limit,
  );
