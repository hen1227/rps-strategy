import ShellLayout from '@/features/shell/ShellLayout';

// A route group, so none of these pages gained a path segment: `/`, `/bots`,
// `/tournaments`, `/openings`, `/leaderboard`, `/account`, and `/admin` are
// exactly the addresses they were before the shell existed.
export default function Layout() {
  return <ShellLayout />;
}
