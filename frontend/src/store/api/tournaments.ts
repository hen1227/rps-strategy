import { apiClient } from './http';
import type { ModeID } from '@/types/game';
import type {
  Tournament,
  TournamentField,
  TournamentFormat,
  TournamentMatchResult,
  TournamentSeeding,
  TournamentStatus,
} from '@/types/protocol';

const request = apiClient('tournament server');

export const listTournaments = () =>
  request<Tournament[]>('/api/tournaments', { what: 'Loading tournaments' });

export const verifyAdminToken = (adminToken: string) =>
  request<unknown>('/api/admin/session', { token: adminToken, what: 'Checking the host token' });

/**
 * Every decision a host makes about an event.
 *
 * All optional, because the builder saves one field at a time: an absent field
 * on an update keeps whatever is stored. A create needs `modeId` and nothing
 * else — a tournament with no game is not a draft of anything.
 *
 * What is *editable* depends on how far along the event is, and the server
 * decides that rather than this module. In short: everything while it is a
 * draft; the words, the intended start and the cap once people can enter; the
 * words alone once it has started. See UpdateTournament on the Go side.
 */
export interface TournamentConfig {
  name?: string;
  description?: string;
  modeId?: ModeID;
  format?: TournamentFormat;
  field?: TournamentField;
  seeding?: TournamentSeeding;
  /** Zero is uncapped. */
  maxPlayers?: number;
  /** Zero derives the round count from the field size. */
  swissRounds?: number;
  /**
   * How many games one pairing plays. Zero and one both mean a single game;
   * anything above ten is clamped to ten by the server.
   */
  gamesPerMatch?: number;
  /** Zero means the server's default clock. */
  initialTimeMs?: number;
  incrementMs?: number;
  startsAtUnixMs?: number;
  /**
   * Remove a start time that was previously set. Needed because an absent
   * `startsAtUnixMs` already means "leave it alone", and the two intentions
   * are not the same.
   */
  clearStartsAt?: boolean;
}

/**
 * Write a new event down, as a draft.
 *
 * It is not public and takes no signups until `publishTournament`. That is the
 * whole point of the split: a host can create it half-decided and finish
 * deciding later.
 */
export const createTournament = (adminToken: string, config: TournamentConfig) =>
  request<Tournament>('/api/admin/tournaments', {
    method: 'POST',
    token: adminToken,
    body: config,
    what: 'Creating the tournament',
  });

/** The host's board: every event, drafts included. */
export const listAdminTournaments = (adminToken: string) =>
  request<Tournament[]>('/api/admin/tournaments', {
    token: adminToken,
    what: 'Loading the tournaments',
  });

export const updateTournament = (
  adminToken: string,
  tournamentId: string,
  config: TournamentConfig,
) =>
  request<Tournament>(`/api/admin/tournaments/${encodeURIComponent(tournamentId)}`, {
    method: 'PATCH',
    token: adminToken,
    body: config,
    what: 'Saving the tournament',
  });

/** Open registration and put the event on the public board. */
export const publishTournament = (adminToken: string, tournamentId: string) =>
  request<Tournament>(
    `/api/admin/tournaments/${encodeURIComponent(tournamentId)}/publish`,
    { method: 'POST', token: adminToken, what: 'Publishing the tournament' },
  );

/**
 * Take an event back off the board and into draft.
 *
 * Only while nobody has entered. Once somebody has signed up, withdrawing the
 * event from under them is a cancellation and the server says so.
 */
export const unpublishTournament = (adminToken: string, tournamentId: string) =>
  request<Tournament>(
    `/api/admin/tournaments/${encodeURIComponent(tournamentId)}/publish`,
    { method: 'DELETE', token: adminToken, what: 'Unpublishing the tournament' },
  );

/**
 * Call an event off, keeping everything that was played.
 *
 * The rows stay: entrants, schedule, and whatever results were recorded before
 * it stopped. A page that says "cancelled after round two, here is where it
 * stood" is the honest record, and the people in those games played them.
 */
export const cancelTournament = (
  adminToken: string,
  tournamentId: string,
  reason?: string,
) =>
  request<Tournament>(
    `/api/admin/tournaments/${encodeURIComponent(tournamentId)}/cancel`,
    {
      method: 'POST',
      token: adminToken,
      body: { reason: reason ?? '' },
      what: 'Cancelling the tournament',
    },
  );

/**
 * Take a finished event off the public board, or put it back.
 *
 * The tidying tool, and the one to reach for before deleting. A hidden event is
 * still readable at its address, still on its entrants' profile pages, and
 * still counted in the totals — it is not listed, and that is the whole of it.
 *
 * Only a finished or cancelled event can be hidden. One taking signups or being
 * played is something people need to find, and hiding it would take it out of
 * the broadcast its own participants read their next match from.
 */
