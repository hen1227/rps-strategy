import { useRouter } from 'expo-router';

import LeaderboardScreen from '@/features/leaderboard/LeaderboardScreen';
import { links } from '@/navigation/links';
import PageTitle from '@/navigation/PageTitle';
import { useSettledSearchParams } from '@/navigation/useSettledSearchParams';
import type { ModeID } from '@/types/game';
import { useAppearanceGeneration } from '@/appearance/store';

// The ladder, addressed as `/leaderboard?mode=total-war`.
//
// A query parameter rather than a path segment, for the reason at the top of
// `links.ts`: every page of this site exports as one static HTML file, and a
// dynamic segment would have to be pre-generated for every mode that will ever
// exist. `useSettledSearchParams` is what handles the consequence — the first
// client render of a pre-rendered page has no query string yet.
export default function Page() {
  // Re-render this page when the look changes.
  //
  // A route file is the seam because every one of them is behind its own
  // `StaticContainer` — expo-router renders each route through a `React.memo`
  // whose comparator skips `children`, so a re-render above never reaches in.
  // Subscribing here does, and because the page's element is created inline
  // below rather than handed in as a prop, the whole subtree follows.
  useAppearanceGeneration();
  const { params, settled } = useSettledSearchParams<{ mode?: ModeID }>();
  const router = useRouter();
  return (
    <>
      <PageTitle title="Leaderboard" />
      <LeaderboardScreen
        mode={params.mode}
        // `replace`, so three tab presses do not leave three entries in the back
        // stack between the reader and the page they arrived from.
        onChooseMode={(mode) => router.replace(links.leaderboard(mode))}
        settled={settled}
      />
    </>
  );
}
