import { webGoatGuy } from '@/navigation/links';

// The official tournament: one event, on somebody else's site, on one afternoon.
//
// Everything on the `/tournaments` board is an event *of this site* — this
// server owns the signups, the pairings and the boards they are played on. This
// is not that. It is WebGoatGuy's own tournament on his own site, and the only
// things this app can honestly do about it are say when it is, point at it, and
// get out of the way while it runs.
//
// So it is a constant rather than a row in the database: there is nothing here
// for the server to know, nothing for a player to sign up to *here*, and one
// afternoon in which it is true. What the server does own is the other half —
// every engine on the bot ladder is stood down across the event, which is a
// schedule declared in `backend/internal/server/bot_bench.go` and published to
// this client as `botBench`. The two are deliberately separate: this decides
// what the site *says*, and the server decides what the site *does*. Change the
// times here and the bots do not move.
//
// One more thing about this event lives elsewhere and is *not* on a schedule:
// `ENGINE_TOURNAMENT_DISABLED_MODES` in `engine/rpsfish/protocol.ts` keeps
// RPSFish out of Intransitive "until after the official tournament", by hand.
// Nothing here turns that back on — it is a set somebody has to empty.
//
// A note on the timezone, because it is the one thing that could be wrong. The
// event was announced as "12 PM EST, September 5th". Eastern time on 5 September
// 2026 is EDT (UTC-4), not EST (UTC-5), so this reads it as the far more likely
// "noon Eastern" — 16:00 UTC. If it turns out to have meant UTC-5 literally, the
// event starts at 17:00 UTC, which is still inside the window below and inside
// the server's bench; only the countdown would be an hour out.

/** One instant, spelled as UTC. See the note above about EST and EDT. */
const utc = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): number => Date.UTC(year, month - 1, day, hour, minute);

export const officialTournament = {
  name: 'The official Intransitive tournament',

  /** Noon Eastern on Saturday 5 September 2026. */
  startsAtUnixMs: utc(2026, 9, 5, 16, 0),

  /**
   * When the site stops calling it live.
   *
   * Six in the evening Eastern, which is where the server's bot bench ends
   * too. Not a claim about when the last game finishes — nobody here knows
   * that — but the point past which this site should stop shouting about it.
   */
  endsAtUnixMs: utc(2026, 9, 5, 22, 0),

  /**
   * The engines are off from half past eleven Eastern.
   *
   * Repeated here from the server's schedule so the page can say the time
   * before anybody has connected a socket. The server is the authority on
   * whether the bench is actually running; this is only the sentence.
   */
  botsOfflineFromUnixMs: utc(2026, 9, 5, 15, 30),
  botsOfflineUntilUnixMs: utc(2026, 9, 5, 22, 0),

  /**
   * The window in which the sidebar button and the front-page banner appear:
   * the day before, and the day itself.
   *
   * Both bounds are midnight Eastern. A promotion for an event that finished
   * last month is worse than none — it makes a live site look abandoned — so
   * this expires on its own rather than waiting for somebody to remember.
   * The page it promotes stays reachable forever; only the shouting stops.
   */
  promoFromUnixMs: utc(2026, 9, 4, 4, 0),
  promoUntilUnixMs: utc(2026, 9, 6, 4, 0),

  /**
   * The date and time as the event was announced, written out rather than
   * formatted.
   *
   * Every page of this site is pre-rendered in Node at build time, where the
   * machine's timezone is whatever the build machine's is — so a date formatted
   * at render is a date that can differ between the HTML and the browser that
   * hydrates it. A string cannot. `localTimeLabel` below is the same instant in
   * the reader's own zone, and it is deliberately something a screen shows
   * *after* mounting.
   */
  whenLabel: 'Saturday, September 5 · 12:00 PM Eastern',
  botsOfflineLabel: '11:30 AM – 6:00 PM Eastern',

  playURL: webGoatGuy.playURL,
  discordURL: webGoatGuy.discordURL,
} as const;

/** Where the afternoon stands, for a page that says different things at each. */
export type OfficialTournamentPhase = 'upcoming' | 'live' | 'over';

export const officialTournamentPhase = (now: number): OfficialTournamentPhase => {
  if (now < officialTournament.startsAtUnixMs) return 'upcoming';
  if (now < officialTournament.endsAtUnixMs) return 'live';
  return 'over';
};

/** Whether the sidebar button and the front-page banner are shown at all. */
export const officialTournamentPromoVisible = (now: number): boolean =>
  now >= officialTournament.promoFromUnixMs && now < officialTournament.promoUntilUnixMs;

/**
 * "in 3 hours", "in 12 minutes", "starting now".
 *
 * Coarse on purpose. A second-by-second countdown to something happening on
 * another site is a thing to watch instead of a thing to know, and it would
 * mean re-rendering the whole shell once a second to say so.
 */
export const untilLabel = (now: number, target: number): string => {
  const minutes = Math.round((target - now) / 60_000);
  if (minutes <= 0) return 'starting now';
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
};

/**
 * The start time in the reader's own timezone, or null where there is no
 * telling what that is.
 *
 * Only ever called from a screen that has already mounted — see `whenLabel`
 * above for why — and it answers null rather than guessing if the browser has
 * no `Intl`, so the Eastern label stands alone rather than being contradicted.
 */
export const localTimeLabel = (unixMs: number): string | null => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(unixMs));
  } catch {
    return null;
  }
};
