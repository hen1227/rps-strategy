import OfficialTournamentScreen from '@/features/tournaments/OfficialTournamentScreen';
import PageTitle from '@/navigation/PageTitle';
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
  return (
    <>
      {/*
        Named for the event rather than for the section, because this is the
        title on a link somebody pastes into the Discord.
      */}
      <PageTitle title="The official Intransitive tournament" />
      <OfficialTournamentScreen />
    </>
  );
}
