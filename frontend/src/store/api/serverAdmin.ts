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
