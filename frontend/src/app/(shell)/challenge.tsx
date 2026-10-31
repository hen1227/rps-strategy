import ChallengeLinkScreen from '@/features/play/ChallengeLinkScreen';
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
  // The code arrives one render late on a pre-rendered page — see
  // `useSettledSearchParams` — and until it has, the screen says it is opening
  // rather than that there is no code.
  const { params, settled } = useSettledSearchParams<{ code?: string }>();
  const code = (Array.isArray(params.code) ? params.code[0] : params.code) ?? '';
  return (
    <>
      <PageTitle title="Challenge" />
      <ChallengeLinkScreen code={code.trim()} settled={settled} />
    </>
  );
}
