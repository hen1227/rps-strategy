import { useCallback, useEffect, useRef, useState } from 'react';

import { failureMessage } from '@/errors';
import {
  answerFeedback,
  commentOnFeedback,
  deleteFeedbackComment,
  deleteFeedbackItem,
  getFeedback,
  getFeedbackItem,
  getFeedbackPolicy,
  hideFeedbackComment,
  postFeedback,
  setFeedbackVote,
  type FeedbackAnswer,
  type FeedbackQuery,
  type NewFeedbackItem,
} from '@/store/api/feedback';
import { useGameStore } from '@/store/gameStore';
import type { FeedbackItem, FeedbackPage, FeedbackPolicy } from '@/types/protocol';

// The board's state, in one place.
//
// The screen is a list, a thread, a form and a set of host controls, and all
// four write to the same rows. Keeping the data here rather than in the screen
// is what lets a vote cast inside a thread show up on the list behind it
// without either component knowing the other exists.
//
// # Why a vote is applied twice
//
// `vote` writes the new tally into the list the moment it is pressed and then
// again when the server answers. The optimistic half is not decoration: on a
// phone the round trip is long enough that a button which does nothing for
// 300ms reads as a button that did not register, and the second press is what
// actually causes the bug — a withdraw the player did not mean. The server is
// idempotent either way, so the worst case of the two disagreeing is a count
// that corrects itself a moment later.

/** How the board is being looked at. Everything here is in the URL or a chip. */
export type BoardQuery = Required<Pick<FeedbackQuery, 'sort'>> &
  Pick<FeedbackQuery, 'kind' | 'status' | 'search'>;

export interface FeedbackBoard {
  page: FeedbackPage | null;
  policy: FeedbackPolicy | null;
  /** The thread being read, when the address names one. */
  item: FeedbackItem | null;
  loading: boolean;
  /** True while the *first* load is in flight, which is the one worth a spinner. */
  loadingItem: boolean;
  error: string | null;
  setError: (message: string | null) => void;
  reload: () => void;
  vote: (itemId: string, voted: boolean) => Promise<void>;
  post: (item: NewFeedbackItem) => Promise<FeedbackItem | null>;
  reply: (itemId: string, body: string) => Promise<boolean>;
  removeItem: (itemId: string) => Promise<boolean>;
  removeComment: (itemId: string, commentId: string) => Promise<boolean>;
  answer: (itemId: string, answer: FeedbackAnswer) => Promise<boolean>;
  hideComment: (itemId: string, commentId: string, hidden: boolean) => Promise<boolean>;
}

