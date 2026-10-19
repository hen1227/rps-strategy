import { useGlobalSearchParams, usePathname, type Href } from 'expo-router';

import { pathOf } from './links';

/**
 * The page somebody is standing on, as a path with its parameters.
 *
 * For a button that sends them somewhere to come back from — "sign in", and
 * then this tournament's entry form again rather than the account page.
 */
export const useHere = (): string => {
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  return pathOf({ pathname, params } as Href);
};
