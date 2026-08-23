import { useAudioPlayer } from 'expo-audio';
import { useEffect, useRef, useState } from 'react';

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
    const reachedBackRank = next.mode?.id === 'V3' && next.endReason === 'infiltration';
    return reachedBackRank ? 'promote' : 'moveCheck';
  }

  const captureSound = captureSoundForTransition(previous, next);
  if (captureSound) return captureSound;

  return previous.currentTurn === playerColor ? 'moveSelf' : 'moveOpponent';
};

type AudioPlayer = ReturnType<typeof useAudioPlayer>;

const replay = (player: AudioPlayer) => {
  try {
    if (player.currentTime > 0 || player.playing) {
      Promise.resolve(player.seekTo(0)).catch(() => {});
    }
    player.play();
  } catch {
    // Audio should never interrupt gameplay if a platform rejects playback.
  }
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

  useEffect(() => {
    const sound = getGameSoundForTransition(
      previousGameState.current,
      gameState,
      playerColor,
    );
    previousGameState.current = gameState;

    const players: Record<GameSound, AudioPlayer> = {
      capturePaper: capturePaperPlayer,
      captureRock: captureRockPlayer,
      captureScissors: captureScissorsPlayer,
      moveCheck: moveCheckPlayer,
      moveOpponent: moveOpponentPlayer,
      moveSelf: moveSelfPlayer,
      notify: notifyPlayer,
      promote: promotePlayer,
    };

    if (sound) replay(players[sound]);
  }, [
    capturePaperPlayer,
    captureRockPlayer,
    captureScissorsPlayer,
    gameState,
    moveCheckPlayer,
    moveOpponentPlayer,
    moveSelfPlayer,
    notifyPlayer,
    playerColor,
    promotePlayer,
  ]);
};

/**
 * Whether a summons is new enough to be worth a chime.
 *
 * Only the summoned side. Somebody who is already present and watching the
 * other player be fetched gets the card arriving, which is enough — a chime for
 * a countdown you are not on the wrong end of is noise.
 */
export const shouldSoundQueueSummon = (
  previousPendingId: string | null,
  claim: { pendingId: string; role: 'summoned' | 'present' } | null,
): boolean =>
  Boolean(claim && claim.role === 'summoned' && claim.pendingId !== previousPendingId);

/**
 * The chime when a seat is being held for you.
 *
 * It lives with the game sounds rather than in the call-out, because
 * `GameSoundEffects` is already the one component that owns audio and already
 * loads this exact file. Autoplay is not a concern: joining the queue was a
 * click, which unlocks the tab's audio for its lifetime. The sound is a bonus
 * on top of the card and the notification, never the mechanism.
 */
const useQueueSummonSound = () => {
  const claim = useGameStore((state) => state.claim);
  const notifyPlayer = useAudioPlayer(SOUND_SOURCES.notify);
  const lastSounded = useRef<string | null>(null);

  useEffect(() => {
    if (!shouldSoundQueueSummon(lastSounded.current, claim)) return;
    lastSounded.current = claim?.pendingId ?? null;
    replay(notifyPlayer);
  }, [claim, notifyPlayer]);
};

const GameSoundPlayers = () => {
  useGameSounds();
  useQueueSummonSound();
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
