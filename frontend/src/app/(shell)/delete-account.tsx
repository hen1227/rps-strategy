import DeleteAccountInfoScreen from '@/features/policy/DeleteAccountInfoScreen';
import PageTitle from '@/navigation/PageTitle';
import { useAppearanceGeneration } from '@/appearance/store';

export default function Page() {
  // Re-render this page when the look changes. See `policy.tsx` for why the
  // route file is where that has to be subscribed.
  useAppearanceGeneration();
  return (
    <>
      <PageTitle title="Delete your account" />
      <DeleteAccountInfoScreen />
    </>
  );
}
