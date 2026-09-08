import OfficialTournamentScreen from '@/features/tournaments/OfficialTournamentScreen';
import PageTitle from '@/navigation/PageTitle';

export default function Page() {
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
