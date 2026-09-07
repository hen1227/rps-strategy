import { Redirect } from 'expo-router';

import { links } from '@/navigation/links';

/**
 * Where the nightly used to be.
 *
 * The event became weekly and the page moved with it. This stays because the
 * old address is in Discord posts, in bookmarks and in the announcement banner
 * of every night that ever ran, and a dead link is a worse answer than a
 * redirect to the thing it became.
 */
export default function Page() {
  return <Redirect href={links.weekend()} />;
}
