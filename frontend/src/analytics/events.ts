// Every event the app sends, and what each may carry.
//
// One table, so the whole of what leaves a device for Google can be read in one
// place — and so `track` refuses at compile time anything not written down
// here. The server sends two more of its own, `game_finished` and
// `bot_connected`, which describe the site rather than anybody on it; see
// `backend/internal/server/google_analytics.go`.
//
// The rule every parameter follows: what was played and pressed, never who.
// No username, account ID, game ID, opponent or free text. A parameter Google
// should break a report down by has to be registered in the property as a
// custom dimension; `docs/analytics.md` lists them.

/** How somebody proved who they are. */
export type SignInMethod = 'discord' | 'apple' | 'password' | 'unknown';

/** Where a game is played: on the server, against a bot on the device, or two people at one screen. */
export type GameKind = 'online' | 'practice' | 'local';

export type RankedFlag = 'ranked' | 'casual';

/**
 * How the lessons were opened: by themselves on a new device, from How to play,
 * or by somebody arriving at their address.
 */
export type TutorialSource = 'first_launch' | 'how_to_play' | 'link';

export interface AnalyticsEvents {
  /** The page itself travels with every event; see `track` and `pagePath.ts`. */
  page_view: Record<string, never>;
  sign_up: { method: SignInMethod };
  login: { method: SignInMethod };
  queue_join: { mode: string };
  challenge_post: { mode: string; ranked: RankedFlag; time_control: string; kind: 'open' | 'direct' };
  game_start: { mode: string; kind: GameKind; opponent: 'human' | 'bot'; time_control: string };
  game_end: {
    mode: string;
    kind: GameKind;
    opponent: 'human' | 'bot';
    /** From this player's side. Two people at one screen have no side, so a decided local game is `decided`. */
    result: 'win' | 'loss' | 'draw' | 'decided';
    end_reason: string;
    moves: number;
  };
  /** Two engines, started from the Bots page: in this browser or on the server. */
  bot_match_start: { mode: string; where: 'device' | 'server'; ranked?: RankedFlag };
  tournament_signup: Record<string, never>;
  feedback_post: { kind: string };
  alerts_enable: { platform: string };
  /** A link copied to share. `content_type` is the kind of page, never which one. */
  share: { content_type: string; method: 'copy' };
  /**
   * The lessons opened, and every one of them answered. Google's own names for
   * the two, so its reports know them as a tutorial: how many who start one
   * finish it is the question they exist to answer.
   */
  tutorial_begin: { source: TutorialSource };
  tutorial_complete: Record<string, never>;
}

export type AnalyticsEventName = keyof AnalyticsEvents;

/** What a parameter value can be once it reaches Google. */
export type AnalyticsParams = Record<string, string | number>;

/** A time control as `initial+increment`, in seconds, the way the server writes it. */
export const timeControlLabel = (timeControl?: { initialTimeMs: number; incrementMs: number }) =>
  timeControl
    ? `${Math.round(timeControl.initialTimeMs / 1000)}+${Math.round(timeControl.incrementMs / 1000)}`
    : 'none';
