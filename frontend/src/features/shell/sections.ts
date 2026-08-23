import { links } from '@/navigation/links';
import type { Account } from '@/types/protocol';
import type { Href } from 'expo-router';

// The navigation, in one place.
//
// Three surfaces render this list — the desktop sidebar, the phone's tab bar,
// and the More sheet behind it — so a new section is one entry here rather than
// three edits that have to agree. `links.ts` still owns the addresses; this owns
// what they are called and in which order they appear.

export type SectionId =
  | 'play'
  | 'bots'
  | 'openings'
  | 'tournaments'
  | 'leaderboard'
  | 'account'
  | 'admin';

export interface Section {
  id: SectionId;
  /** The sidebar and More label. */
  label: string;
  /** The shorter tab-bar label, when the full one will not fit. */
  shortLabel?: string;
  /** One line of explanation, for the More list. */
  detail: string;
  href: Href;
  /** The path this section owns, for deciding which entry is current. */
  path: string;
  /**
   * A phone shows four sections plus More. These four are the ones worth a
   * permanent tab; the rest live behind it.
   */
  primary?: boolean;
  /** Sections not everyone may see. */
  visible?: (account: Account | null) => boolean;
}

export const SECTIONS: readonly Section[] = [
  {
    id: 'play',
    label: 'Play Online',
    shortLabel: 'Play',
    detail: 'Ranked matches, challenges, and custom games.',
    href: links.lobby(),
    path: '/',
    primary: true,
  },
  {
    id: 'bots',
    label: 'Bots',
    detail: 'Play one, watch two fight, or challenge an engine somebody connected.',
    href: links.bots(),
    path: '/bots',
    primary: true,
  },
  {
    id: 'tournaments',
    label: 'Tournaments',
    shortLabel: 'Events',
    detail: 'Signups, live rounds, and every past event.',
    href: links.tournaments(),
    path: '/tournaments',
    primary: true,
  },
  {
    id: 'account',
    label: 'Account',
    detail: 'Your name, your ratings, and your record.',
    href: links.account(),
    path: '/account',
    primary: true,
  },
  {
    id: 'leaderboard',
    label: 'Leaderboard',
    detail: 'The best players and the best bots.',
    href: links.leaderboard(),
    path: '/leaderboard',
  },
  {
    id: 'openings',
    label: 'Openings',
    detail: 'Browse the opening book and name what has no name.',
    href: links.openings(),
    path: '/openings',
  },
  {
    id: 'admin',
    label: 'Admin',
    detail: 'Accounts, tournaments, bot series, and the opening book.',
    href: links.admin(),
    path: '/admin',
    // Gated on the account flag rather than on holding the host token, so an
    // administrator sees their tools without pasting a secret first. The server
    // accepts their session on the same routes.
    visible: (account) => Boolean(account?.isAdmin),
  },
];

export const visibleSections = (account: Account | null): Section[] =>
  SECTIONS.filter((section) => section.visible?.(account) ?? true);

/**
 * Which section a path belongs to.
 *
 * Longest match wins, so `/bots` claims itself while `/` does not claim
 * everything. A path inside the shell with no section of its own — the privacy
 * page — highlights nothing, which is correct: it is not a section.
 */
export const sectionForPath = (pathname: string): Section | null => {
  if (pathname === '/') return SECTIONS.find((section) => section.path === '/') ?? null;
  return (
    SECTIONS.filter((section) => section.path !== '/' && pathname.startsWith(section.path)).sort(
      (first, second) => second.path.length - first.path.length,
    )[0] ?? null
  );
};
