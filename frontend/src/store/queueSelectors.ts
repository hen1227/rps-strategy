// What the queue is doing, as one answer.
//
// Waiting for a game used to be a state of one screen: a spinner on a mode card
// that you had to stay and watch. It is now a background activity that outlives
// the page, the tab, and sometimes the session — so "what am I waiting on" is a
// question every screen asks, and it needs exactly one answer or the floating
// bar and the lobby will contradict each other.
//
// Everything here is pure. No store import, no React, no clock of its own: the
// caller passes `nowMs`, which is what makes a thirty-second countdown testable
// without waiting thirty seconds.

import type { Challenge } from '@/types/protocol';
import type { ConnectionStatus, QueueMiss, QueueState } from './types';
import type { GameSetup, ModeDefinition } from '@/types/game';

/**
 * How long a board nobody has moved on waits before it is called off. Mirrors
 * the server, and is the same window a disconnected player gets to come back.
 */
export const FIRST_MOVE_WINDOW_MS = 30_000;
/** Under this, a first-move countdown goes urgent. */
export const FIRST_MOVE_CRITICAL_MS = 10_000;
/** How long "that one was called off" stays on screen before the search resumes. */
export const MISS_NOTICE_MS = 8_000;

export type QueueCallKind =
  /** Queued, but closing the tab — or leaving the app — would drop you. */
  | 'searching_tethered'
  /** Queued with alerts on: go anywhere. */
  | 'searching_untethered'
  /** Your own game is sitting on the open board. */
  | 'posted'
  /** The last board opened for you was never played in. You are still queued. */
  | 'missed'
  /** The socket is down and we believe we are still queued. */
  | 'reconnecting';

export interface QueueCall {
  kind: QueueCallKind;
  /** How long this wait has been going, right now. */
  waitedMs: number;
  modeName: string;
  setup: GameSetup | null;
  /** The outgoing challenge behind a `posted` call, so the bar can cancel it. */
  challengeId: string | null;
  targetUsername: string | null;
  /** Whether to show the alerts offer. False once granted, snoozed, or moot. */
  offerAlerts: boolean;
}

export interface QueueSource {
  queue: QueueState;
  miss: QueueMiss | null;
  outgoingChallenge: Challenge | null;
  connectionStatus: ConnectionStatus;
  modes: ModeDefinition[];
  /** Sitting at a real board — a bot game does not count. */
  atOwnBoard: boolean;
  /** Alerts are on and the server has a live subscription for this browser. */
  pushLive: boolean;
  /** Whether the alerts offer is worth making at all. */
  canOfferAlerts: boolean;
  nowMs: number;
}

const clampAtZero = (value: number) => (value > 0 ? value : 0);

const modeNameFor = (modes: ModeDefinition[], modeId: string | null | undefined) =>
  modes.find((mode) => mode.id === modeId)?.name ?? 'a game';

/**
 * What the player is waiting on, or null when they are waiting on nothing.
 *
 * A match no longer produces a state here at all: pairing opens the board, so
 * the moment there is an opponent this returns null and the game takes over the
 * screen. What is left is the waiting, and the order of these branches is the
 * whole design — being disconnected outranks the ordinary search, because a
 * search that cannot hear the server should not pretend to be progressing.
 */
export const queueCallState = (source: QueueSource): QueueCall | null => {
  const { queue, connectionStatus, modes, nowMs } = source;
  if (source.atOwnBoard) return null;

  const waitedMs = queue.queuedSinceUnixMs ? clampAtZero(nowMs - queue.queuedSinceUnixMs) : 0;
  const base = {
    waitedMs,
    setup: queue.setup,
    challengeId: null,
    targetUsername: null,
    offerAlerts: false,
  };

  if (queue.isSearching && connectionStatus !== 'connected') {
    return { ...base, kind: 'reconnecting', modeName: modeNameFor(modes, queue.modeId) };
  }

  const missing = source.miss && nowMs - source.miss.atUnixMs < MISS_NOTICE_MS;
  if (queue.isSearching && missing) {
    return { ...base, kind: 'missed', modeName: modeNameFor(modes, queue.modeId) };
  }

  if (queue.isSearching) {
    return {
      ...base,
      kind: source.pushLive ? 'searching_untethered' : 'searching_tethered',
      modeName: modeNameFor(modes, queue.modeId),
      offerAlerts: !source.pushLive && source.canOfferAlerts,
    };
  }

  const posted = source.outgoingChallenge;
  if (posted) {
    return {
      ...base,
      kind: 'posted',
      waitedMs: clampAtZero(nowMs - posted.createdAtUnixMs),
      modeName: posted.modeName,
      setup: posted.setup,
      challengeId: posted.id,
      targetUsername: posted.targetUsername ?? null,
    };
  }
  return null;
};

/* ----------------------------------------------------------------- copy -- */

/**
 * Elapsed time, in the shape a person reads at a glance.
 *
 * Seconds keep ticking past a minute on purpose: a number that freezes for
 * sixty seconds reads as broken, which is exactly the impression a queue you
 * are trusting with your evening must not give.
 */
