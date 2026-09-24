import { useAudioPlayer } from 'expo-audio';
import { useEffect, useRef, useState } from 'react';

import { soundPackById } from '@/appearance/soundPacks';
import { useAppearanceStore } from '@/appearance/store';

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
    try {
      player.seekTo(0);
      player.play();
    } catch {
      // A platform that refuses playback must not take the settings page with
      // it. Choosing the pack has already worked; this was only the echo.
    }
  }, [player, token]);

  return null;
}

/** Bump `token` to hear the pack that is currently chosen. */
export default function SoundSampler({ token }: { token: number }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <Sampler token={token} /> : null;
}
