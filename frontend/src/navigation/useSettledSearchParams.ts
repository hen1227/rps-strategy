import { useLocalSearchParams, type UnknownOutputParams } from 'expo-router';
import { useEffect, useState } from 'react';

/**
 * The URL's query string, but not until the browser has one.
 *
 * Every page here is pre-rendered in Node at build time, and a static HTML file
 * cannot know the query string it will be served with. A page that rendered its
 * parameters on the first client render would therefore disagree with its own
 * pre-rendered HTML, and React answers that by discarding the pre-rendered page
 * as a hydration mismatch.
 *
 * So the first client render deliberately reports nothing, exactly as the build
 * did, and the real parameters arrive one render later. `settled` says which of
 * those two renders you are in, so a page can show a placeholder rather than
 * the wrong thing.
 */
export const useSettledSearchParams = <Params extends UnknownOutputParams>(): {
  params: Partial<Params>;
  settled: boolean;
} => {
  const params = useLocalSearchParams<Params>();
  const [settled, setSettled] = useState(false);
  useEffect(() => setSettled(true), []);
  return { params: settled ? params : {}, settled };
};
