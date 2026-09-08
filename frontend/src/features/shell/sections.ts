import {links} from '@/navigation/links';
import type {Account} from '@/types/protocol';
import type {Href} from 'expo-router';

// The navigation, in one place.
//
// Three surfaces render this list — the desktop sidebar, the phone's tab bar,
// and the strip beneath it — so a new page is one entry here rather than three
// edits that have to agree. `links.ts` still owns the addresses; this owns what
// they are called, which group they belong to, and in which order they appear.
//
// The list is two levels rather than one. A flat list of ten made the tab bar
// slice it by guessed frequency, which is why the phone had four tabs and a
// menu holding the rest while the desktop showed all ten: the two surfaces
// disagreed about what this site contains. Grouping is what lets them agree —
// five groups fit across a phone, and the desktop shows the same five with
// their children underneath.

export type GroupId = 'play' | 'bots' | 'study' | 'compete' | 'you';

export type SectionId =
    | 'play'
    | 'bots'
    | 'my-bots'
    | 'bot-guide'
    | 'bot-protocol'
    | 'bot-notation'
    | 'analysis'
    | 'openings'
    | 'explorer'
    | 'leaderboard'
    | 'tournaments'
    | 'weekend'
    | 'tournament-info'
    | 'player'
    | 'account'
    | 'credits'
    | 'policy'
    | 'admin';

export interface Section {
    id: SectionId;
    /** The group this page is filed under, and whose tab lights up on it. */
    group: GroupId;
    /** The sidebar and strip label. */
    label: string;
    href: Href;
    /** The path this section owns, for deciding which entry is current. */
    path: string;
    /**
     * A page that is not listed, but still claims its path.
     *
     * A player's profile has no entry of its own — nobody navigates to "a
     * player" — but standing on one should still light the group its ladder is
     * in, rather than lighting nothing.
     */
    hidden?: boolean;
    /**
     * A page outside the shell, which therefore has no navigation on it.
     *
     * The board pages are full-bleed by design: `/analysis`, `/review` and
     * `/play` are not in the `(shell)` route group, so they render without a
     * sidebar and without a tab bar. Listing one is still worth doing — it is
     * how somebody finds the analysis board at all — but a group may not *land*
     * on one, because a tab that navigates away from the tab bar is a one-way
     * door. See `groupHref`.
     */
    external?: boolean;
    /** Sections not everyone may see. */
    visible?: (account: Account | null) => boolean;
}

export interface Group {
    id: GroupId;
    /** The tab-bar label and the sidebar's group heading. */
    label: string;
    /** What this group is, for the phone's header and for screen readers. */
    hint: string;
}

/**
 * The five groups, in bar order.
 *
 * Five because that is how many the sections divide into once you stop asking
 * how often each is opened and start asking what each one is: a way into a
 * game, a bot, something to study, something to place in, or you. It is also
 * the platform's own ceiling before it grows a More of its own, so this fits
 * across a phone without a drawer.
 */
export const GROUPS: readonly Group[] = [
    {id: 'play', label: 'Play', hint: 'Play against people'},
    {id: 'bots', label: 'Bots', hint: 'Play, watch and connect engines'},
    {id: 'study', label: 'Study', hint: 'Analysis, openings and the explorer'},
    {id: 'compete', label: 'Compete', hint: 'Ladders, tournaments and events'},
    {id: 'you', label: 'You', hint: 'Your account and this site'},
];

