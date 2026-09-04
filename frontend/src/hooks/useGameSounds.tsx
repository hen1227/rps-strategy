import { useAudioPlayer } from 'expo-audio';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { useGameStore } from '@/store/gameStore';
import type { ActiveGame } from '@/store/types';
import type { Piece, PlayerColor } from '@/types/game';

const SOUND_SOURCES = {
  capturePaper: require('../../assets/sounds/paper_captures.mp3'),
  captureRock: require('../../assets/sounds/rock_captures.mp3'),
  captureScissors: require('../../assets/sounds/scissor_captures.mp3'),
  moveCheck: require('../../assets/sounds/move-check.mp3'),
  moveOpponent: require('../../assets/sounds/move-opponent.mp3'),
  moveSelf: require('../../assets/sounds/move-self.mp3'),
  notify: require('../../assets/sounds/notify.mp3'),
  promote: require('../../assets/sounds/promote.mp3'),
};

/** Which sound a transition calls for. */
export type GameSound =
  | 'capturePaper'
  | 'captureRock'
  | 'captureScissors'
  | 'moveCheck'
  | 'moveOpponent'
  | 'moveSelf'
  | 'notify'
  | 'promote';

const CAPTURE_SOUND_BY_PIECE: Partial<Record<Piece, GameSound>> = {
  Paper: 'capturePaper',
  Rock: 'captureRock',
  Scissors: 'captureScissors',
};

const occupiedTileCount = (gameState: ActiveGame) =>
  gameState.grid.reduce(
    (count, row) =>
      count + row.filter((tile) => tile.occupant && tile.occupant !== 'Empty').length,
    0,
  );

const captureSoundForTransition = (
  previous: ActiveGame,
  next: ActiveGame,
): GameSound | null => {
  if (occupiedTileCount(next) >= occupiedTileCount(previous)) return null;

  for (let y = 0; y < previous.grid.length; y += 1) {
    const row = previous.grid[y] ?? [];
    for (let x = 0; x < row.length; x += 1) {
      const before = row[x];
      const after = next.grid[y]?.[x];
      if (
        before &&
        after?.occupant === 'Empty' &&
        before.occupantOwner === previous.currentTurn
      ) {
        return CAPTURE_SOUND_BY_PIECE[before.occupant] ?? null;
      }
    }
  }

  return null;
};

export const getGameSoundForTransition = (
  previous: ActiveGame | null | undefined,
  next: ActiveGame | null | undefined,
  playerColor: PlayerColor | null,
): GameSound | null => {
  if (!next) return null;

  if (!previous || previous.gameId !== next.gameId) {
    return 'notify';
  }

  if (next.moveNumber <= previous.moveNumber) {
    const didTimeOut = previous.status === 'InProgress' && next.status === 'Finished';
    return didTimeOut ? 'notify' : null;
  }

  if (next.status === 'Finished') {
    // Both goal modes end the same way — a piece arriving somewhere — and both
    // deserve the arrival sound rather than the ordinary one.
    const reachedGoal = next.endReason === 'infiltration' || next.endReason === 'corner';
    return reachedGoal ? 'promote' : 'moveCheck';
  }

  const captureSound = captureSoundForTransition(previous, next);
  if (captureSound) return captureSound;

  // Every move at a shared board was made by the hand on this device, so there
  // is no opponent's move to tell apart. Without this the whole game would play
  // in the opponent's voice, `playerColor` being nobody's there.
  if (next.local) return 'moveSelf';
  return previous.currentTurn === playerColor ? 'moveSelf' : 'moveOpponent';
};

type AudioPlayer = ReturnType<typeof useAudioPlayer>;

const IS_WEB = Platform.OS === 'web';

/**
 * The `<audio>` element a web player speaks through, where there is one.
 *
 * A browser refuses a sound it did not expect — anything before the page has
 * been touched, and on iOS anything from a clip the player has never started by
 * hand — by rejecting the promise `play()` hands back. expo-audio's web player
 * drops that promise, so the refusal lands on nothing and is reported as an
 * uncaught error: in development, a red screen over the board on the first
 * `notify` of a game rejoined at page load. Going through the element is the
 * only way to be there to catch it. Should a later version of expo-audio keep
 * its element somewhere else, playback falls back to the player's own `play`,
 * which is where we started.
 */
const mediaElementOf = (player: AudioPlayer): HTMLAudioElement | null => {
  if (!IS_WEB || typeof HTMLAudioElement === 'undefined') return null;
  const media = (player as unknown as { media?: unknown }).media;
  return media instanceof HTMLAudioElement ? media : null;
};

