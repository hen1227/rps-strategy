// Challenge links, as this client holds them.
//
// One message carries every change to a link — `challenge_link` — and it goes
// to everybody the link concerns: its author, whoever took it, and anybody who
// opened it. What it means depends on which of those this client is, so the
// store keeps one answer per part it can play and this module decides, from
// each message, what each of them now is. Pure, like the other selector
// modules, so a hand-over between states can be tested without a socket.

import type { ChallengeLink, ChallengeLinkAuthorStatus } from '@/types/protocol';

export type ChallengeLinkRole = 'author' | 'taker' | 'viewer';

/** Which part this account plays in a link. */
export const challengeLinkRole = (
  link: ChallengeLink,
  accountId: string | null | undefined,
): ChallengeLinkRole => {
  if (accountId && link.challenger?.userId === accountId) return 'author';
  if (accountId && link.taker?.userId === accountId) return 'taker';
  return 'viewer';
};

/** The link a page's address names, as that page shows it. */
export interface ViewedLink {
  code: string;
  /** Null until the server has answered. */
  link: ChallengeLink | null;
  /** Why the last thing asked of it was refused, or why it closed. */
  message: string | null;
  /**
   * Asked to take it and not yet answered. What separates "joining…" from an
   * open link this account could press to take — one it left, or was refused.
   */
  asking: boolean;
}

export interface ChallengeLinkSlots {
  /** The link this account sent out, until it becomes a game or closes. */
  ownLink: ChallengeLink | null;
  /** The link this account took and is waiting on. */
  awaitedLink: ChallengeLink | null;
  viewedLink: ViewedLink | null;
  /**
   * A link of ours that just became the game on this screen, for the popup that
   * says who took it. Only on the tab that was seated: the author's other tabs
   * hear the same news, and a popup there would announce a game they are not
   * showing.
   */
  acceptedLink: ChallengeLink | null;
}

export const emptyChallengeLinkSlots: ChallengeLinkSlots = {
  ownLink: null,
  awaitedLink: null,
  viewedLink: null,
  acceptedLink: null,
};

const isOutstanding = (link: ChallengeLink) => link.state === 'open' || link.state === 'waiting';

/**
 * Where one `challenge_link` message leaves each slot, and the line it is worth
 * in the lobby, if any.
 *
 * A closed link names nothing but its code, so whether it was ours or the one
 * we were waiting on is read off what we were holding rather than off the
 * message.
 */
export const applyChallengeLink = (
  current: ChallengeLinkSlots,
  link: ChallengeLink,
  message: string | null,
  context: { accountId: string | null; ownGameId: string | null },
): { slots: ChallengeLinkSlots; notice: string | null } => {
  const role = challengeLinkRole(link, context.accountId);
  const wasOwn = current.ownLink?.code === link.code;
  const wasAwaited = current.awaitedLink?.code === link.code;

  const ownLink =
    role === 'author' && isOutstanding(link) ? link : wasOwn ? null : current.ownLink;
  const awaitedLink =
    role === 'taker' && link.state === 'waiting' ? link : wasAwaited ? null : current.awaitedLink;
  const acceptedLink =
    role === 'author' &&
    link.state === 'started' &&
    Boolean(link.gameId) &&
    link.gameId === context.ownGameId
      ? link
      : current.acceptedLink;
  const viewedLink =
    current.viewedLink?.code === link.code
      ? { code: link.code, link, message: message || null, asking: false }
      : current.viewedLink;

  // Worth saying in the lobby only when it ends something this account was
  // holding, and only when the server gave a reason: a link its own author
  // cancelled comes back with none, because saying so would only repeat the
  // press.
  const notice = link.state === 'closed' && (wasOwn || wasAwaited) && message ? message : null;
  return { slots: { ownLink, awaitedLink, viewedLink, acceptedLink }, notice };
};

/**
 * The slots as connection_ready leaves them: whatever the server says this
 * account is part of, and nothing it no longer is. The page's own link is kept,
 * because the page asks again once the socket is up.
 */
