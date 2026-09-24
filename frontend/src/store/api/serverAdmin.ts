import { apiClient } from './http';
import type { ServerNotice, ServerUpdate } from '@/types/protocol';

// The two things the host can do to the server itself, rather than to a row in
// it: take it out of play for a new build, and say something to everybody.
//
// Kept out of `bots.ts` — where the rest of the host's routes live — because
// these are not about a bot, an account, or a game. They are about the process.

const request = apiClient('server');

/**
 * Stop taking new games and restart once the ones being played have finished.
 *
 * The server exits by itself when the last game ends and systemd brings up
 * whatever binary is on disk, so this is only ever half a deploy: the new build
 * has to already be installed when this is called. `deploy-backend.sh` does both
 * in the right order. Pressing this from the admin screen with nothing new
 * installed restarts the same build, which is a harmless way to clear the lobby
 * and a pointless way to spend a minute.
 */
export const beginServerDrain = (adminToken: string, note?: string) =>
  request<ServerUpdate>('/api/admin/drain', {
    method: 'POST',
    token: adminToken,
    body: { note: note ?? '' },
    what: 'Starting the restart',
  });

/** Call off a restart that has not happened yet. */
export const cancelServerDrain = (adminToken: string) =>
  request<ServerUpdate>('/api/admin/drain', {
    method: 'DELETE',
    token: adminToken,
    what: 'Calling off the restart',
  });

/** Where the restart stands: what it is still waiting on, and whether it settled. */
export const readServerDrain = (adminToken: string) =>
  request<ServerUpdate>('/api/admin/drain', {
    token: adminToken,
    what: 'Reading the restart',
  });

export interface PostNoticeOptions {
  text: string;
  tone?: 'notice' | 'warning';
  /** How long it stands. Omitted takes the server's default of fifteen minutes. */
  lifetimeSeconds?: number;
}

/**
 * Say something to everybody connected, and to everybody who arrives while it
 * stands.
 *
 * The companion to the drain rather than part of it: a graceful restart
 * announces itself, and this is for the restart that cannot wait — the apology,
 * the warning, the "known issue, fix is coming". It reaches engines too, whose
 * clients print what the server says.
 */
export const postServerNotice = (adminToken: string, options: PostNoticeOptions) =>
  request<ServerNotice>('/api/admin/notice', {
    method: 'POST',
    token: adminToken,
    body: {
      text: options.text,
      tone: options.tone ?? 'notice',
      lifetimeSeconds: options.lifetimeSeconds ?? 0,
    },
    what: 'Posting the announcement',
  });

export const clearServerNotice = (adminToken: string) =>
  request<{ cleared: boolean }>('/api/admin/notice', {
    method: 'DELETE',
    token: adminToken,
    what: 'Clearing the announcement',
  });

/* ----------------------------------------------------- the engine bench -- */

/**
 * One window in which no engine takes a game, as the host's screen draws it.
 *
 * Instants rather than a date and a time, because the server has no idea what
 * timezone anybody is in and must not guess: it stores two exact moments, and
 * every client formats them in its own zone. `untilLabel` is the one part that
 * does know about zones — it is the words a player is shown ("4 PM Eastern"),
 * written by whoever scheduled the window in the timezone the event was
 * announced in.
 */
export interface BenchWindow {
  id: string;
  reason: string;
  untilLabel: string;
  fromUnixMs: number;
  untilUnixMs: number;
  createdAtUnixMs: number;
  /** The account that scheduled it, and absent for the shared host token. */
  createdBy?: string;
  /** Whether this window covers the moment the list was read. */
  active: boolean;
  /** Whether it is over. Not simply `!active` — a coming window is neither. */
  past: boolean;
}

/** Every scheduled bench, past ones included, earliest first. */
export const listBenchWindows = (adminToken: string) =>
  request<BenchWindow[]>('/api/admin/bot-bench', {
    token: adminToken,
    what: 'Reading the bench schedule',
  });

export interface ScheduleBenchOptions {
  /** Shown to players: "the engines are offline until X for …". */
  reason: string;
  /** When they are back, in the timezone the event was announced in. */
  untilLabel: string;
  fromUnixMs: number;
  untilUnixMs: number;
}

/**
 * Stand every engine down for a window.
 *
 * Takes effect the moment it is accepted — a window that has already started is
 * how a host benches the ladder right now — and the lobby is told without
 * anybody reloading. The server refuses a window that has already finished, and
 * one that ends before it starts.
 */
export const scheduleBenchWindow = (adminToken: string, options: ScheduleBenchOptions) =>
  request<BenchWindow>('/api/admin/bot-bench', {
    method: 'POST',
    token: adminToken,
    body: options,
    what: 'Scheduling the bench',
  });

/**
 * Call off a scheduled bench, or end one that is running.
 *
 * Cancelling is permanent, including for the windows the server ships with: a
 * deploy will not put it back. That is the point — a bench that reappeared
 * after a restart would be off on an afternoon nobody expected.
 */
export const cancelBenchWindow = (adminToken: string, windowId: string) =>
  request<{ cancelled: boolean }>(`/api/admin/bot-bench/${encodeURIComponent(windowId)}`, {
    method: 'DELETE',
    token: adminToken,
    what: 'Cancelling the bench',
  });
