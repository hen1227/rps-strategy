import Head from 'expo-router/head';

const SITE_NAME = 'RPS Strategy';

/**
 * The title a page puts in the browser tab, and in a shared link.
 *
 * The navigator's own `title` option is for a native header bar; it does not
 * reach the document, because Expo Router turns React Navigation's
 * `documentTitle` off. This does reach it: `expo export` renders the tag into
 * the pre-built HTML, and the same tag is re-applied on navigation — so a tab,
 * a bookmark and a link preview all say which page they lead to.
 *
 * This is the only `<title>` the document gets. The pre-render injects this tag
 * ahead of everything `+html.tsx` writes, so there is no shell-level title left
 * to fall back to, and a page that renders no `PageTitle` ships an empty
 * browser tab. Every page needs one.
 */
export default function PageTitle({ title }: { title?: string }) {
  return (
    <Head>
      <title>{title ? `${title} · ${SITE_NAME}` : SITE_NAME}</title>
    </Head>
  );
}
