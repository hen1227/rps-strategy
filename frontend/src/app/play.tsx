import GameScreen from '@/features/game/GameScreen';
import PageTitle from '@/navigation/PageTitle';

export default function Page() {
  return (
    <>
      <PageTitle title="Game" />
      <GameScreen />
    </>
  );
}
