import { useEffect, useState } from 'react';

import { botSeries, type BotSeries } from '@/store/api/bots';

// The run behind a board, fetched by id.
//
// A live series game already arrives with its tally on it — `LiveGameSeries`,
// which rides along with the lobby row — and that is enough to say "game 4 of 6,
// 2–1". It is not enough to draw the games themselves, because the lobby has no
// reason to carry six results on every row of every broadcast. So the strip asks
// for them once and again whenever the run moves on.
//
// A failure answers null rather than raising. The board underneath is the thing
// somebody came to watch, and a missing strip is a much smaller problem than an
// error over the top of it.
export function useBotSeries(seriesId: string | null | undefined, revision?: unknown) {
  const [series, setSeries] = useState<BotSeries | null>(null);

  useEffect(() => {
    if (!seriesId) {
      setSeries(null);
      return undefined;
    }
    let cancelled = false;
    botSeries(seriesId)
      .then((found) => {
        if (!cancelled) setSeries(found ?? null);
      })
      .catch(() => {
        if (!cancelled) setSeries(null);
      });
    return () => {
      cancelled = true;
    };
    // `revision` is the caller's way of saying the run has moved on — the game
    // number off the live row — since nothing else here would notice.
  }, [revision, seriesId]);

  return series;
}
