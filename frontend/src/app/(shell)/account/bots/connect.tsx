import BotDocScreen from '@/features/bots/BotDocScreen';
import PageTitle from '@/navigation/PageTitle';

export default function Page() {
  return (
    <>
      <PageTitle title="Connect your bot" />
      <BotDocScreen doc="guide" />
    </>
  );
}
