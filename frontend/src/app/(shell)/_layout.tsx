import ShellLayout from '@/features/shell/ShellLayout';
import { useAppearanceGeneration } from '@/appearance/store';

// A route group, so none of these pages gained a path segment: `/`, `/bots`,
// `/tournaments`, `/openings`, `/leaderboard`, `/account`, and `/admin` are
// exactly the addresses they were before the shell existed.
export default function Layout() {
  // Re-render the shell itself when the look changes.
  //
  // This is a route like any other — a layout route is still a route, behind
  // its own `StaticContainer` — so the page inside `<Slot/>` subscribing does
  // not reach the frame around it. Without this line the sidebar, the tab bar,
  // the sub-nav and the live rail all keep the previous theme while the page
  // between them changes, which on a phone is the entire chrome.
  useAppearanceGeneration();
  return <ShellLayout />;
}
