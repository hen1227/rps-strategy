import { apiClient } from './http';
import type {
  BlockedAccount,
  Report,
  ReportCategoryID,
  ReportPage,
  ReportPolicy,
  ReportStatus,
} from '@/types/protocol';

// The three things a player can do about somebody else, and the one they can do
// about themselves.
//
// One module rather than three, because they are one feature from the outside:
// the same menu offers report and block, and the account screen shows the block
// list beside the delete button. Splitting them would mean three imports at
// every call site for what reads as one decision.

const request = apiClient('account server');

/* --------------------------------------------------------------- blocking -- */

/**
 * Your own block list.
 *
 * Signed-in only, and deliberately: a block is a durable preference, and a
 * guest's would be thrown away with the browser key it hung off. A protection
 * that quietly evaporates is worse than one you have to sign in for.
 */
export const getBlockedPlayers = (sessionToken: string) =>
  request<{ blocked: BlockedAccount[] }>('/api/blocks', {
    token: sessionToken,
    what: 'Loading your blocked players',
  }).then((page) => page.blocked ?? []);

/**
 * Block somebody, by id when the caller has one and by name otherwise.
 *
 * The id wins on the server when both are sent, because a name can change
 * between the moment a client read it and the moment the button is pressed.
 * A chat line carries the id; a player page reached by handle carries only the
 * name.
 *
 * Returns the whole list back, so the screen that owns it does not need a
 * second round trip to redraw.
 */
export const blockPlayer = (
  sessionToken: string,
  target: { userId?: string; username?: string },
) =>
  request<{ blocked: BlockedAccount[] }>('/api/blocks', {
    method: 'POST',
    token: sessionToken,
    body: { userId: target.userId ?? '', username: target.username ?? '' },
    what: 'Blocking that player',
  }).then((page) => page.blocked ?? []);

export const unblockPlayer = (sessionToken: string, userId: string) =>
  request<{ blocked: BlockedAccount[] }>(`/api/blocks/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    token: sessionToken,
    what: 'Unblocking that player',
  }).then((page) => page.blocked ?? []);

/* -------------------------------------------------------------- reporting -- */

/**
 * What the report form offers, from the server rather than restated here.
 *
 * The same reasoning as the identity policy: a category the client offers and
 * the server does not accept is a form that fails on submit, and two copies of
 * a list is how that happens.
 */
export const getReportPolicy = () =>
  request<ReportPolicy>('/api/reports/categories', { what: 'Loading the report form' });

export interface NewReport {
  targetUserId?: string;
  targetUsername?: string;
  category: ReportCategoryID;
  details?: string;
  /** Where it happened, when it happened at a board. */
  gameId?: string;
  /**
   * The evidence, already rendered as text.
   *
   * Attached by the client rather than gathered by the server, because chat
   * here lives in server memory for the length of a game and is gone by the
   * time anybody reads the report. See backend/internal/persistence/reports.go.
   */
  context?: string;
}

/**
 * File a report.
 *
 * `credential` is a session token when there is one and the browser's own
 * account key otherwise — a guest can report, which is the opposite of the
 * rule for blocking above. `userId` goes in the query string because that is
 * how the server resolves a browser key to the account it opens.
 */
export const fileReport = (
  credential: string,
  userId: string,
  report: NewReport,
) =>
  request<{ reportId: string; filed: boolean }>(
    `/api/reports?userId=${encodeURIComponent(userId)}`,
    {
      method: 'POST',
      token: credential,
      body: {
        targetUserId: report.targetUserId ?? '',
        targetUsername: report.targetUsername ?? '',
        category: report.category,
        details: report.details ?? '',
        gameId: report.gameId ?? '',
        context: report.context ?? '',
      },
      what: 'Filing the report',
    },
  );

/* ------------------------------------------------------- deleting yourself -- */

/**
 * Delete your own account.
 *
 * `confirm` is the account's own username typed back, which the server checks.
 * Not ceremony: this is irreversible and reachable in one call, so the thing
 * between a mis-click and an erased account should be something only the person
 * looking at the screen can produce.
 *
 * Takes either credential, like reporting and unlike blocking. A guest owns an
 * account too — it holds their games and the name their opponents saw — and
 * "sign up before you may delete the account you already have" is not an
 * answer.
 */
export const deleteOwnAccount = (credential: string, userId: string, confirm: string) =>
  request<{ deleted: boolean; recordsAnonymized: number; botsRetired: number }>(
    `/api/accounts/${encodeURIComponent(userId)}?userId=${encodeURIComponent(userId)}`,
    {
      method: 'DELETE',
      token: credential,
      body: { confirm },
      what: 'Deleting your account',
    },
  );

/* ------------------------------------------------------------ the host's -- */

/** The report queue. Admin only. */
export const getReports = (
  adminToken: string,
  status: ReportStatus | '' = 'open',
  limit = 50,
  offset = 0,
) => {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (status) query.set('status', status);
  return request<ReportPage>(`/api/admin/reports?${query.toString()}`, {
    token: adminToken,
    what: 'Loading reports',
  });
};

/** Record that somebody looked at one. `open` reopens it. */
export const resolveReport = (
  adminToken: string,
  reportId: string,
  status: ReportStatus,
  note = '',
) =>
  request<Report>(`/api/admin/reports/${encodeURIComponent(reportId)}`, {
    method: 'PATCH',
    token: adminToken,
    body: { status, note },
    what: 'Updating the report',
  });
