import AdminScreen from '@/features/admin/AdminScreen';
import PageTitle from '@/navigation/PageTitle';
import { useSettledSearchParams } from '@/navigation/useSettledSearchParams';
import { useAppearanceGeneration } from '@/appearance/store';

export default function Page() {
  // Re-render this page when the look changes.
  //
  // A route file is the seam because every one of them is behind its own
  // `StaticContainer` — expo-router renders each route through a `React.memo`
  // whose comparator skips `children`, so a re-render above never reaches in.
  // Subscribing here does, and because the page's element is created inline
  // below rather than handed in as a prop, the whole subtree follows.
  useAppearanceGeneration();
  // The tab travels in the query string so it can be bookmarked and linked. It
  // arrives one render late on a pre-rendered page — see
  // `useSettledSearchParams` — which is harmless here: the screen falls back to
  // the overview, and the real tab paints immediately after.
  const { params } = useSettledSearchParams<{ tab?: string }>();
  return (
    <>
      <PageTitle title="Admin" />
      <AdminScreen tab={params.tab} />
    </>
  );
}
