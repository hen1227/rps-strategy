import type { AudioSource } from 'expo-audio';

import type { GameSound } from './gameSound';

// Which clips the board speaks with.
//
// One entry per `GameSound`, and `null` is a legal source in expo-audio — which
// is the whole of how Silent works: no branch anywhere else in the sound layer,
// no muted flag to keep in step, just a pack whose every clip is nothing.
//
// The clips are generated, not recorded: `tools/generate-game-sounds.py` renders
// every one of them from an oscillator, and `docs/sound-design.md` says why that
// is the only option that fits this repo's licence. Editing a WAV here by hand
// would be undone by the next run of the tool — change the voice in the tool.
//
// Every path below is spelled out rather than built from the pack id. Metro
// resolves `require` at build time by reading the literal, so an interpolated
// path bundles nothing and the pack plays silence on a device while working
// perfectly on web.

export interface SoundPack {
  id: string;
  name: string;
  blurb: string;
  sources: Record<GameSound, AudioSource | null>;
}

const SILENCE: Record<GameSound, AudioSource | null> = {
  end: null,
  illegal: null,
  moveOpponent: null,
  moveSelf: null,
  notify: null,
  paperTakesRock: null,
  rockTakesScissors: null,
  scissorsTakesPaper: null,
  start: null,
};

export const SOUND_PACKS: readonly SoundPack[] = [
  {
    id: 'wood',
    name: 'Wood',
    blurb: "Soft wooden taps.",
    sources: {
      end: require('../../assets/sounds/wood/end.wav'),
      illegal: require('../../assets/sounds/wood/illegal.wav'),
      moveOpponent: require('../../assets/sounds/wood/move-opponent.wav'),
      moveSelf: require('../../assets/sounds/wood/move-self.wav'),
      notify: require('../../assets/sounds/wood/notify.wav'),
      paperTakesRock: require('../../assets/sounds/wood/paper-takes-rock.wav'),
      rockTakesScissors: require('../../assets/sounds/wood/rock-takes-scissors.wav'),
      scissorsTakesPaper: require('../../assets/sounds/wood/scissors-takes-paper.wav'),
      start: require('../../assets/sounds/wood/start.wav'),
    },
  },
  {
    id: 'felt',
    name: 'Felt',
    blurb: "Quiet, muted taps.",
    sources: {
      end: require('../../assets/sounds/felt/end.wav'),
      illegal: require('../../assets/sounds/felt/illegal.wav'),
      moveOpponent: require('../../assets/sounds/felt/move-opponent.wav'),
      moveSelf: require('../../assets/sounds/felt/move-self.wav'),
      notify: require('../../assets/sounds/felt/notify.wav'),
      paperTakesRock: require('../../assets/sounds/felt/paper-takes-rock.wav'),
      rockTakesScissors: require('../../assets/sounds/felt/rock-takes-scissors.wav'),
      scissorsTakesPaper: require('../../assets/sounds/felt/scissors-takes-paper.wav'),
      start: require('../../assets/sounds/felt/start.wav'),
    },
  },
  {
    id: 'arcade',
    name: 'Arcade',
    blurb: "Retro arcade blips.",
    sources: {
      end: require('../../assets/sounds/arcade/end.wav'),
      illegal: require('../../assets/sounds/arcade/illegal.wav'),
      moveOpponent: require('../../assets/sounds/arcade/move-opponent.wav'),
      moveSelf: require('../../assets/sounds/arcade/move-self.wav'),
      notify: require('../../assets/sounds/arcade/notify.wav'),
      paperTakesRock: require('../../assets/sounds/arcade/paper-takes-rock.wav'),
      rockTakesScissors: require('../../assets/sounds/arcade/rock-takes-scissors.wav'),
      scissorsTakesPaper: require('../../assets/sounds/arcade/scissors-takes-paper.wav'),
      start: require('../../assets/sounds/arcade/start.wav'),
    },
  },
  {
    id: 'glass',
    name: 'Glass',
    blurb: "Clear glass chimes.",
    sources: {
      end: require('../../assets/sounds/glass/end.wav'),
      illegal: require('../../assets/sounds/glass/illegal.wav'),
      moveOpponent: require('../../assets/sounds/glass/move-opponent.wav'),
      moveSelf: require('../../assets/sounds/glass/move-self.wav'),
      notify: require('../../assets/sounds/glass/notify.wav'),
      paperTakesRock: require('../../assets/sounds/glass/paper-takes-rock.wav'),
      rockTakesScissors: require('../../assets/sounds/glass/rock-takes-scissors.wav'),
      scissorsTakesPaper: require('../../assets/sounds/glass/scissors-takes-paper.wav'),
      start: require('../../assets/sounds/glass/start.wav'),
    },
  },
  {
    id: 'silent',
    name: 'Silent',
    blurb: "No game sounds.",
    sources: SILENCE,
  },
];

export const DEFAULT_SOUND_PACK_ID = 'wood';

/**
 * The pack with this id, or the default.
 *
 * An id from a later build is unknown here — and so is `classic`, the single
 * pack every account chose before there was a choice. Both land on Wood, which
 * is what the fallback is for: a player who never picked anything gets the new
 * default rather than silence.
 */
export const soundPackById = (id: string | null | undefined): SoundPack =>
  SOUND_PACKS.find((pack) => pack.id === id) ?? SOUND_PACKS[0]!;
