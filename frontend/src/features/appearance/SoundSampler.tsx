import { useAudioPlayer } from 'expo-audio';
import { useEffect, useRef, useState } from 'react';

import { soundPackById } from '@/appearance/soundPacks';
import { useAppearanceStore } from '@/appearance/store';
import { replayClip } from '@/hooks/useGameSounds';

// Plays a pack's move clip when it is chosen, so picking one answers with the
// thing it changes rather than with a word.
//
// Mounted only after the first client render, like `GameSoundEffects`:
// `useAudioPlayer` has no server implementation, and every page of this site is
// pre-rendered in Node at build time. Calling it during that pass throws inside
// a Suspense boundary, which React answers by discarding the whole pre-rendered
// page — so the page ships as an empty shell.

function Sampler({ token }: { token: number }) {
  const packId = useAppearanceStore((state) => state.appearance.sound);
  const player = useAudioPlayer(soundPackById(packId).sources.moveSelf);
  const lastPlayed = useRef(token);

  useEffect(() => {
    if (token === lastPlayed.current) return;
    lastPlayed.current = token;
    // The game's own way of starting a clip, which also keeps a refused sound
    // from taking the settings page with it: choosing the pack has already
    // worked, and this is only the echo.
    replayClip(player);
  }, [player, token]);

  return null;
}

/** Bump `token` to hear the pack that is currently chosen. */
export default function SoundSampler({ token }: { token: number }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <Sampler token={token} /> : null;
}
