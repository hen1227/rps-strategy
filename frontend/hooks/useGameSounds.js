import { useAudioPlayer } from 'expo-audio';
import { useEffect, useRef } from 'react';

import { useGameStore } from '../store/gameStore';

const SOUND_SOURCES = {
  capture: require('../assets/sounds/capture.mp3'),
  moveCheck: require('../assets/sounds/move-check.mp3'),
  moveOpponent: require('../assets/sounds/move-opponent.mp3'),
  moveSelf: require('../assets/sounds/move-self.mp3'),
  notify: require('../assets/sounds/notify.mp3'),
  promote: require('../assets/sounds/promote.mp3'),
};

const occupiedTileCount = (gameState) =>
  gameState.grid.reduce(
    (count, row) =>
      count + row.filter((tile) => tile.occupant && tile.occupant !== 'Empty').length,
    0,
  );

export const getGameSoundForTransition = (previous, next, playerColor) => {
  if (!next) return null;

  if (!previous || previous.gameId !== next.gameId) {
    return 'notify';
  }

  if (next.moveNumber <= previous.moveNumber) {
    const didTimeOut = previous.status === 'InProgress' && next.status === 'Finished';
    return didTimeOut ? 'notify' : null;
  }

  if (next.status === 'Finished') {
    const reachedBackRank = next.mode?.id === 'V3' && next.endReason !== 'timeout';
    return reachedBackRank ? 'promote' : 'moveCheck';
  }

  if (occupiedTileCount(next) < occupiedTileCount(previous)) {
    return 'capture';
  }

  return previous.currentTurn === playerColor ? 'moveSelf' : 'moveOpponent';
};

const replay = (player) => {
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
  const previousGameState = useRef(null);

  const capturePlayer = useAudioPlayer(SOUND_SOURCES.capture);
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

    const player = {
      capture: capturePlayer,
      moveCheck: moveCheckPlayer,
      moveOpponent: moveOpponentPlayer,
      moveSelf: moveSelfPlayer,
      notify: notifyPlayer,
      promote: promotePlayer,
    }[sound];

    if (player) replay(player);
  }, [
    capturePlayer,
    gameState,
    moveCheckPlayer,
    moveOpponentPlayer,
    moveSelfPlayer,
    notifyPlayer,
    playerColor,
    promotePlayer,
  ]);
};

export const GameSoundEffects = () => {
  useGameSounds();
  return null;
};
