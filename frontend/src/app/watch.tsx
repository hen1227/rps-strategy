import { useRouter } from 'expo-router';
import { useEffect } from 'react';

import GameScreen from '@/features/game/GameScreen';
import { links } from '@/navigation/links';
import PageTitle from '@/navigation/PageTitle';
import { useSettledSearchParams } from '@/navigation/useSettledSearchParams';
import { useGameStore } from '@/store/gameStore';
import { isGameLive } from '@/store/spectateSelectors';

// Watching somebody else's game, at an address.
//
// This used to be `/play` with a different board swapped in underneath it,
// which made spectating the one thing on this site you could not link to,
// bookmark, or refresh: a reload dropped the viewer into their own empty lobby,
// because nothing about what they were watching was written down anywhere.
//
// The game id in the query string is the whole of that fix, and it makes this
// page the only thing that asks to spectate: every list that offers a game to
// watch now navigates here instead of calling `spectateGame` itself, and
// swapping boards from the rail over the board is a change of address like any
// other. One owner, so the board on screen and the URL cannot disagree.
export default function Page() {
  const { params, settled } = useSettledSearchParams<{ gameId?: string }>();
  const requested = (Array.isArray(params.gameId) ? params.gameId[0] : params.gameId) ?? '';
  const gameId = requested.trim();

  const router = useRouter();
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const liveGames = useGameStore((state) => state.liveGames);
  const spectatedGameId = useGameStore((state) => state.spectatedGameId);
  const spectateGame = useGameStore((state) => state.spectateGame);
  const watchedGameId = useGameStore((state) =>
    state.isSpectating ? (state.gameState?.gameId ?? null) : null,
  );
  // A game of our own still being played. The server refuses to let a player
  // spectate anything while they are in a game, and it is right to: whichever
  // board they asked for, the one they should be looking at is theirs. A
  // *finished* game of ours does not count — it is only being kept for its chat
  // room, and the server drops us out of that when we go to watch something.
  const ownGameId = useGameStore((state) =>
    !state.isSpectating && state.gameState?.status === 'InProgress'
      ? state.gameState.gameId
      : null,
  );

  useEffect(() => {
    // A pre-rendered page has no query string; the real one arrives a render
    // later. Acting on the first render would send everybody to the lobby.
    if (!settled) return;
    // An address with no game in it is not a page. The lobby is where the games
    // worth watching are listed.
    if (!gameId) {
      router.replace(links.lobby());
      return;
    }
    if (ownGameId) {
      router.replace(links.play());
      return;
    }
    // Not connected yet means not knowing anything: the live list arrives with
    // the connection, and the decision below needs it.
    if (connectionStatus !== 'connected') return;
    // Already watching this game, or already asked for it.
    if (watchedGameId === gameId || spectatedGameId === gameId) return;
    // A link to a game that has since finished. There is no live board left to
    // put anybody on, so it forwards to the record instead — which is what
    // makes a watch link worth pasting in the first place: it still means
    // something after the game it names is over.
    //
    // Decided from the lobby's own live list rather than by asking and reading
    // the refusal, because that list is complete and is already here. It is the
    // same rule `useOpenGame` applies to every other list of games.
    if (!isGameLive(liveGames, gameId)) {
      router.replace(links.review(gameId));
      return;
    }
    spectateGame(gameId);
  }, [
    connectionStatus,
    gameId,
    liveGames,
    ownGameId,
    router,
    settled,
    spectateGame,
    spectatedGameId,
    watchedGameId,
  ]);

  return (
    <>
      <PageTitle title="Watch" />
      <GameScreen />
    </>
  );
}
