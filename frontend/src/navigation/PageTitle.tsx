import Head from 'expo-router/head';

const SITE_NAME = 'RPS Strategy';

/**
 * The title a page puts in the browser tab, and in a shared link.
 *
 * The navigator's own `title` option is for a native header bar; it does not
 * reach the document. This does, and it is rendered into the pre-built HTML as
 * well as applied on navigation — so a tab, a bookmark and a link preview all
 * say which page they lead to.
 *
 * Every page needs one. A page that sets no title renders an empty `<title>`,
 * which overrides the fallback in `+html.tsx` rather than falling back to it.
 */
export default function PageTitle({ title }: { title?: string }) {
  return (
    <Head>
      <title>{title ? `${title} · ${SITE_NAME}` : SITE_NAME}</title>
    </Head>
  );
}
