import DiscordCallbackScreen from '@/features/account/DiscordCallbackScreen';
import PageTitle from '@/navigation/PageTitle';

export default function Page() {
  return (
    <>
      <PageTitle title="Signing in" />
      <DiscordCallbackScreen />
    </>
  );
}
