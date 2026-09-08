import { useEffect, useMemo, useState } from 'react';

import {
  openingNaming,
  openingOfGame,
  type GameOpening,
  type OpeningNamingInput,
} from '@/engine/openingBook';
import { getOpeningNames } from '@/store/api/openings';
import type { ActiveGame } from '@/store/types';
import type { ModeID } from '@/types/game';

// What the game on the board is called.
//
// Every screen that shows a game asks this the same way: hand over the game,
// get back the opening — the same rule `useGameAnalysis` follows, and for the
// same reason. Two screens disagreeing about which opening was played would be
// worse than neither of them saying.
//
// The line itself is never worked out here. It arrives on the game state,
// written by whoever owns the game: the server for a live match, the session
// slice for a bot game or a shared board. See `GameState.openingLine`.

/**
 * Published names, once per mode, for as long as the tab is open.
 *
 * Names change when a curator publishes one, which is rare and never during
 * the game you are playing. The board asks for this on every game, so asking
 * the server every time would be spending a request to be told the same
 * thing.
 */
const namesByMode = new Map<ModeID, OpeningNamingInput>();
const loading = new Map<ModeID, Promise<OpeningNamingInput | null>>();

const loadNames = (modeId: ModeID): Promise<OpeningNamingInput | null> => {
  const cached = namesByMode.get(modeId);
  if (cached) return Promise.resolve(cached);
  const already = loading.get(modeId);
  if (already) return already;
  const request = getOpeningNames(modeId)
    .then((response) => {
      const names: OpeningNamingInput = {
        names: response.names ?? [],
        mirrorNaming: response.mirrorNaming,
      };
      namesByMode.set(modeId, names);
      return names;
    })
    // A book that cannot be reached is a badge that does not appear. It is the
    // one thing on this screen nobody is waiting for, and a game in progress
    // is no place for an error about what an opening is called.
    .catch(() => null)
    .finally(() => loading.delete(modeId));
  loading.set(modeId, request);
  return request;
};

/**
 * The opening a game is playing, or null while it has none to show: before the
 * first move, past the end of the opening, or on a board somebody drew.
 */
export const useGameOpening = (game: ActiveGame | null | undefined): GameOpening | null => {
  const modeId = game?.mode?.id ?? null;
  const line = game?.openingLine;
  const key = line?.join(' ') ?? '';
  // Whether there is anything to look up, rather than what it is: the names do
  // not change between one move and the next, and depending on the line itself
  // would ask for them again on every move of every game.
  const hasLine = key.length > 0;
  // Held with the mode it describes. A game of one mode following a game of
  // another — a rematch in a different mode, or a spectator moving between
  // boards — would otherwise be named out of the previous book for a render.
  const [loaded, setLoaded] = useState<{ modeId: ModeID; names: OpeningNamingInput } | null>(null);

  useEffect(() => {
    // Not asked for until there is a line to look up, so a game nobody has
    // moved in — and a custom board, which never gets one — costs nothing.
    if (!modeId || !hasLine) return undefined;
    let cancelled = false;
    loadNames(modeId).then((names) => {
      if (cancelled || !names) return;
      setLoaded((current) =>
        current?.modeId === modeId && current.names === names ? current : { modeId, names },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [hasLine, modeId]);

  const names = loaded && loaded.modeId === modeId ? loaded.names : null;
  const naming = useMemo(() => (names ? openingNaming(names) : null), [names]);

  return useMemo(
    () => (naming && key ? openingOfGame(naming, key.split(' ')) : null),
    [key, naming],
  );
};

export default useGameOpening;
