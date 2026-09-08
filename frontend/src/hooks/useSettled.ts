import { useEffect, useState } from 'react';

/**
 * False on the first render, true from the second on.
 *
 * Every page of this site is pre-rendered in Node at build time, where there is
 * no window, no query string and no local storage. Anything read from those on
 * the *first* client render would therefore disagree with the pre-rendered HTML,
 * and React answers a disagreement by throwing the whole pre-rendered page away
 * as a hydration mismatch. So the first client render deliberately reports what
 * the build reported — nothing — and the real value arrives one render later.
 *
 * This gates a *value*, never a hook: a render that calls fewer hooks than the
 * one before it is a different failure, and a louder one.
 */
export const useSettled = (): boolean => {
  const [settled, setSettled] = useState(false);
  useEffect(() => setSettled(true), []);
  return settled;
};
