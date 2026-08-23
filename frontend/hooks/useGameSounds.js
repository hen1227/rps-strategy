import { useAudioPlayer } from 'expo-audio';
import { useEffect, useRef } from 'react';

import { useGameStore } from '../store/gameStore';

const SOUND_SOURCES = {
  capturePaper: require('../assets/sounds/paper_captures.mp3'),
  captureRock: require('../assets/sounds/rock_captures.mp3'),
  captureScissors: require('../assets/sounds/scissor_captures.mp3'),
  moveCheck: require('../assets/sounds/move-check.mp3'),
  moveOpponent: require('../assets/sounds/move-opponent.mp3'),
  moveSelf: require('../assets/sounds/move-self.mp3'),
  notify: require('../assets/sounds/notify.mp3'),
  promote: require('../assets/sounds/promote.mp3'),
};

const CAPTURE_SOUND_BY_PIECE = {
  Paper: 'capturePaper',
  Rock: 'captureRock',
  Scissors: 'captureScissors',
};

const occupiedTileCount = (gameState) =>
  gameState.grid.reduce(
    (count, row) =>
      count + row.filter((tile) => tile.occupant && tile.occupant !== 'Empty').length,
    0,
  );

const captureSoundForTransition = (previous, next) => {
  if (occupiedTileCount(next) >= occupiedTileCount(previous)) return null;

  for (let y = 0; y < previous.grid.length; y += 1) {
    for (let x = 0; x < previous.grid[y].length; x += 1) {
      const before = previous.grid[y][x];
      const after = next.grid[y]?.[x];
      if (
        after?.occupant === 'Empty' &&
        before.occupantOwner === previous.currentTurn
      ) {
        return CAPTURE_SOUND_BY_PIECE[before.occupant] ?? null;
      }
    }
  }

  return null;
};

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
    const reachedBackRank = next.mode?.id === 'V3' && next.endReason === 'infiltration';
    return reachedBackRank ? 'promote' : 'moveCheck';
  }

  const captureSound = captureSoundForTransition(previous, next);
  if (captureSound) return captureSound;

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

    const player = {
      capturePaper: capturePaperPlayer,
      captureRock: captureRockPlayer,
      captureScissors: captureScissorsPlayer,
      moveCheck: moveCheckPlayer,
      moveOpponent: moveOpponentPlayer,
      moveSelf: moveSelfPlayer,
      notify: notifyPlayer,
      promote: promotePlayer,
    }[sound];

    if (player) replay(player);
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

export const GameSoundEffects = () => {
  useGameSounds();
  return null;
};