export const useFeedbackBoard = (query: BoardQuery, openItemId: string): FeedbackBoard => {
  const sessionToken = useGameStore((state) => state.sessionToken);

  const [page, setPage] = useState<FeedbackPage | null>(null);
  const [policy, setPolicy] = useState<FeedbackPolicy | null>(null);
  const [item, setItem] = useState<FeedbackItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingItem, setLoadingItem] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped to ask for everything again. A counter rather than a boolean so two
  // reloads in a row are two reloads.
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((count) => count + 1), []);

  // Every in-flight request checks this before it writes. A board whose filter
  // changed while a page was loading must not be overwritten by the answer to
  // the question nobody is asking any more.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const { kind, status, search, sort } = query;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getFeedback({ kind, status, search, sort }, sessionToken)
      .then((loaded) => {
        if (cancelled) return;
        setPage(loaded);
        setError(null);
      })
      .catch((caught) => {
        if (!cancelled) setError(failureMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, status, search, sort, sessionToken, generation]);

  // The policy is a second call because it answers a different question — what
  // this visitor may do — and it changes when they sign in rather than when
  // they change the filter.
  useEffect(() => {
    let cancelled = false;
    getFeedbackPolicy(sessionToken)
      .then((loaded) => {
        if (!cancelled) setPolicy(loaded);
      })
      .catch(() => {
        // Silent. The board is still readable without it; what is lost is the
        // form, and the screen says so in the one place that matters.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionToken, generation]);

  useEffect(() => {
    if (!openItemId) {
      setItem(null);
      return;
    }
    let cancelled = false;
    setLoadingItem(true);
    getFeedbackItem(openItemId, sessionToken)
      .then((loaded) => {
        if (cancelled) return;
        setItem(loaded);
        setError(null);
      })
      .catch((caught) => {
        if (!cancelled) setError(failureMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoadingItem(false);
      });
    return () => {
      cancelled = true;
    };
  }, [openItemId, sessionToken, generation]);

  /** Write one item's new state into both the list and the open thread. */
  const applyToItem = useCallback(
    (itemId: string, change: (previous: FeedbackItem) => FeedbackItem) => {
      setPage((previous) =>
        previous
          ? {
              ...previous,
              items: previous.items.map((entry) =>
                entry.itemId === itemId ? change(entry) : entry,
              ),
            }
          : previous,
      );
      setItem((previous) =>
        previous && previous.itemId === itemId ? change(previous) : previous,
      );
    },
    [],
  );

  const vote = useCallback(
    async (itemId: string, voted: boolean) => {
      if (!sessionToken) return;
      // Straight away — see the note at the top of this file.
      applyToItem(itemId, (entry) => ({
        ...entry,
        youVoted: voted,
        votes: Math.max(0, entry.votes + (voted ? 1 : -1)),
      }));
      try {
        const tally = await setFeedbackVote(sessionToken, itemId, voted);
        if (!live.current) return;
        applyToItem(itemId, (entry) => ({
          ...entry,
          votes: tally.votes,
          youVoted: tally.youVoted,
        }));
      } catch (caught) {
        if (!live.current) return;
        // Put it back. A tally that stays wrong is worse than one that flickers:
        // the number is the whole reason this board is worth reading.
        applyToItem(itemId, (entry) => ({
          ...entry,
          youVoted: !voted,
          votes: Math.max(0, entry.votes + (voted ? -1 : 1)),
        }));
        setError(failureMessage(caught));
      }
    },
    [applyToItem, sessionToken],
  );

  const post = useCallback(
    async (draft: NewFeedbackItem) => {
      if (!sessionToken) return null;
      try {
        const created = await postFeedback(sessionToken, draft);
        if (live.current) {
          setError(null);
          reload();
        }
        return created;
      } catch (caught) {
        if (live.current) setError(failureMessage(caught));
        return null;
      }
    },
    [reload, sessionToken],
  );

  const reply = useCallback(
    async (itemId: string, body: string) => {
      if (!sessionToken) return false;
      try {
        const comment = await commentOnFeedback(sessionToken, itemId, body);
        if (!live.current) return true;
        setError(null);
        // Appended rather than reloaded, so the thread does not jump while
        // somebody is reading it. The count beside it moves with it.
        applyToItem(itemId, (entry) => ({
          ...entry,
          comments: entry.comments + 1,
          thread: entry.thread ? [...entry.thread, comment] : [comment],
        }));
        return true;
      } catch (caught) {
        if (live.current) setError(failureMessage(caught));
        return false;
      }
    },
    [applyToItem, sessionToken],
  );

  const removeItem = useCallback(
    async (itemId: string) => {
      if (!sessionToken) return false;
      try {
        await deleteFeedbackItem(sessionToken, itemId);
        if (live.current) {
          setError(null);
          setItem(null);
          reload();
        }
        return true;
      } catch (caught) {
        if (live.current) setError(failureMessage(caught));
        return false;
      }
    },
    [reload, sessionToken],
  );

  const removeComment = useCallback(
    async (itemId: string, commentId: string) => {
      if (!sessionToken) return false;
      try {
        await deleteFeedbackComment(sessionToken, itemId, commentId);
        if (!live.current) return true;
        setError(null);
        applyToItem(itemId, (entry) => ({
          ...entry,
          comments: Math.max(0, entry.comments - 1),
          thread: entry.thread?.filter((reply) => reply.commentId !== commentId),
        }));
        return true;
      } catch (caught) {
        if (live.current) setError(failureMessage(caught));
        return false;
      }
    },
    [applyToItem, sessionToken],
  );

  const answer = useCallback(
    async (itemId: string, edit: FeedbackAnswer) => {
      if (!sessionToken) return false;
      try {
        const updated = await answerFeedback(sessionToken, itemId, edit);
        if (!live.current) return true;
        setError(null);
        // The answer comes back whole, so it replaces the row rather than being
        // merged into it — including the fields the host did not send, which
        // the server left alone. The thread is not on the list's copy, so it is
        // carried over rather than blanked.
        applyToItem(itemId, (entry) => ({ ...updated, thread: updated.thread ?? entry.thread }));
        // Pinning and hiding change the *order* and the membership of the
        // board, which only a reload can show.
        if (edit.pinned !== undefined || edit.hidden !== undefined || edit.status) {
          reload();
        }
        return true;
      } catch (caught) {
        if (live.current) setError(failureMessage(caught));
        return false;
      }
    },
    [applyToItem, reload, sessionToken],
  );

  const hideComment = useCallback(
    async (itemId: string, commentId: string, hidden: boolean) => {
      if (!sessionToken) return false;
      try {
        const updated = await hideFeedbackComment(sessionToken, itemId, commentId, hidden);
        if (!live.current) return true;
        setError(null);
        applyToItem(itemId, (entry) => ({
          ...entry,
          thread: entry.thread?.map((reply) =>
            reply.commentId === commentId ? updated : reply,
          ),
        }));
        return true;
      } catch (caught) {
        if (live.current) setError(failureMessage(caught));
        return false;
      }
    },
    [applyToItem, sessionToken],
  );

  return {
    page,
    policy,
    item,
    loading,
    loadingItem,
    error,
    setError,
    reload,
    vote,
    post,
    reply,
    removeItem,
    removeComment,
    answer,
    hideComment,
  };
};
