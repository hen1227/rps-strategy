import LeaderboardScreen from '@/features/leaderboard/LeaderboardScreen';
import PageTitle from '@/navigation/PageTitle';

export default function Page() {
  return (
    <>
      <PageTitle title="Leaderboard" />
      <LeaderboardScreen />
    </>
  );
}
