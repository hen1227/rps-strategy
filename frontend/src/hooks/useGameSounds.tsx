import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { GameSound } from '@/appearance/gameSound';
import { soundPackById } from '@/appearance/soundPacks';
import { useAppearanceStore } from '@/appearance/store';
import { useGameStore } from '@/store/gameStore';
import type { ActiveGame } from '@/store/types';
import type { Piece, PlayerColor } from '@/types/game';

// A capture is named for the piece that made it, not the piece that fell,
// because `canCapture` is a strict cycle — rock takes scissors, scissors takes
// paper, paper takes rock, in every mode — so the piece removed from the board
// names its taker exactly. The lookup below is still keyed by the victim,
// which is what the grid comparison can actually see.
//
// The clips themselves live in `@/appearance/soundPacks`, one set per pack, and
// which pack is playing is read from the appearance store below. Both move
// sounds are the same clip in the pack that ships; keeping them apart as
// separate names costs nothing and leaves giving the opponent their own voice a
// one-line change, instead of rebuilding the branch that tells them apart.
export type { GameSound } from '@/appearance/gameSound';

const CAPTURE_SOUND_BY_PIECE: Partial<Record<Piece, GameSound>> = {
  Paper: 'scissorsTakesPaper',
  Rock: 'paperTakesRock',
  Scissors: 'rockTakesScissors',
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

  // A game we have not seen before is either one that is just beginning or one
  // being rejoined, and those want different things said. An untouched board is
  // the only reliable way to tell them apart from here.
  if (!previous || previous.gameId !== next.gameId) {
    return next.moveNumber === 0 ? 'start' : 'notify';
  }

  if (next.moveNumber <= previous.moveNumber) {
    const didTimeOut = previous.status === 'InProgress' && next.status === 'Finished';
    return didTimeOut ? 'end' : null;
  }

  // Every ending sounds the same now. Reaching the goal used to be told apart
  // from the other endings, which is worth restoring if a second ending clip
  // ever exists: the test was `endReason === 'infiltration' || 'corner'`.
  if (next.status === 'Finished') return 'end';

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
 *
 * Changing the sound pack builds nine new elements, which spends the permission
 * all over again — so a pack change primes *immediately* rather than waiting for
 * the next gesture. It can: choosing a pack is itself a tap, so the browser is
 * still inside a gesture when this runs. Waiting would cost the player the first
 * sound after every switch, which is the one they changed the pack to hear.
 */
const usePrimedForBrowser = (players: Record<GameSound, AudioPlayer>, packId: string) => {
  const primedPack = useRef<string | null>(null);

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

    // A pack the player just chose is already inside a gesture, so spend the
    // grant now. Only the very first pack of a visit has to wait to be asked.
    const swapped = primedPack.current !== null && primedPack.current !== packId;
    primedPack.current = packId;
    if (swapped) {
      prime();
      return undefined;
    }

    // Listening as the event travels down, so that a component stopping it on
    // the way cannot cost the page its one chance to prime.
    for (const type of GESTURE_EVENTS) window.addEventListener(type, prime, true);
    return () => {
      for (const type of GESTURE_EVENTS) window.removeEventListener(type, prime, true);
    };
  }, [packId, players]);
};

/**
 * Ask the platform to lay these sounds over whatever else is playing.
 *
 * Neither platform assumes an app that makes a sound is willing to share. iOS
 * activates its default `soloAmbient` session on the first `play()`, which
 * stops whatever the player had on; Android asks for transient audio focus,
 * which pauses or ducks it. Both are the wrong bargain for a move sound, and
 * `mixWithOthers` is the mode meant for sound effects: iOS takes the `ambient`
 * category instead, and Android stops asking for focus at all.
 *
 * `playsInSilentMode` is one name for two different switches, so it is answered
 * per platform. On iOS it is the ring/silent switch, which a game should obey
 * and which the untouched session already obeyed. On Android it is the ringer
 * mode, which says nothing about media volume and is left on vibrate by people
 * who still want to hear the board.
 *
 * A browser strikes the same bargain on the page's behalf, and `ambient` is how
 * it is asked not to: left on `auto`, Safari decides for itself what a page
 * playing an `<audio>` element is up to and settles on a type that interrupts.
 * Where the Audio Session API is not implemented — Chrome on Android, today —
 * there is nothing to ask, and short effects still duck what is playing.
 */
