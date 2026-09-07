// The weekend bot arena.
//
// One read for the whole page and one write per vote, which is the shape the
// server offers: a countdown that arrives a beat before the thing it counts
// down to is worse than no countdown, so the page asks once and gets all of it.

import { apiClient } from './http';
import type { ModeID } from '@/types/game';
import type { Tournament } from '@/types/protocol';

const request = apiClient('tournament server');

/** One option's standing in a poll. */
export interface WeekendTally {
  choice: string;
  votes: number;
}

export interface WeekendPoll {
  /** The whole ballot in its fixed order, so an option with no votes is still clickable. */
  options: string[];
  tallies: WeekendTally[];
  /** What you voted for, empty when you have not. */
  mine: string;
  /**
   * What would win if the poll closed now — not always the top tally, because a
   * thin turnout or a tie falls back to the host's default.
   */
  leading: string;
  votes: number;
  /** The turnout the ballot has to reach before it carries. */
  minimumVotes: number;
  open: boolean;
  /** Zero for a poll that never closes. */
  closesAtUnixMs?: number;
}

/** An engine on the roster, with the reason it will not be entered if there is one. */
export interface WeekendEngine {
  name: string;
  userId: string;
  author: string;
  online: boolean;
  reason?: string;
}

/** Whoever holds the rolling weekend crown. Shared on a tie. */
export interface WeekendCrown {
  userId: string;
  name: string;
  wins: number;
}

/** One slot of the voting window. */
export interface WeekendSlot {
  /**
   * An offset into the host's window, which is what a vote sends back.
   *
   * Never shown. `atUnixMs` is the next instant it falls on, and that is what a
   * page prints — formatted locally, weekday and all. That is the whole reason
   * a weekly event can be voted on at all: "Saturday 21:00" in the host's zone
   * is Sunday somewhere, and only the instant survives the trip.
   */
  slot: number;
  atUnixMs: number;
  people: number;
  mine: boolean;
}

export interface WeekendAvailability {
  slots: WeekendSlot[];
  /** How many people have answered at all — the denominator beside each slot. */
  answered: number;
  /** The slot that would be chosen now. A tie or a thin turnout holds the current one. */
  leading: number;
  leadingAtUnixMs: number;
  /** How many slots you have marked. */
  mine: number;
}

export interface WeekendView {
  enabled: boolean;
  zone: string;
  startLocal: string;
  /** The weekday it runs on in the host's zone, 0 = Sunday. */
  startDay: number;
  modeId: ModeID;
  modeName: string;
  doorsAtUnixMs?: number;
  startsAtUnixMs?: number;
  eventDate?: string;
  minimumField: number;
  gamesPerMatch: number;
  roundRobinMax: number;
  /** This weekend's event once its doors are open, and absent before. */
  tournament?: Tournament;
  expected: WeekendEngine[];
  clock: WeekendPoll;
  availability: WeekendAvailability;
  recent: Tournament[];
  crown: WeekendCrown[];
}

/** Every setting that outlives one event. */
export interface WeekendConfig {
  enabled: boolean;
  zone: string;
  startLocal: string;
  /** The weekday it runs on, 0 = Sunday. */
  startDay: number;
  /** The first slot of the voting window; it runs 36 hours from there. */
  windowOpensDay: number;
  windowOpensHour: number;
  modeId: ModeID;
  minimumField: number;
  doorsMinutes: number;
  pollClosesMinutes: number;
  gamesPerMatch: number;
  roundRobinMax: number;
  pollEnabled: boolean;
  defaultControl: string;
  minimumVotes: number;
  graceSeconds: number;
  /** A single local date the host has called off, "YYYY-MM-DD". */
  skipDate: string;
  /** The scheduler's own bookkeeping. Read-only: a save never sends it back. */
  lastRunDate: string;
  updatedAtUnixMs: number;
}

export interface WeekendControl {
  key: string;
  initialTimeMs: number;
  incrementMs: number;
}

export interface WeekendAdminView {
  config: WeekendConfig;
  controls: WeekendControl[];
  /** How long the voting window is. The server owns the number; this reads it. */
  windowHours: number;
}

const emptyPoll = (): WeekendPoll => ({
  options: [],
  tallies: [],
  mine: '',
  leading: '',
  votes: 0,
  minimumVotes: 0,
  open: false,
});

const emptyAvailability = (): WeekendAvailability => ({
  slots: [],
  answered: 0,
  leading: 0,
  leadingAtUnixMs: 0,
  mine: 0,
});

/**
 * Fill in everything the reply did not send.
 *
 * One place rather than a `?.` at every read, and it earns its keep twice over.
 * Go marshals an empty slice as `null`, so a list nobody has added to arrives
 * missing rather than empty. And a *older server* — a backend that has not been
 * restarted since the client was rebuilt, which on a dev machine is most of the
 * time — sends a shape this build has never heard of. Neither should be able to
 * blank the page: a weekend arena with a section missing is worth reading, and a
 * white screen is not.
 *
 * Both of those have already happened here. This is the fix for the class, not
 * for the two instances.
 */
const normalize = (view: WeekendView): WeekendView => ({
  ...view,
  expected: view.expected ?? [],
  recent: view.recent ?? [],
  crown: view.crown ?? [],
  clock: { ...emptyPoll(), ...(view.clock ?? {}) },
  availability: {
    ...emptyAvailability(),
    ...(view.availability ?? {}),
    slots: view.availability?.slots ?? [],
  },
});

/**
 * The page, in one request.
 *
 * The session token is optional and only decides whether the reply can show you
 * your own vote — the page itself is readable by anybody.
 */
export const loadWeekend = (sessionToken?: string | null) =>
  request<WeekendView>('/api/weekend', {
    token: sessionToken ?? undefined,
    what: 'Loading the weekend arena',
  }).then(normalize);

/**
 * Cast or change a vote. Answers with the page again, so a client never has to
 * ask twice to redraw.
 */
export const castWeekendVote = (sessionToken: string, choice: string) =>
  request<WeekendView>('/api/weekend/votes', {
    method: 'POST',
    token: sessionToken,
    body: { kind: 'clock', choice },
    what: 'Casting your vote',
  }).then(normalize);

/**
 * Say which slots you can play — the whole set, every time.
 *
 * A set rather than a single pick, and that is the point: the field is spread
 * across every continent, so "which slot do you want" splits thirty-six ways
 * and picks whichever corner of the world happened to answer. "Which can you
 * make" is a question everybody can answer, and it has a fullest slot.
 */
export const setWeekendAvailability = (sessionToken: string, slots: number[]) =>
  request<WeekendView>('/api/weekend/availability', {
    method: 'PUT',
    token: sessionToken,
    body: { slots },
    what: 'Saving when you can play',
  }).then(normalize);

export const loadWeekendConfig = (adminToken: string) =>
  request<WeekendAdminView>('/api/admin/weekend', {
    token: adminToken,
    what: 'Loading the weekend settings',
  });

export const saveWeekendConfig = (adminToken: string, config: WeekendConfig) =>
  request<WeekendConfig>('/api/admin/weekend', {
    method: 'PUT',
    token: adminToken,
    body: config,
    what: 'Saving the weekend settings',
  });

/**
 * Open this weekend's doors now, for a host testing the thing.
 *
 * It does not start the event — that still waits for its hour, and the
 * tournament board's own start button is how you skip the wait.
 */
export const openWeekendNow = (adminToken: string) =>
  request<Tournament>('/api/admin/weekend/open', {
    method: 'POST',
    token: adminToken,
    what: 'Opening the weekend arena',
  });