export const formatWait = (ms: number): string => {
  const totalSeconds = Math.floor(clampAtZero(ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
};

/** A countdown, rounded up so it never reads 0s while there is still time. */
export const formatCountdown = (ms: number): string => `${Math.ceil(clampAtZero(ms) / 1000)}s`;

/**
 * How a board that has not been played on yet describes itself.
 *
 * Pure, and separate from the board component, for the same reason the queue
 * copy is: a thirty-second countdown is only testable if the clock is an
 * argument. `yours` is whether the player reading this is the one who has to
 * move.
 */
export interface FirstMoveCall {
  title: string;
  detail: string;
  remainingMs: number;
  critical: boolean;
  /** Whether this player can end the wait by moving. */
  yours: boolean;
}

export const firstMoveCall = (
  deadlineUnixMs: number | null,
  yours: boolean,
  opponentName: string | null,
  nowMs: number,
): FirstMoveCall | null => {
  if (!deadlineUnixMs) return null;
  // Clamped to the window as well as to zero: the two clocks can disagree, and
  // a bar promising thirty-four seconds of a thirty-second wait is one that
  // will run out early and look broken doing it.
  const remainingMs = Math.min(clampAtZero(deadlineUnixMs - nowMs), FIRST_MOVE_WINDOW_MS);
  const critical = remainingMs <= FIRST_MOVE_CRITICAL_MS;
  const countdown = formatCountdown(remainingMs);
  if (yours) {
    return {
      title: 'Your move starts the clock',
      detail: `${countdown} to play it · neither clock is running, and nothing is rated until you do`,
      remainingMs,
      critical,
      yours,
    };
  }
  return {
    title: `Waiting for ${opponentName?.trim() || 'your opponent'} to open`,
    detail: `${countdown} before the game is called off · no rating either way`,
    remainingMs,
    critical,
    yours,
  };
};

export interface QueueCopy {
  title: (call: QueueCall) => string;
  detail: (call: QueueCall) => string;
  /**
   * The same line for a device with no tab in it. Present only on the two kinds
   * that describe what closing one costs you, which is the pair that stopped
   * being true when alerts started working in the app.
   */
  nativeDetail?: (call: QueueCall) => string;
  action: string;
  /** A second, quieter action. Absent when the card has only one. */
  secondary?: string;
}

export const QUEUE_COPY: Record<QueueCallKind, QueueCopy> = {
  searching_tethered: {
    title: (call) => `Looking for a ${call.modeName} opponent`,
    detail: (call) => `${formatWait(call.waitedMs)} in · this tab has to stay open to hold your place`,
    nativeDetail: (call) =>
      `${formatWait(call.waitedMs)} in · RPS has to stay open to hold your place`,
    action: 'LEAVE QUEUE',
  },
  searching_untethered: {
    title: (call) => `Looking for a ${call.modeName} opponent`,
    detail: (call) => `${formatWait(call.waitedMs)} in · close the tab if you like, we will call you back`,
    nativeDetail: (call) =>
      `${formatWait(call.waitedMs)} in · leave the app if you like, we will call you back`,
    action: 'LEAVE QUEUE',
  },
  posted: {
    title: (call) =>
      call.targetUsername
        ? `Waiting for ${call.targetUsername} to answer`
        : `Your ${call.modeName} game is on the board`,
    detail: (call) =>
      call.targetUsername
        ? `${formatWait(call.waitedMs)} in · only they can see it`
        : `${formatWait(call.waitedMs)} in · anybody in the lobby can take it`,
    action: 'CANCEL',
  },
  missed: {
    title: () => 'That game was called off',
    detail: (call) => `Back to searching · ${formatWait(call.waitedMs)} in, and your place is intact`,
    action: 'LEAVE QUEUE',
  },
  reconnecting: {
    title: () => 'Holding your place',
    detail: (call) => `Reconnecting · ${formatWait(call.waitedMs)} and still counting`,
    action: 'LEAVE QUEUE',
  },
};

/**
 * The alerts offer, kept here because it is queue copy.
 *
 * Two lines because there is no tab to close on a phone. The choice is the
 * caller's rather than this module's: everything here is a pure function of the
 * queue, and reading the platform would make it a function of the build too.
 */
export const ALERTS_PITCH = {
  line: 'Turn on alerts and you can close the tab — we will call you back.',
  nativeLine: 'Turn on alerts and you can leave the app — we will call you back.',
  action: 'TURN ON ALERTS ▶',
  dismissLabel: 'Not now — hide the alerts offer',
};

/* ----------------------------------------------------------------- gate -- */

/**
 * What the player cannot do right now, and which of two reasons it is.
 *
 * One flag used to cover both, and it included "is queued". That was harmless
 * while a queue lasted twenty seconds and you had to sit and watch it. Now that
 * you can be queued for ten minutes across every screen, a blanket disable
 * would make the whole app read-only for the duration — so the two reasons have
 * to be told apart.
 */
export interface LobbyGate {
  /** At a real board, or the socket is down. Nothing can be started at all. */
  atBoard: boolean;
  /** A second seek would be refused, because one is already out. */
  seekTaken: boolean;
  /**
   * Ranked play needs an account and this player has none.
   *
   * Not a reason to disable anything outright: casual games and bots are still
   * open, and the server downgrades a guest's own search rather than refusing
   * it. What it gates is the *rated* option — and accepting somebody else's
   * rated game, which the server does refuse, because that setup is theirs.
   */
  needsAccount: boolean;
}

export const lobbyGate = (source: {
  connectionStatus: ConnectionStatus;
  atOwnBoard: boolean;
  outgoingChallenge: Challenge | null;
  queue: QueueState;
  signedIn: boolean;
}): LobbyGate => ({
  atBoard: source.atOwnBoard || source.connectionStatus !== 'connected',
  // Taking somebody's game off the board while queued is not a conflict: it is
  // the same act as being matched, only faster, and the server drops your seek
  // the moment a game starts. So only *creating* a second seek is gated here.
  seekTaken: source.queue.isSearching || Boolean(source.outgoingChallenge),
  needsAccount: !source.signedIn,
});

/* -------------------------------------------------------- lobby counting -- */

/** How the open board splits into people you could play now, and people away. */
export const waitingPresence = (challenges: Challenge[]) => {
  let here = 0;
  for (const challenge of challenges) {
    if (challenge.present) here += 1;
  }
  return { total: challenges.length, here, away: challenges.length - here };
};
