import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { replayFromStart, type ReplayablePlayer } from './replayFromStart';

// A player that rewinds the way iOS does: the seek lands later, on its own
// schedule, and a play sent before it lands starts wherever the clip is.
const fakePlayer = (currentTime: number, playing = false) => {
  const calls: string[] = [];
  let landRewind = () => {};
  const player: ReplayablePlayer & { position: number; startedAt: number[] } = {
    position: currentTime,
    startedAt: [],
    get currentTime() {
      return this.position;
    },
    playing,
    play() {
      calls.push('play');
      this.startedAt.push(this.position);
    },
    seekTo(seconds) {
      calls.push('seek');
      return new Promise<void>((resolve) => {
        landRewind = () => {
          player.position = seconds;
          resolve();
        };
      });
    },
  };
  return { calls, player, landRewind: () => landRewind() };
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('replayFromStart', () => {
  it('plays a clip at its start at once, with no rewind', () => {
    const { calls, player } = fakePlayer(0);
    replayFromStart(player, true);
    assert.deepEqual(calls, ['play']);
  });

  it('waits for the rewind before playing a finished clip, where asked to', async () => {
    const { calls, player, landRewind } = fakePlayer(0.072);
    replayFromStart(player, true);
    await settle();
    // Played here, this is the bug: the clip would start at its end.
    assert.deepEqual(calls, ['seek']);
    landRewind();
    await settle();
    assert.deepEqual(calls, ['seek', 'play']);
    assert.deepEqual(player.startedAt, [0]);
  });

  it('rewinds a clip that is still playing before playing it again', async () => {
    const { calls, player, landRewind } = fakePlayer(0.03, true);
    replayFromStart(player, true);
    landRewind();
    await settle();
    assert.deepEqual(calls, ['seek', 'play']);
    assert.deepEqual(player.startedAt, [0]);
  });

  it('sends the rewind and the play together where the platform keeps them in order', () => {
    const { calls, player } = fakePlayer(0.072);
    replayFromStart(player, false);
    assert.deepEqual(calls, ['seek', 'play']);
  });

  it('drops a replay whose player was released while it rewound', async () => {
    const { player, landRewind } = fakePlayer(0.072);
    player.play = () => {
      throw new Error('released');
    };
    replayFromStart(player, true);
    landRewind();
    // An unhandled rejection here would fail the run.
    await settle();
  });
});