const replay = (player: AudioPlayer) => {
  const media = mediaElementOf(player);
  try {
    if (media) {
      // Unmuted before playing, which is also how a priming pass still in
      // flight is told that this element now has a sound to make.
      media.muted = false;
      media.currentTime = 0;
      void media.play().catch(() => {});
      return;
    }
    if (player.currentTime > 0 || player.playing) {
      Promise.resolve(player.seekTo(0)).catch(() => {});
    }
    player.play();
  } catch {
    // Audio should never interrupt gameplay if a platform rejects playback.
  }
};

// The events WebKit counts as the player acting, and so as permission to make
// a sound. `click` covers a mouse and every pressable in the app, `touchend` a
// tap, `keydown` a keyboard.
const GESTURE_EVENTS = ['click', 'touchend', 'keydown'] as const;

/**
 * Spend the first thing the player does on letting the browser hear the clips.
 *
 * iOS grants permission per element rather than per page: a clip never started
 * inside a gesture stays silent for the whole visit, however much is tapped
 * afterwards. Starting each of them muted during that first gesture and
 * rewinding spends the permission without making a sound, and leaves every clip
 * free to play when the game asks for it.
 */
const usePrimedForBrowser = (players: Record<GameSound, AudioPlayer>) => {
  useEffect(() => {
    if (!IS_WEB || typeof window === 'undefined') return undefined;

    const prime = () => {
      for (const type of GESTURE_EVENTS) window.removeEventListener(type, prime, true);
      for (const player of Object.values(players)) {
        const media = mediaElementOf(player);
        if (!media) continue;
        media.muted = true;
        void media.play().then(
          () => {
            // Stopping only what is still the priming pass: pausing a `play()`
            // that has yet to begin is itself reported as a failure, and a real
            // sound may have taken the element over in the meantime.
            if (!media.muted) return;
            media.pause();
            media.currentTime = 0;
            media.muted = false;
          },
          () => {
            media.muted = false;
          },
        );
      }
    };

    // Listening as the event travels down, so that a component stopping it on
    // the way cannot cost the page its one chance to prime.
    for (const type of GESTURE_EVENTS) window.addEventListener(type, prime, true);
    return () => {
      for (const type of GESTURE_EVENTS) window.removeEventListener(type, prime, true);
    };
  }, [players]);
};

const useGameSounds = () => {
  const gameState = useGameStore((state) => state.gameState);
  const playerColor = useGameStore((state) => state.playerColor);
  const previousGameState = useRef<ActiveGame | null>(null);

  const capturePaperPlayer = useAudioPlayer(SOUND_SOURCES.capturePaper);
  const captureRockPlayer = useAudioPlayer(SOUND_SOURCES.captureRock);
  const captureScissorsPlayer = useAudioPlayer(SOUND_SOURCES.captureScissors);
  const moveCheckPlayer = useAudioPlayer(SOUND_SOURCES.moveCheck);
  const moveOpponentPlayer = useAudioPlayer(SOUND_SOURCES.moveOpponent);
  const moveSelfPlayer = useAudioPlayer(SOUND_SOURCES.moveSelf);
  const notifyPlayer = useAudioPlayer(SOUND_SOURCES.notify);
  const promotePlayer = useAudioPlayer(SOUND_SOURCES.promote);

  const players = useMemo<Record<GameSound, AudioPlayer>>(
    () => ({
      capturePaper: capturePaperPlayer,
      captureRock: captureRockPlayer,
      captureScissors: captureScissorsPlayer,
      moveCheck: moveCheckPlayer,
      moveOpponent: moveOpponentPlayer,
      moveSelf: moveSelfPlayer,
      notify: notifyPlayer,
      promote: promotePlayer,
    }),
    [
      capturePaperPlayer,
      captureRockPlayer,
      captureScissorsPlayer,
      moveCheckPlayer,
      moveOpponentPlayer,
      moveSelfPlayer,
      notifyPlayer,
      promotePlayer,
    ],
  );

  usePrimedForBrowser(players);

  useEffect(() => {
    const sound = getGameSoundForTransition(
      previousGameState.current,
      gameState,
      playerColor,
    );
    previousGameState.current = gameState;

    if (sound) replay(players[sound]);
  }, [gameState, playerColor, players]);
};

const GameSoundPlayers = () => {
  useGameSounds();
  return null;
};

/**
 * The game's sound effects, mounted only in the browser.
 *
 * `useAudioPlayer` has no server implementation, and every page of this site is
 * pre-rendered in Node at build time. Calling it during that pass throws inside
 * a Suspense boundary, which React answers by discarding the whole
 * pre-rendered page and re-rendering it on the client — so every page shipped
 * as an empty shell. Waiting for the first client render keeps the audio
 * players out of the build entirely.
 */
export const GameSoundEffects = () => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <GameSoundPlayers /> : null;
};
