import { Redirect } from 'expo-router';

import { links } from '@/navigation/links';
import { useAppearanceGeneration } from '@/appearance/store';

/**
 * Where the nightly used to be.
 *
 * The event became weekly and the page moved with it. This stays because the
 * old address is in Discord posts, in bookmarks and in the announcement banner
 * of every night that ever ran, and a dead link is a worse answer than a
 * redirect to the thing it became.
 */
export default function Page() {
  // Re-render this page when the look changes.
  //
  // A route file is the seam because every one of them is behind its own
  // `StaticContainer` — expo-router renders each route through a `React.memo`
  // whose comparator skips `children`, so a re-render above never reaches in.
  // Subscribing here does, and because the page's element is created inline
  // below rather than handed in as a prop, the whole subtree follows.
  useAppearanceGeneration();
  return <Redirect href={links.weekend()} />;
}
