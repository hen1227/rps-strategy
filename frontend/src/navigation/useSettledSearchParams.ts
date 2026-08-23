import { useLocalSearchParams, type UnknownOutputParams } from 'expo-router';

import { useSettled } from '@/hooks/useSettled';

/**
 * The URL's query string, but not until the browser has one.
 *
 * A static HTML file cannot know the query string it will be served with, so
 * the first client render reports nothing, exactly as the build did, and the
 * real parameters arrive one render later — see `useSettled`. `settled` says
 * which of those two renders you are in, so a page can show a placeholder
 * rather than the wrong thing.
 */
export const useSettledSearchParams = <Params extends UnknownOutputParams>(): {
  params: Partial<Params>;
  settled: boolean;
} => {
  const params = useLocalSearchParams<Params>();
  const settled = useSettled();
  return { params: settled ? params : {}, settled };
};
