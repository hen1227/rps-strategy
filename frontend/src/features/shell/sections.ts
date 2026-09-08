import {links} from '@/navigation/links';
import type {Account} from '@/types/protocol';
import type {Href} from 'expo-router';

// The navigation, in one place.
//
// Three surfaces render this list — the desktop sidebar, the phone's tab bar,
// and the More menu above it — so a new section is one entry here rather than
// three edits that have to agree. `links.ts` still owns the addresses; this owns
// what they are called and in which order they appear.

export type SectionId =
    | 'play'
    | 'bots'
    | 'my-bots'

    | 'openings'
    | 'explorer'
    | 'tournaments'
    | 'weekend'
    | 'leaderboard'
    | 'account'
    | 'admin';

export interface Section {
    id: SectionId;
    /** The sidebar and More label. */
    label: string;
    /** The shorter tab-bar label, when the full one will not fit. */
    shortLabel?: string;
    href: Href;
    /** The path this section owns, for deciding which entry is current. */
    path: string;
    /**
     * A phone shows four sections plus More. These four are the ones worth a
     * permanent tab; the rest are listed in the menu behind it.
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
        href: links.lobby(),
        path: '/',
        primary: true,
    },
    {
        id: 'bots',
        label: 'Bots',
        href: links.bots(),
        path: '/bots',
        primary: true,
    },
    {
        id: 'tournaments',
        label: 'Tournaments',
        shortLabel: 'Events',
        href: links.tournaments(),
        path: '/tournaments',
        primary: true,
    },
    {
        id: 'weekend',
        label: 'Weekend Bot Tourney',
        href: links.weekend(),
        path: '/weekend',
        primary: true,
    },
    {
        id: 'account',
        label: 'Account',
        href: links.account(),
        path: '/account',
        primary: true,
    },
    {
        id: 'my-bots',
        label: 'My Bots',
        href: links.myBots(),
        path: '/account/bots',
        visible: (account) => Boolean(account?.discordVerified)
    },
    {
        id: 'leaderboard',
        label: 'Leaderboard',
        href: links.leaderboard(),
        path: '/leaderboard',
    },
    {
        id: 'openings',
        label: 'Openings',
        href: links.openings(),
        path: '/openings',
    },
    {
        id: 'explorer',
        label: 'Explorer',
        href: links.explorer(),
        path: '/explorer',
    },
    {
        id: 'admin',
        label: 'Admin',
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
