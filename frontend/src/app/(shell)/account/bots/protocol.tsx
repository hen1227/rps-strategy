import BotDocScreen from '@/features/bots/BotDocScreen';
import PageTitle from '@/navigation/PageTitle';

export default function Page() {
  return (
    <>
      <PageTitle title="Engine protocol" />
      <BotDocScreen doc="protocol" />
    </>
  );
}
