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
import type { ConnectionStatus, QueueClaim, QueueMiss, QueueState } from './types';
import type { GameSetup, ModeDefinition } from '@/types/game';

/** How long a summoned player has to take their seat. Mirrors the server. */
export const CLAIM_WINDOW_MS = 30_000;
/** Under this, the card goes urgent. */
export const CLAIM_CRITICAL_MS = 10_000;
/** How long "they never turned up" stays on screen before the search resumes. */
export const MISS_NOTICE_MS = 8_000;

export type QueueCallKind =
  /** Queued, but closing the tab would drop you. */
  | 'searching_tethered'
  /** Queued with alerts on: go anywhere. */
  | 'searching_untethered'
  /** Your own game is sitting on the open board. */
  | 'posted'
  /** Matched. They are being called; the wait is on them. */
  | 'holding'
  /** Matched. You were away, and the seat is yours to take. */
  | 'claiming'
  /** They were called and never came. You are back in the queue. */
  | 'missed'
  /** The socket is down and we believe we are still queued. */
  | 'reconnecting';

export interface QueueCall {
  kind: QueueCallKind;
  /** How long this wait has been going, right now. */
  waitedMs: number;
  /** Milliseconds left on a claim, clamped at zero. Zero when there is none. */
  remainingMs: number;
  /** 1 when the hold was made, 0 at its deadline. Drives the countdown rule. */
  progress: number;
  modeName: string;
  setup: GameSetup | null;
  opponentName: string | null;
  pendingId: string | null;
  /** The outgoing challenge behind a `posted` call, so the bar can cancel it. */
  challengeId: string | null;
  targetUsername: string | null;
  /** True while a claim is in flight. */
  busy: boolean;
  /** Whether to show the alerts offer. False once granted, snoozed, or moot. */
  offerAlerts: boolean;
  /** Under ten seconds. */
  critical: boolean;
}