export const setTournamentHidden = (
  adminToken: string,
  tournamentId: string,
  hidden: boolean,
) =>
  request<Tournament>(
    `/api/admin/tournaments/${encodeURIComponent(tournamentId)}/hide`,
    {
      method: hidden ? 'POST' : 'DELETE',
      token: adminToken,
      what: hidden ? 'Hiding the tournament' : 'Restoring the tournament',
    },
  );

/** What a delete removed, so the host can be told rather than left to guess. */
export interface TournamentDeletion {
  tournamentId: string;
  name: string;
  status: TournamentStatus;
  playersDeleted: number;
  matchesDeleted: number;
  byesDeleted: number;
  /**
   * Whoever won it, when it was a finished event.
   *
   * Reported because of a consequence that is otherwise invisible: the
   * Tournament Champion title is recomputed from the tournament table rather
   * than stored, so deleting the event takes the title away from whoever won
   * it. The screen says so before the second press.
   */
  championUserIds?: string[];
  /**
   * Recorded games that mentioned this event and are staying.
   *
   * They are not the tournament's to delete: two people played them, they are
   * in both histories and in the archive, and the ratings they moved have
   * already moved. The schedule that arranged them is what goes.
   */
  gamesKept: number;
}

/**
 * Delete an event and everything scheduling it.
 *
 * Any event, at any stage. The entrants, the schedule and the byes go; the
 * games stay. Prefer `setTournamentHidden` for anything worth keeping — see
 * `TournamentDeletion.championUserIds` for the part that is easy to miss.
 */
export const deleteTournament = (adminToken: string, tournamentId: string) =>
  request<TournamentDeletion>(
    `/api/admin/tournaments/${encodeURIComponent(tournamentId)}`,
    { method: 'DELETE', token: adminToken, what: 'Deleting the tournament' },
  );

/** Remove an entrant during registration. */
export const withdrawTournamentPlayer = (
  adminToken: string,
  tournamentId: string,
  playerId: number,
) =>
  request<Tournament>(
    `/api/admin/tournaments/${encodeURIComponent(tournamentId)}/players/${playerId}`,
    { method: 'DELETE', token: adminToken, what: 'Withdrawing the player' },
  );

/**
 * Build the next round of an elimination bracket or a Swiss by hand.
 *
 * The rounds normally build themselves as results land, so this is a repair
 * tool: it un-sticks an event whose round finished while the server could not
 * write to its database.
 */
export const advanceTournament = (adminToken: string, tournamentId: string) =>
  request<Tournament>(
    `/api/admin/tournaments/${encodeURIComponent(tournamentId)}/advance`,
    { method: 'POST', token: adminToken, what: 'Advancing the tournament' },
  );

export interface TournamentSignup {
  userId: string;
  ign: string;
  discord: string;
  agreedToUnfilteredChat: boolean;
  reservationToken?: string;
}

/** Enter yourself. */
export const signupForTournament = (tournamentId: string, signup: TournamentSignup) =>
  request<Tournament>(`/api/tournaments/${encodeURIComponent(tournamentId)}/signups`, {
    method: 'POST',
    body: signup,
    what: 'Registering',
  });

/**
 * Take your own entry back out.
 *
 * Registration only — once the pairings exist, every other entrant's schedule
 * is built around your name being in it, and the host is the only one who can
 * unpick that.
 *
 * Your own, and not your engines'. There is no per-event door for an engine in
 * either direction: it is entered by having its `enterTournaments` switch on
 * when an event starts, and it leaves by having it off. A withdrawal would last
 * only until the next sweep looked.
 */
export const withdrawFromTournament = (sessionToken: string, tournamentId: string) =>
  request<Tournament>(`/api/tournaments/${encodeURIComponent(tournamentId)}/signups`, {
    method: 'DELETE',
    token: sessionToken,
    what: 'Withdrawing',
  });

export const startTournament = (adminToken: string, tournamentId: string) =>
  request<Tournament>(`/api/admin/tournaments/${encodeURIComponent(tournamentId)}/start`, {
    method: 'POST',
    token: adminToken,
    what: 'Starting the tournament',
  });

export const setMatchResult = (
  adminToken: string,
  tournamentId: string,
  matchId: number,
  result: TournamentMatchResult,
) =>
  request<Tournament>(
    `/api/admin/tournaments/${encodeURIComponent(tournamentId)}/matches/${matchId}`,
    {
      method: 'PATCH',
      token: adminToken,
      body: { result },
      what: 'Recording the result',
    },
  );