export const challengeLinksOnConnect = (
  current: ChallengeLinkSlots,
  links: ChallengeLink[] | undefined,
  accountId: string | null,
): { slots: ChallengeLinkSlots; lost: boolean } => {
  const held = links ?? [];
  const ownLink =
    held.find((link) => challengeLinkRole(link, accountId) === 'author' && isOutstanding(link)) ??
    null;
  const awaitedLink =
    held.find((link) => challengeLinkRole(link, accountId) === 'taker' && link.state === 'waiting') ??
    null;
  // A link that was out when this socket went away and is not now: expired,
  // or lost to a restart. Either way the author should not find it silently gone.
  const lost = Boolean(current.ownLink && !ownLink);
  return {
    slots: { ...current, ownLink, awaitedLink, acceptedLink: null },
    lost,
  };
};

/**
 * How long an open link has left, coarse on purpose: a link lasts an hour, and
 * a clock ticking seconds on a sidebar for an hour is something to watch
 * rather than something to know.
 */
export const linkExpiryLabel = (expiresAtUnixMs: number | undefined, nowMs: number): string => {
  if (!expiresAtUnixMs) return '';
  const remaining = expiresAtUnixMs - nowMs;
  if (remaining <= 0) return 'Expired';
  // Rounded rather than rounded up: the clock this is read against ticks twice
  // a minute, so it can be half a minute behind, and rounding up turned a
  // fresh hour-long link into "61 min left".
  const minutes = Math.max(1, Math.round(remaining / 60_000));
  return `${minutes} min left`;
};

/** The name of whoever is on the other end of a link, for a sentence. */
const nameOf = (profile: { username?: string } | undefined, fallback: string) =>
  profile?.username?.trim() || fallback;

/**
 * What the person waiting on a link is told about its author, in a few words.
 *
 * Whether anybody is coming is the thing they want to know, so it is the thing
 * said: called, or not online and not reachable.
 */
export const authorWhereabouts = (
  status: ChallengeLinkAuthorStatus | undefined,
  called: boolean | undefined,
): string => {
  switch (status) {
    case 'busy':
      return 'In another game';
    case 'idle':
      return called ? 'Away · notified' : 'Away from the screen';
    case 'away':
      return called ? 'Offline · notified' : 'Offline';
    case 'here':
      return 'Starting';
    default:
      return '';
  }
};

/**
 * The one-line status of a link from where this account stands.
 *
 * `nowMs` is passed in so a countdown is testable, as everywhere else here.
 */
export const linkStatusLine = (
  link: ChallengeLink,
  role: ChallengeLinkRole,
  nowMs: number,
): string => {
  switch (link.state) {
    case 'open':
      return role === 'author'
        ? `Open · ${linkExpiryLabel(link.expiresAtUnixMs, nowMs)}`
        : `${nameOf(link.challenger, 'Someone')} is waiting for an opponent`;
    case 'waiting':
      if (role === 'author') return `${nameOf(link.taker, 'Someone')} is waiting for you`;
      return authorWhereabouts(link.authorStatus, link.authorCalled);
    case 'started':
      return 'Game on';
    default:
      return 'Expired';
  }
};

/**
 * The title of a link's card or row.
 *
 * Named for the other person throughout, because they are what the link is
 * about: whose challenge it is, who took yours, whom you are waiting for.
 */
export const linkTitle = (link: ChallengeLink, role: ChallengeLinkRole): string => {
  if (role === 'author') {
    return link.state === 'waiting'
      ? `${nameOf(link.taker, 'Someone')} took your link`
      : 'Your challenge link';
  }
  if (role === 'taker') return `Waiting for ${nameOf(link.challenger, 'them')}`;
  return `${nameOf(link.challenger, 'Someone')}'s challenge`;
};

/** A server refusal, read as the sentence it is shown as. */
export const asSentence = (message: string): string => {
  const trimmed = message.trim();
  if (!trimmed) return '';
  const capitalised = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
};