export interface QueueSource {
  queue: QueueState;
  claim: QueueClaim | null;
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

const opponentNameOf = (claim: QueueClaim | null) =>
  claim?.opponent?.username?.trim() || null;

/**
 * The one live claim, or null.
 *
 * A hold whose deadline has already passed is not live. Without that, a message
 * that arrived late — or a tab that woke up after being throttled — would
 * strand a dead countdown on screen with a button that cannot work.
 */
const liveClaim = (claim: QueueClaim | null, nowMs: number) =>
  claim && claim.deadlineUnixMs > nowMs ? claim : null;

/**
 * Whether a hold has run out here but the server has not said so yet.
 *
 * The two clocks disagree by up to a sweep. Falling straight back to "looking
 * for an opponent" in that gap would tell the player their search is running
 * again while the server still has their seat held and their seek off the
 * board — briefly true-looking and entirely wrong. Saying "they never turned
 * up" instead is honest the instant the deadline passes, and it is what the
 * server is about to confirm anyway.
 */
const claimJustLapsed = (claim: QueueClaim | null, nowMs: number) =>
  Boolean(claim && claim.deadlineUnixMs <= nowMs && claim.role === 'present');

/**
 * What the player is waiting on, or null when they are waiting on nothing.
 *
 * The order of these branches is the whole design. A claim outranks everything,
 * because it is the only state with a deadline attached to it. Being
 * disconnected outranks the ordinary search, because a search that cannot hear
 * the server should not pretend to be progressing.
 */
export const queueCallState = (source: QueueSource): QueueCall | null => {
  const { queue, connectionStatus, modes, nowMs } = source;
  if (source.atOwnBoard) return null;

  const claim = liveClaim(source.claim, nowMs);
  const waitedMs = queue.queuedSinceUnixMs ? clampAtZero(nowMs - queue.queuedSinceUnixMs) : 0;

  if (claim) {
    // Clamped to the window as well as to zero. The two clocks can disagree,
    // and a bar promising thirty-four seconds of a thirty-second hold is a bar
    // that will run out early and look broken doing it.
    const remainingMs = Math.min(clampAtZero(claim.deadlineUnixMs - nowMs), CLAIM_WINDOW_MS);
    return {
      kind: claim.role === 'summoned' ? 'claiming' : 'holding',
      waitedMs,
      remainingMs,
      progress: remainingMs / CLAIM_WINDOW_MS,
      modeName: claim.modeName || modeNameFor(modes, claim.modeId),
      setup: claim.setup,
      opponentName: opponentNameOf(claim),
      pendingId: claim.pendingId,
      challengeId: null,
      targetUsername: null,
      busy: claim.claiming,
      offerAlerts: false,
      critical: remainingMs <= CLAIM_CRITICAL_MS,
    };
  }

  const base = {
    waitedMs,
    remainingMs: 0,
    progress: 0,
    setup: queue.setup,
    opponentName: null,
    pendingId: null,
    challengeId: null,
    targetUsername: null,
    busy: false,
    offerAlerts: false,
    critical: false,
  };

  if (queue.isSearching && connectionStatus !== 'connected') {
    return { ...base, kind: 'reconnecting', modeName: modeNameFor(modes, queue.modeId) };
  }

  const missing =
    (source.miss && nowMs - source.miss.atUnixMs < MISS_NOTICE_MS) ||
    claimJustLapsed(source.claim, nowMs);
  if (queue.isSearching && missing) {
    return {
      ...base,
      kind: 'missed',
      modeName: modeNameFor(modes, queue.modeId),
      opponentName: opponentNameOf(source.claim),
    };
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

export interface QueueCopy {
  title: (call: QueueCall) => string;
  detail: (call: QueueCall) => string;
  action: string;
  /** A second, quieter action. Absent when the card has only one. */
  secondary?: string;
}

export const QUEUE_COPY: Record<QueueCallKind, QueueCopy> = {
  searching_tethered: {
    title: (call) => `Looking for a ${call.modeName} opponent`,
    detail: (call) => `${formatWait(call.waitedMs)} in · this tab has to stay open to hold your place`,
    action: 'LEAVE QUEUE',
  },
  searching_untethered: {
    title: (call) => `Looking for a ${call.modeName} opponent`,
    detail: (call) => `${formatWait(call.waitedMs)} in · close the tab if you like, we will call you back`,
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
  holding: {
    title: (call) => `${call.opponentName ?? 'Your opponent'} has been called to the board`,
    detail: (call) =>
      `${formatCountdown(call.remainingMs)} to answer · your game opens the moment they sit down`,
    action: 'LEAVE QUEUE',
  },
  claiming: {
    title: (call) => `${call.opponentName ?? 'Somebody'} is waiting for you`,
    detail: (call) => `${formatCountdown(call.remainingMs)} to take your seat · ${call.modeName}`,
    action: 'PLAY NOW ▶',
    secondary: 'NOT NOW',
  },
  missed: {
    title: (call) => `${call.opponentName ?? 'They'} never turned up`,
    detail: (call) => `Back to searching · ${formatWait(call.waitedMs)} in, and your place is intact`,
    action: 'LEAVE QUEUE',
  },
  reconnecting: {
    title: () => 'Holding your place',
    detail: (call) => `Reconnecting · ${formatWait(call.waitedMs)} and still counting`,
    action: 'LEAVE QUEUE',
  },
};

/** The alerts offer, kept here because it is queue copy. */
export const ALERTS_PITCH = {
  line: 'Turn on alerts and you can close the tab — we will call you back.',
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
  /** A second seek would be refused: one is already out, or a seat is held. */
  seekTaken: boolean;
}

export const lobbyGate = (source: {
  connectionStatus: ConnectionStatus;
  atOwnBoard: boolean;
  outgoingChallenge: Challenge | null;
  claim: QueueClaim | null;
  queue: QueueState;
}): LobbyGate => ({
  atBoard: source.atOwnBoard || source.connectionStatus !== 'connected',
  // Taking somebody's game off the board while queued is not a conflict: it is
  // the same act as being matched, only faster, and the server drops your seek
  // the moment a game starts. So only *creating* a second seek is gated here.
  seekTaken:
    source.queue.isSearching || Boolean(source.outgoingChallenge) || Boolean(source.claim),
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
