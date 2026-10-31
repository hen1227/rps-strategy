import { Platform, Share } from 'react-native';

import { useSettled } from '@/hooks/useSettled';

// Handing a link to the system's share sheet.
//
// A phone always has one. A browser has one when it has `navigator.share`, which
// is every phone browser and some desktop ones; where it has none, copying the
// address is the whole of sharing it, and a SHARE button that could only fail
// is left off rather than shown.

/**
 * Whether this device can share a link, asked after the first render: the
 * pre-rendered page knows nothing about the browser it will land in, so the
 * first client render answers the way the build did — no.
 */
export const useCanShareLinks = (): boolean => {
  const settled = useSettled();
  if (!settled) return false;
  if (Platform.OS !== 'web') return true;
  return typeof globalThis.navigator?.share === 'function';
};

/**
 * Open the share sheet for a link. Resolves true when it went somewhere, and
 * false when it was dismissed or the device refused — neither of which is
 * worth an error, because the person pressing it saw what happened.
 *
 * Call it straight from a press: a browser only opens its sheet while the
 * gesture that asked for it is still live.
 */
export const shareLink = async (url: string, title: string): Promise<boolean> => {
  try {
    if (Platform.OS === 'web') {
      await globalThis.navigator.share({ title, url });
      return true;
    }
    // iOS takes the address as a URL, which is what gives Messages its card
    // for the page. Android has only the message.
    const result = await Share.share(
      Platform.OS === 'ios' ? { url } : { message: url, title },
      { dialogTitle: title, subject: title },
    );
    return result.action === Share.sharedAction;
  } catch {
    return false;
  }
};
