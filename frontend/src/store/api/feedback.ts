import { apiClient } from './http';
import type {
  FeedbackComment,
  FeedbackItem,
  FeedbackKind,
  FeedbackPage,
  FeedbackPolicy,
  FeedbackSort,
  FeedbackStatus,
} from '@/types/protocol';

// The feedback board.
//
// Reading takes no credential at all, which is the one thing to notice about
// the calls below: `getFeedback` and `getFeedbackItem` are the only public
// reads in this folder that also change their answer when you *are* signed in —
// the tally comes back marked with your own vote. So they take an optional
// token rather than none, and pass it when there is one.
//
// Everything that writes takes a session token and nothing else. The server
// asks for a Discord-verified account behind it; see
// backend/internal/server/feedback.go for why the bar is set higher here than
// for chat or for reporting somebody.

const request = apiClient('feedback board');

export interface FeedbackQuery {
  kind?: FeedbackKind;
  status?: FeedbackStatus;
  /** Matched against titles and bodies: what you run before posting. */
  search?: string;
  sort?: FeedbackSort;
  limit?: number;
  offset?: number;
}

/**
 * The board.
 *
 * `sessionToken` is optional and is what fills in `youVoted` — a signed-out
 * reader sees the same items with no marks on them. A host's token also brings
 * back the hidden ones, flagged, so the admin view is this same call.
 */
export const getFeedback = (query: FeedbackQuery = {}, sessionToken?: string | null) => {
  const params = new URLSearchParams();
  if (query.kind) params.set('kind', query.kind);
  if (query.status) params.set('status', query.status);
  if (query.search?.trim()) params.set('q', query.search.trim());
  if (query.sort) params.set('sort', query.sort);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset) params.set('offset', String(query.offset));
  const suffix = params.toString();
  return request<FeedbackPage>(`/api/feedback${suffix ? `?${suffix}` : ''}`, {
    token: sessionToken ?? undefined,
    what: 'Loading the feedback board',
  });
};

/** One item with its replies, which arrive on the same call. */
export const getFeedbackItem = (itemId: string, sessionToken?: string | null) =>
  request<FeedbackItem>(`/api/feedback/${encodeURIComponent(itemId)}`, {
    token: sessionToken ?? undefined,
    what: 'Loading that item',
  });

/**
 * What the form may offer, and whether this visitor may use it.
 *
 * The same reasoning as `getReportPolicy`: a kind the form offers and the
 * server does not accept is a form that fails on submit. `mayPost` is the part
 * a client genuinely cannot answer for itself — see `FeedbackPolicy`.
 */
export const getFeedbackPolicy = (sessionToken?: string | null) =>
  request<FeedbackPolicy>('/api/feedback/policy', {
    token: sessionToken ?? undefined,
    what: 'Loading the feedback board',
  });

export interface NewFeedbackItem {
  kind: FeedbackKind;
  title: string;
  body?: string;
  /** An issue, a thread, a video. Refused unless it is http or https. */
  linkUrl?: string;
  /** The game it happened in. Filled in by the finished-game card. */
  gameId?: string;
  /** What this client is, which is what says whether a bug is already fixed. */
  appVersion?: string;
  platform?: string;
}

/** Post an item. Comes back with the author's own vote already on it. */
export const postFeedback = (sessionToken: string, item: NewFeedbackItem) =>
  request<FeedbackItem>('/api/feedback', {
    method: 'POST',
    token: sessionToken,
    body: {
      kind: item.kind,
      title: item.title,
      body: item.body ?? '',
      linkUrl: item.linkUrl ?? '',
      gameId: item.gameId ?? '',
      appVersion: item.appVersion ?? '',
      platform: item.platform ?? '',
    },
    what: 'Posting to the board',
  });

/**
 * Cast or withdraw your vote, answering with the tally it produced.
 *
 * One function for both directions because the button is one button. The
 * server is idempotent either way, which is what makes a double tap on a slow
 * connection harmless rather than an error message for something that already
 * worked.
 */
export const setFeedbackVote = (sessionToken: string, itemId: string, voted: boolean) =>
  request<{ votes: number; youVoted: boolean }>(
    `/api/feedback/${encodeURIComponent(itemId)}/votes`,
    {
      method: voted ? 'POST' : 'DELETE',
      token: sessionToken,
      what: voted ? 'Adding your vote' : 'Removing your vote',
    },
  );

/** Reply to an item. */
export const commentOnFeedback = (sessionToken: string, itemId: string, body: string) =>
  request<FeedbackComment>(`/api/feedback/${encodeURIComponent(itemId)}/comments`, {
    method: 'POST',
    token: sessionToken,
    body: { body },
    what: 'Posting your reply',
  });

/** Remove your own post, or anybody's if you are the host. */
export const deleteFeedbackItem = (sessionToken: string, itemId: string) =>
  request<{ deleted: boolean }>(`/api/feedback/${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
    token: sessionToken,
    what: 'Removing that post',
  });

/** The same, for one reply. Addressed under the item it is on. */
export const deleteFeedbackComment = (
  sessionToken: string,
  itemId: string,
  commentId: string,
) =>
  request<{ deleted: boolean }>(
    `/api/feedback/${encodeURIComponent(itemId)}/comments/${encodeURIComponent(commentId)}`,
    {
      method: 'DELETE',
      token: sessionToken,
      what: 'Removing that reply',
    },
  );

/* ------------------------------------------------------------ the host's -- */

/**
 * The host's answer: a status, a note beside it, a link out, a pin, or an item
 * taken off the board.
 *
 * Every field is optional and an omitted one is left alone, which is the whole
 * reason this is a PATCH — sending a pin must not blank the note. An empty
 * string is a clear.
 */
export interface FeedbackAnswer {
  kind?: FeedbackKind;
  status?: FeedbackStatus;
  statusNote?: string;
  linkUrl?: string;
  duplicateOf?: string;
  pinned?: boolean;
  hidden?: boolean;
  title?: string;
}

export const answerFeedback = (adminToken: string, itemId: string, answer: FeedbackAnswer) =>
  request<FeedbackItem>(`/api/admin/feedback/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    token: adminToken,
    body: answer,
    what: 'Updating that item',
  });

/** Take one reply off a thread, or put it back. */
export const hideFeedbackComment = (
  adminToken: string,
  itemId: string,
  commentId: string,
  hidden: boolean,
) =>
  request<FeedbackComment>(
    `/api/admin/feedback/${encodeURIComponent(itemId)}/comments/${encodeURIComponent(commentId)}`,
    {
      method: 'PATCH',
      token: adminToken,
      body: { hidden },
      what: hidden ? 'Hiding that reply' : 'Restoring that reply',
    },
  );
