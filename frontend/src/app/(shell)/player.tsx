import ProfileScreen from '@/features/profile/ProfileScreen';
import { playerHandle } from '@/navigation/links';
import PageTitle from '@/navigation/PageTitle';
import { useSettledSearchParams } from '@/navigation/useSettledSearchParams';
import { useAppearanceGeneration } from '@/appearance/store';

// One player's page, addressed as `/player?user=yuki` — or `?bot=RPSFish`,
// which is the same address by another name. `playerHandle` owns that, beside
// the builder that writes the spelling this site shares.
//
// A query parameter rather than `/player/[user]`, for the reason at the top of
// `links.ts`: every page of this site exports as one static HTML file, and a
// dynamic segment would have to be pre-generated for every name that will ever
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
  const { params, settled } = useSettledSearchParams<{
    user?: string;
    bot?: string;
  }>();
  const handle = playerHandle(params);
  return (
    <>
      {/*
        The name in the tab title, once there is one. Before that it is the
        generic word rather than an empty string, which would read as a page
        with no title at all.
      */}
      <PageTitle title={handle ? `${handle} · Player` : 'Player'} />
      <ProfileScreen handle={handle} settled={settled} />
    </>
  );
}
