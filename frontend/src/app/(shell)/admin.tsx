import AdminScreen from '@/features/admin/AdminScreen';
import PageTitle from '@/navigation/PageTitle';
import { useSettledSearchParams } from '@/navigation/useSettledSearchParams';

export default function Page() {
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
