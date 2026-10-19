// How a clip is started again from the top.
//
// Its own file, apart from the players in `useGameSounds`, so that it can be
// tested: that file needs expo-audio, which does not load outside an app.

/** The part of an expo-audio player that replaying a clip touches. */
export interface ReplayablePlayer {
  readonly currentTime: number;
  readonly playing: boolean;
  play(): void;
  seekTo(seconds: number): Promise<void>;
}

/**
 * Play `player` from its start, rewinding it first if it has to be.
 *
 * `waitForRewind` is for a platform that does not run the rewind and the play in
 * the order they were sent. iOS is one: a play sent straight after a rewind
 * overtakes it, starts the clip at its end, and is heard as nothing. See
 * `useRewoundWhenFinished` in `useGameSounds` for what that cost.
 */
export const replayFromStart = (player: ReplayablePlayer, waitForRewind: boolean) => {
  if (player.currentTime > 0 || player.playing) {
    const rewound = Promise.resolve(player.seekTo(0));
    if (waitForRewind) {
      // A player released while the rewind was in flight throws here, which is
      // a sound nobody is waiting for any more.
      rewound.then(() => player.play()).catch(() => {});
      return;
    }
    rewound.catch(() => {});
  }
  player.play();
};
