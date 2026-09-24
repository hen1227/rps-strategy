import PageTitle from '@/navigation/PageTitle';
import RoundsScreen from '@/features/rounds/RoundsScreen';
import { useAppearanceGeneration } from '@/appearance/store';

export default function Page() {
  // Re-render this page when the look changes. See the note on any other route
  // file: each route sits behind its own `StaticContainer`, so a re-render above
  // never reaches in and the subscription has to be here.
  useAppearanceGeneration();
  return (
    <>
      <PageTitle title="Hourly Rounds" />
      <RoundsScreen />
    </>
  );
}
