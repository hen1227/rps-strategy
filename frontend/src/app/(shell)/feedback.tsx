import FeedbackScreen from '@/features/feedback/FeedbackScreen';
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
  // Which of the page's three states to open in: the list, one thread, or the
  // form. All three arrive one render late on a pre-rendered page — see
  // `useSettledSearchParams` — which is why the board is what renders first and
  // a linked thread paints immediately after, rather than the page being blank
  // until the query string turns up.
  const { params } = useSettledSearchParams<{
    item?: string;
    compose?: string;
    gameId?: string;
  }>();
  return (
    <>
      <PageTitle title="Feedback" />
      <FeedbackScreen compose={params.compose} gameId={params.gameId} item={params.item} />
    </>
  );
}
