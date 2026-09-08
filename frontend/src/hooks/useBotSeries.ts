import { useEffect, useState } from 'react';

import { botSeries, botSeriesForGame, type BotSeries } from '@/store/api/bots';

// The run behind a board, asked for either way round.
//
// Two screens hold a series id — the spectate rail, off the live lobby row —
// and two hold only a game id: the review screen, which is handed one in a URL
// somebody pasted, and the run's own page, which is handed the run. Those are
// the same request with a different key, so they are one hook with two doors
// rather than a `useEffect` per screen. The review screen used to carry its own
// copy, and a second fetch policy is a second answer to "what does a failure
// look like".
//
// A live series game already arrives with its tally on it — `LiveGameSeries`,
// which rides along with the lobby row — and that is enough to say "game 4 of 6,
// 2–1". It is not enough to draw the games themselves, because the lobby has no
// reason to carry six results on every row of every broadcast. So the strip asks
// for them once and again whenever the run moves on.

/** Where a request is up to, for a caller that has to tell three states apart. */
export type SeriesStatus =
  /** Nothing was asked for: this board is not part of a run. */
  | 'idle'
  /** Asked, still waiting. */
  | 'loading'
  /** Here. */
  | 'ready'
  /** Asked and answered with nothing: no such run, or the request failed. */
  | 'missing';

export interface SeriesRequest {
  series: BotSeries | null;
  status: SeriesStatus;
}

/**
 * One run, however it was asked for.
 *
 * A failure answers `missing` rather than raising, and the two callers that
 * draw a strip over a board simply do not draw it: the board underneath is the
 * thing somebody came to watch, and a missing strip is a much smaller problem
 * than an error over the top of it. A page *about* the run is the one caller
 * that has to say something, which is what `status` is for — without it a page
 * cannot tell "still loading" from "no such series", and would have to pick one
 * of those to be wrong about.
 */
const useSeriesRequest = (
  key: string | null | undefined,
  read: (key: string) => Promise<BotSeries | null>,
  revision?: unknown,
): SeriesRequest => {
  const [request, setRequest] = useState<SeriesRequest>({ series: null, status: 'idle' });

  useEffect(() => {
    if (!key) {
      setRequest({ series: null, status: 'idle' });
      return undefined;
    }
    let cancelled = false;
    // Kept, rather than cleared to null, so that stepping between the games of
    // one run does not blink the strip out and back while the answer — which is
    // the same run — is on its way.
    setRequest((current) => ({ ...current, status: 'loading' }));
    read(key)
      .then((found) => {
        if (cancelled) return;
        setRequest({ series: found ?? null, status: found ? 'ready' : 'missing' });
      })
      .catch(() => {
        if (!cancelled) setRequest({ series: null, status: 'missing' });
      });
    return () => {
      cancelled = true;
    };
    // `revision` is the caller's way of saying the run has moved on — the game
    // number off the live row — since nothing else here would notice.
  }, [key, read, revision]);

  return request;
};

/** The run with this id. */
export const useBotSeries = (seriesId: string | null | undefined, revision?: unknown) =>
  useSeriesRequest(seriesId, botSeries, revision);

/**
 * The run this game was one game of, or nothing when it was not part of one.
 *
 * Asked by game id rather than carried on the link, which is what lets a pasted
 * `/review?gameId=…` know it is the fourth of six.
 */
export const useSeriesForGame = (gameId: string | null | undefined, revision?: unknown) =>
  useSeriesRequest(gameId, botSeriesForGame, revision);