const useMixedWithBackgroundAudio = () => {
  useEffect(() => {
    if (IS_WEB) {
      if (typeof navigator === 'undefined') return;
      const session = (navigator as Navigator & { audioSession?: { type: string } })
        .audioSession;
      if (!session) return;
      try {
        session.type = 'ambient';
      } catch {
        // A browser may know the property without knowing this value.
      }
      return;
    }

    void setAudioModeAsync({
      interruptionMode: 'mixWithOthers',
      playsInSilentMode: Platform.OS !== 'ios',
      allowsRecording: false,
      shouldPlayInBackground: false,
    }).catch(() => {
      // A refused audio mode costs the player their background audio, not the
      // game, so it is not worth interrupting anything over.
    });
  }, []);
};

const useGameSounds = () => {
  const gameState = useGameStore((state) => state.gameState);
  const playerColor = useGameStore((state) => state.playerColor);
  const rejectedMoveCount = useGameStore((state) => state.rejectedMoveCount);
  const previousGameState = useRef<ActiveGame | null>(null);

  // The pack is what the nine players below are built from, so changing it
  // rebuilds all nine: `useAudioPlayer` memoises on the source and releases the
  // player it replaces. That is also why `Silent` needs no branch anywhere —
  // `null` is a legal source, and a player with nothing to play makes no sound.
  const packId = useAppearanceStore((state) => state.appearance.sound);
  const sources = soundPackById(packId).sources;

  const endPlayer = useAudioPlayer(sources.end);
  const illegalPlayer = useAudioPlayer(sources.illegal);
  const moveOpponentPlayer = useAudioPlayer(sources.moveOpponent);
  const moveSelfPlayer = useAudioPlayer(sources.moveSelf);
  const notifyPlayer = useAudioPlayer(sources.notify);
  const paperTakesRockPlayer = useAudioPlayer(sources.paperTakesRock);
  const rockTakesScissorsPlayer = useAudioPlayer(sources.rockTakesScissors);
  const scissorsTakesPaperPlayer = useAudioPlayer(sources.scissorsTakesPaper);
  const startPlayer = useAudioPlayer(sources.start);

  const players = useMemo<Record<GameSound, AudioPlayer>>(
    () => ({
      end: endPlayer,
      illegal: illegalPlayer,
      moveOpponent: moveOpponentPlayer,
      moveSelf: moveSelfPlayer,
      notify: notifyPlayer,
      paperTakesRock: paperTakesRockPlayer,
      rockTakesScissors: rockTakesScissorsPlayer,
      scissorsTakesPaper: scissorsTakesPaperPlayer,
      start: startPlayer,
    }),
    [
      endPlayer,
      illegalPlayer,
      moveOpponentPlayer,
      moveSelfPlayer,
      notifyPlayer,
      paperTakesRockPlayer,
      rockTakesScissorsPlayer,
      scissorsTakesPaperPlayer,
      startPlayer,
    ],
  );

  useMixedWithBackgroundAudio();
  usePrimedForBrowser(players, packId);

  useEffect(() => {
    const sound = getGameSoundForTransition(
      previousGameState.current,
      gameState,
      playerColor,
    );
    previousGameState.current = gameState;

    if (sound) replay(players[sound]);
  }, [gameState, playerColor, players]);

  // A refused move changes no game state at all, so it cannot be heard by
  // comparing boards the way everything above is. The store counts them
  // instead, and the count going up is the event.
  useEffect(() => {
    if (rejectedMoveCount === 0) return;
    replay(players.illegal);
  }, [rejectedMoveCount, players]);
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
