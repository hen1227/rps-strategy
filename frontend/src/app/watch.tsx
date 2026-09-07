import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';

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
//
// Stopping is the address's job too, and for the same reason it cannot be this
// page's: leaving unmounts it. `SessionBridge` puts the board down when the
// address stops being this one — see the rule beside its sibling there.
export default function Page() {
  const { params, settled } = useSettledSearchParams<{ gameId?: string }>();
  const requested = (Array.isArray(params.gameId) ? params.gameId[0] : params.gameId) ?? '';
  const gameId = requested.trim();

  const router = useRouter();
  // Whether this page is the page somebody is on. A screen that has been
  // pushed over — a player's profile, the review of the game — leaves this one
  // mounted underneath it, and a page nobody is looking at has no business
  // asking the server for a board or sending the reader somewhere else.
  const pathname = usePathname();
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const liveGames = useGameStore((state) => state.liveGames);
  const spectatedGameId = useGameStore((state) => state.spectatedGameId);
  const spectateGame = useGameStore((state) => state.spectateGame);
  // A board that was taken away rather than finished — an engine recalled to
  // its own tournament match, a moderator stopping a game. Nothing about it was
  // filed, so unlike every other way the board can go there is no record to
  // send anybody to.
  const cancelledGame = useGameStore((state) => state.cancelledGame);
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
  // Whether this page has asked for the game in its address yet.
  //
  // Holding no board means two opposite things — we have not started yet, or we
  // have just been taken off one — and everything below is written for the
  // first. See the guard that reads this.
  const asked = useRef(false);

  useEffect(() => {
    // A pre-rendered page has no query string; the real one arrives a render
    // later. Acting on the first render would send everybody to the lobby.
    if (!settled) return;
    // Still mounted, but underneath something else. `SessionBridge` has put the
    // board down on the way out (watching belongs to this address and to no
    // other), and asking for it again from back here would take it straight up.
    if (pathname !== '/watch') return;
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
    if (watchedGameId === gameId || spectatedGameId === gameId) {
      asked.current = true;
      return;
    }
    // Asked once, and holding nothing now: the board has been put down while
    // this page is still standing at its address, which is what leaving looks
    // like from in here.
    //
    // Leaving has to be allowed to finish. `router.replace` is queued and
    // dispatched from an effect rather than taken on the spot, so this page
    // renders once more — still `/watch`, now with an empty store — before the
    // lobby it asked for arrives, and anything this effect decides in that
    // render is queued *behind* the lobby and lands on top of it. That is how
    // pressing "‹ Lobby" on a finished game arrived at that game's review
    // instead, and at "this game cannot be reviewed" whenever the archive had
    // not written it yet: the forward below fires, because a game that has
    // ended is no longer in the live list. A game still being played was worse
    // in its own way — the ask at the bottom rejoined the audience of a board
    // nobody was watching any more, on the way out of it.
    if (asked.current) return;
    // The board was stopped while this page was showing it. It is not in the
    // live list any more and it was never filed, so the forward below would
    // land on "this game cannot be reviewed" — a dead end that explains
    // nothing, for the one case that most needs explaining. Staying put is what
    // lets the board's own screen say what happened to it.
    if (cancelledGame?.gameId === gameId) return;
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
    asked.current = true;
    spectateGame(gameId);
  }, [
    cancelledGame,
    connectionStatus,
    gameId,
    liveGames,
    ownGameId,
    pathname,
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
