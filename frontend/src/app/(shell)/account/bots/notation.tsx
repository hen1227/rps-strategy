import BotDocScreen from '@/features/bots/BotDocScreen';
import PageTitle from '@/navigation/PageTitle';

export default function Page() {
  return (
    <>
      <PageTitle title="Records and notation" />
      <BotDocScreen doc="notation" />
    </>
  );
}