export const SECTIONS: readonly Section[] = [
    {
        id: 'play',
        group: 'play',
        label: 'Play Online',
        href: links.lobby(),
        path: '/',
    },

    {
        id: 'bots',
        group: 'bots',
        label: 'Play a Bot',
        href: links.bots(),
        path: '/bots',
    },
    {
        id: 'my-bots',
        group: 'bots',
        label: 'Your Bots',
        href: links.myBots(),
        path: '/account/bots',
        // Filed under Bots while the address stays under `/account`, which
        // `sectionForPath` allows because it matches longest-prefix first:
        // `/account/bots` beats `/account`. The URL keeps the reasoning
        // `links.myBots` gives — a bot belongs to an account — and the
        // navigation puts it where people look for it.
    },
    {
        id: 'bot-guide',
        group: 'bots',
        label: 'Connect',
        href: links.botGuide(),
        path: '/account/bots/connect',
    },
    {
        id: 'bot-protocol',
        group: 'bots',
        label: 'Protocol',
        href: links.botProtocol(),
        path: '/account/bots/protocol',
    },
    {
        id: 'bot-notation',
        group: 'bots',
        label: 'Notation',
        href: links.botNotation(),
        path: '/account/bots/notation',
    },

    {
        id: 'openings',
        group: 'study',
        label: 'Openings',
        href: links.openings(),
        path: '/openings',
    },
    {
        id: 'explorer',
        group: 'study',
        label: 'Explorer',
        href: links.explorer(),
        path: '/explorer',
    },
    {
        id: 'analysis',
        group: 'study',
        label: 'Analysis Board',
        href: links.analysis(),
        path: '/analysis',
        // Outside the shell. Listed last for that reason: the strip reads left
        // to right and this is the entry that ends the strip, because pressing
        // it is the one that takes the strip away with it.
        external: true,
    },

    {
        id: 'leaderboard',
        group: 'compete',
        label: 'Leaderboard',
        href: links.leaderboard(),
        path: '/leaderboard',
    },
    {
        id: 'tournaments',
        group: 'compete',
        label: 'Tournaments',
        href: links.tournaments(),
        path: '/tournaments',
    },
    {
        id: 'weekend',
        group: 'compete',
        label: 'Weekend Arena',
        href: links.weekend(),
        path: '/weekend',
    },
    {
        id: 'tournament-info',
        group: 'compete',
        label: 'Official Event',
        href: links.tournamentInfo(),
        path: '/tournament-info',
    },
    {
        id: 'player',
        group: 'compete',
        label: 'Player',
        href: links.player(''),
        path: '/player',
        hidden: true,
    },

    {
        id: 'account',
        group: 'you',
        label: 'Account',
        href: links.account(),
        path: '/account',
    },
    {
        id: 'credits',
        group: 'you',
        label: 'Credits',
        href: links.credits(),
        path: '/credits',
        // In the list rather than only in the sidebar's foot. The foot is a
        // desktop shape; on a phone this page used to be reachable only through
        // the More menu, so removing that menu without giving credits a home
        // would have stranded it.
    },
    {
        id: 'policy',
        group: 'you',
        label: 'Privacy',
        href: links.policy(),
        path: '/policy',
    },
    {
        id: 'admin',
        group: 'you',
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

/** The pages of one group that are worth listing, in order. */
export const sectionsInGroup = (group: GroupId, account: Account | null): Section[] =>
    visibleSections(account).filter((section) => section.group === group && !section.hidden);

/**
 * Where a group's own tab goes: its first listed page that is inside the shell.
 *
 * Derived rather than declared, so a group cannot land somewhere it does not
 * contain. The shell test is the important half — see `Section.external`. Study
 * lists the analysis board, but landing the Study tab on it would drop somebody
 * onto a full-bleed page with no tab bar to press again.
 */
export const groupHref = (group: GroupId, account: Account | null): Href | null =>
    sectionsInGroup(group, account).find((section) => !section.external)?.href ?? null;

/** The groups with at least one page somebody may see, in bar order. */
export const visibleGroups = (account: Account | null): Group[] =>
    GROUPS.filter((group) => groupHref(group.id, account) !== null);

/**
 * Which section a path belongs to.
 *
 * Longest match wins, so `/bots` claims itself while `/` does not claim
 * everything, and `/account/bots` claims itself rather than falling to
 * `/account`. A path inside the shell with no section of its own highlights
 * nothing, which is correct: it is not a section.
 */
export const sectionForPath = (pathname: string): Section | null => {
    if (pathname === '/') return SECTIONS.find((section) => section.path === '/') ?? null;
    return (
        SECTIONS.filter((section) => section.path !== '/' && pathname.startsWith(section.path)).sort(
            (first, second) => second.path.length - first.path.length,
        )[0] ?? null
    );
};

/** Which group a path belongs to, which is the tab that lights up. */
export const groupForPath = (pathname: string): GroupId | null =>
    sectionForPath(pathname)?.group ?? null;
