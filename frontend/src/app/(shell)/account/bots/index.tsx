import MyBotsScreen from '@/features/bots/MyBotsScreen';
import PageTitle from '@/navigation/PageTitle';

export default function Page() {
  return (
    <>
      <PageTitle title="Your bots" />
      <MyBotsScreen />
    </>
  );
}
