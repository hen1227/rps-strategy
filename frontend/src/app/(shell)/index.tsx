import PlayOnlineScreen from '@/features/play/PlayOnlineScreen';
import PageTitle from '@/navigation/PageTitle';

export default function Page() {
  return (
    <>
      {/* The front page is the site, so it carries the bare name. */}
      <PageTitle />
      <PlayOnlineScreen />
    </>
  );
}
