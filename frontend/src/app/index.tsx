import LobbyScreen from '@/features/lobby/LobbyScreen';
import PageTitle from '@/navigation/PageTitle';

export default function Page() {
  return (
    <>
      {/* The front page is the site, so it carries the bare name. */}
      <PageTitle />
      <LobbyScreen />
    </>
  );
}
