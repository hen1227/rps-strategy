// What is happening on the server right now, derived once.
//
// The desktop rail, the phone's collapsed summary bar, and — later — the game
// screen all want the same handful of answers, and three copies of "which of
// these live games is a bot fight" is how one of them ends up counting a
// tournament board twice. Pure functions over store state, in the same spirit
// as `store/tournamentSelectors.ts`.

import { gridFromRows } from '@/engine/analysisGame';
import {
  playerName,
  seriesProgressLabel,
  seriesScoreLabel,
  seriesScoreOf,
} from '@/store/spectateSelectors';
import { isOpenChallenge } from '@/types/protocol';
import type { BotPresence, Challenge, LiveGameSummary, TitleID, Tournament } from '@/types/protocol';
import {
  isBoardRows,
  type Grid,
  type ModeDefinition,
  type ModeID,
  type PlayerColor,
  type SideColor,
} from '@/types/game';
import type { BadgeTone } from '@/ui/tones';

/** Somebody who wants a game and has not got one. */
export interface WaitingSeat {
  /** Stable across renders: the id of the seek behind it. */
  key: string;
  /** Who is waiting. */
  label: string;
  /** The mode they are waiting in, so joining them needs no parsing. */
  modeId: ModeID;
  /** The game on offer. Every waiting seat has one, and it is takeable. */
  challenge: Challenge;
  /**
   * The mode its setup names, resolved here rather than by each screen. A board
   * thumbnail needs the definition to tint itself, and a screen that looked it
   * up would be the second place that knows how.
   */
  mode: ModeDefinition | null;
  /**
   * True when this is the viewer's own row. It stays on the board rather than
   * being hidden — seeing your own game waiting is the point of posting it —
   * but it is offered as something to cancel, not to accept, since the server
   * refuses anybody playing themselves.
   */
  mine: boolean;
  /** How many people this row stands for. Always one: every row is a person. */
  count: number;
}

/** What an engine is doing, in the one vocabulary every screen spells it in. */
export type EngineActivity = 'playing' | 'idle' | 'private' | 'draining' | 'benched';

/**
 * One engine on the roster, ready to be drawn.
 *
 * The roster says whether a bot is busy; it does not say which board it is on.
 * That join — bot account against the two seats of every live game — is here so
 * that the rail, the bots page and anything after them agree about it, rather
 * than each growing its own idea of what "playing" points at.
 */
export interface EngineSeat {
  /** Stable across renders: the bot's own id. */
  key: string;
  bot: BotPresence;
  status: EngineStatus;
  /** The board it is on, when the roster says it is busy and we can find it. */
  game: LiveGameSummary | null;
  /** That board's mode, resolved once so no screen looks it up. */
  mode: ModeDefinition | null;
  /** Which side of that board it plays. */
  color: SideColor | null;
  /** Who it is playing. Split from its title, which the row draws as a `TitleTag` chip. */
  opponentName: string | null;
  opponentTitle: TitleID | null;
  /**
   * The ratings this row should show.
   *
   * An engine at a board is rated in the mode of that board, and nothing else
   * is worth the width. An engine sitting idle has no mode to be read against,
   * so it carries one rating per mode it plays: a single number beside a name
   * that plays both Total War and Infiltration does not say which one it is,
   * and the two are hundreds of points apart for the same engine.
   */
  ratings: EngineRating[];
  /**
   * True when this row is the one that draws the board.
   *
   * Only for a game the engines have to themselves, and only for the first of
   * the two rows in it: a game with a person in it is something to watch and
   * keeps the featured slot at the top of the rail, and the second engine of a
   * pair would only be drawing the same board again.
   */
  showsBoard: boolean;
}

export interface EngineStatus {
  activity: EngineActivity;
  label: string;
  tone: BadgeTone;
}

/** One mode's rating, labelled the way every other rating in the app is. */
export interface EngineRating {
  modeId: ModeID;
  /** The mode's short code — `V5`, `V3` — which is what a narrow row has room for. */
  shortCode: string;
  name: string;
  elo: number;
}

/**
 * What an engine is rated in one mode.
 *
 * Every mode rates independently, and a mode nobody has finished a game in
 * inherits the account's shared rating — the same answer `Account.ModeElo`
 * gives on the server. `bot.elo` on its own is only that shared seed, which for
 * an engine a hundred games into a ladder is a number from before all of them.
 */
export const engineElo = (bot: BotPresence, modeId: ModeID): number =>
  bot.modeRatings?.[modeId] ?? bot.elo;

/**
 * Every rating an engine carries, in the modes it actually plays.
 *
 * Its handshake says which those are. An engine that declares none is taken to
 * play the playable ones, which is what the challenge button already assumes of
 * it. Modes stay in the server's order, so these read in the same order as the
 * mode cards on the play page.
 */
export const engineRatings = (bot: BotPresence, modes: ModeDefinition[]): EngineRating[] =>
  modes
    .filter((mode) => (bot.modes?.length ? bot.modes.includes(mode.id) : mode.playable !== false))
    .map((mode) => ({
      modeId: mode.id,
      shortCode: mode.shortCode,
      name: mode.name,
      elo: engineElo(bot, mode.id),
    }));

/**
 * What to call an engine's state, and how it should look.
 *
 * One definition, because "busy" and "private" are the roster's words and both
 * the bots page and the live rail put a badge on them.
 */
export const engineStatus = (bot: BotPresence): EngineStatus => {
  // Ahead of `busy`, because a draining engine mid-game is leaving *after* that
  // game. Reading PLAYING would invite somebody to wait for the board to clear
  // and then challenge it, which is the one thing that will not work.
  //
  // The bench comes first of all, and is the one state here that is true of
  // every engine at once. Saying SHUTTING DOWN against the whole ladder for an
  // afternoon would read as a broken server rather than as a scheduled break,
  // which is exactly why the server publishes the two apart.
  if (bot.benched) return { activity: 'benched', label: 'OFFLINE FOR THE TOURNAMENT', tone: 'neutral' };
  if (bot.draining) return { activity: 'draining', label: 'SHUTTING DOWN', tone: 'neutral' };
  // An engine with several slots can be playing and free at the same moment, so
  // the badge counts rather than choosing between the two words. `busy` still
  // decides whether it is playing at all: a bot with every slot held by a
  // series is between games rather than idle, however few boards it is on.
  const slots = engineSlots(bot);
  const active = engineActiveGames(bot);
  if (active > 0 || bot.busy) {
    return {
      activity: 'playing',
      label: slots > 1 && active > 0 ? `PLAYING ${active} OF ${slots}` : 'PLAYING',
      tone: 'live',
    };
  }
  if (!bot.allowPublicPlay) return { activity: 'private', label: 'PRIVATE', tone: 'neutral' };
  return { activity: 'idle', label: 'IDLE', tone: 'accent' };
};

/**
 * How many games an engine takes at once, and how many it is in.
 *
 * Defaulted here rather than at each reader: a server that predates concurrent
 * bots sends neither field, and every bot it knows about plays one game at a
 * time — which is exactly what `busy` meant on its own.
 */
export const engineSlots = (bot: BotPresence): number => Math.max(bot.slots ?? 1, 1);

export const engineActiveGames = (bot: BotPresence): number =>
  bot.activeGames ?? (bot.busy ? 1 : 0);

/**
 * Whether this engine can take a game right now.
 *
 * The button's answer and the badge's answer come from one place, so a row
 * cannot say SHUTTING DOWN next to a live PLAY button.
 */
export const engineIsAvailable = (bot: BotPresence): boolean =>
  !bot.busy && !bot.draining && !bot.benched && bot.allowPublicPlay;

/**
 * Engines at work first: an idle bot is a button, a playing one is a board.
 *
 * A draining one sorts last of all, below even a private engine: it is the only
 * state on this list that nobody can do anything about, and it is about to stop
 * being on the list at all.
 */
const ENGINE_ORDER: Record<EngineActivity, number> = {
  playing: 0,
  idle: 1,
  private: 2,
  draining: 3,
  // Below a drain, but it does not matter: a bench is on every engine at once,
  // so this rank never breaks a tie against anything else.
  benched: 4,
};

export interface LiveSnapshot {
  /** People connected to the lobby, however they are spending their time. */
  onlineCount: number;
  /** Games between people. */
  playerGames: LiveGameSummary[];
  /** Games that are one game of a bot-versus-bot series. */
  botFights: LiveGameSummary[];
  /** People practising against a bot in their own browser. */
  botPlayerCount: number;
  /** Engines connected from somebody's machine, joined to what each is doing. */
  engines: EngineSeat[];
  /**
   * The live boards for the watch list, ranked, and *only* the ones the engine
   * rows are not already drawing.
   *
   * Every live board belongs in the rail exactly once. A game between two
   * engines is explained by the engine rows around it; anything with a person
   * in it is explained by being at the top. Drawing a board in both places is
   * the same board twice in a column 296 points wide.
   */
  watchable: LiveGameSummary[];
  /** Open challenges plus anyone sitting in matchmaking. */
  waiting: WaitingSeat[];
  /** The tournament worth mentioning, if any. */
  activeTournament: Tournament | null;
  /** Mode openings provide the first-frame fallback for a live board. */
  modes: ModeDefinition[];
}

/** The slice of the store this module reads. Narrow on purpose: it is testable. */
export interface LiveSource {
  /** Who is looking. Decides which open challenge is the viewer's own. */
  accountId: string;
  onlineCount: number;
  liveGames: LiveGameSummary[];
  botPlayerCount: number;
  engineBots: BotPresence[];
  openChallenges: Challenge[];
  tournaments: Tournament[];
  modes: ModeDefinition[];
}

/**
 * A tournament is worth a line in the rail when it is running, and otherwise
 * when its signup is open. A completed event is history and belongs on its own
 * page.
 */
const activeTournamentOf = (tournaments: Tournament[]): Tournament | null =>
  tournaments.find((tournament) => tournament.status === 'in_progress') ??
  tournaments.find((tournament) => tournament.status === 'registration') ??
  null;

/**
 * Join the roster to the live games, then order it for reading.
 *
 * A bot that the roster calls busy without a matching board is left as a row
 * with no board rather than dropped: the game may have ended a beat before this
 * snapshot, and an engine that exists is still worth listing.
 *
 * One row per engine, and so one board per engine: a bot playing three games at
 * once draws the first of them and says `PLAYING 3 OF 3` beside it. Three rows
 * for one name would read as three bots, which is the thing this list is for
 * telling apart.
 */
const engineSeatsOf = (
  bots: BotPresence[],
  liveGames: LiveGameSummary[],
  modes: ModeDefinition[],
): EngineSeat[] => {
  const roster = new Set(bots.map((bot) => bot.userId));
  /** A board the engines have to themselves, which is theirs to explain. */
  const isEngineGame = (game: LiveGameSummary) =>
    roster.has(game.redPlayer?.userId) && roster.has(game.bluePlayer?.userId);

  const seats = bots.map((bot): EngineSeat => {
    const status = engineStatus(bot);
    const game = engineActiveGames(bot) > 0
      ? liveGames.find(
          (candidate) =>
            candidate.redPlayer?.userId === bot.userId ||
            candidate.bluePlayer?.userId === bot.userId,
        ) ?? null
      : null;
    const color: SideColor | null = game
      ? game.redPlayer?.userId === bot.userId
        ? 'Red'
        : 'Blue'
      : null;
    const mode = game ? modes.find((candidate) => candidate.id === game.modeId) ?? null : null;
    return {
      key: bot.botId,
      bot,
      status,
      game,
      mode,
      color,
      opponentName: game
        ? playerName(color === 'Red' ? game.bluePlayer : game.redPlayer, color === 'Red' ? 'Blue' : 'Red')
        : null,
      opponentTitle: game ? (color === 'Red' ? game.bluePlayer : game.redPlayer)?.title ?? null : null,
      // A board names its own mode, so a playing engine is one rating; the mode
      // may predate this client's mode list, in which case the game's own name
      // for it is the honest label.
      ratings: game
        ? [
            {
              modeId: game.modeId,
              shortCode: mode?.shortCode ?? game.modeName,
              name: mode?.name ?? game.modeName,
              elo: engineElo(bot, game.modeId),
            },
          ]
        : engineRatings(bot, modes),
      showsBoard: false,
    };
  });

  seats.sort((first, second) => {
    const byActivity = ENGINE_ORDER[first.status.activity] - ENGINE_ORDER[second.status.activity];
    if (byActivity !== 0) return byActivity;
    // Both engines of a series land next to each other, so the one board drawn
    // for the pair sits with both of the rows it belongs to.
    const byGame = (first.game?.gameId ?? '').localeCompare(second.game?.gameId ?? '');
    if (byGame !== 0) return byGame;
    return first.bot.name.localeCompare(second.bot.name);
  });

  const drawn = new Set<string>();
  return seats.map((seat) => {
    if (!seat.game || !isEngineGame(seat.game) || drawn.has(seat.game.gameId)) return seat;
    drawn.add(seat.game.gameId);
    return { ...seat, showsBoard: true };
  });
};

export const liveSnapshot = (source: LiveSource): LiveSnapshot => {
  const playerGames: LiveGameSummary[] = [];
  const botFights: LiveGameSummary[] = [];
  for (const liveGame of source.liveGames ?? []) {
    // `series` is the server's own marker that a row is one game of a run, so
    // splitting on it needs no guess about who the players are.
    (liveGame.series ? botFights : playerGames).push(liveGame);
  }

  // One list, because there is one thing to list. Matchmaking used to be an
  // anonymous count beside these rows, which double-counted everybody: a person
  // pressing play and a person posting a game now produce the same kind of
  // seek, and the server publishes both here by name.
  //
  // Searching players first. Somebody who pressed play is sitting there
  // expecting a game right now; a posted game will wait ten minutes for one.
  const waiting: WaitingSeat[] = (source.openChallenges ?? [])
    .filter(isOpenChallenge)
    .map((challenge) => ({
      key: challenge.id,
      label: challenge.challenger.username || 'Someone',
      modeId: challenge.setup.modeId,
      challenge,
      mode: (source.modes ?? []).find((mode) => mode.id === challenge.setup.modeId) ?? null,
      mine: challenge.challenger.userId === source.accountId,
      count: 1,
    }))
    .sort(
      (first, second) =>
        Number(Boolean(second.challenge.queued)) - Number(Boolean(first.challenge.queued)),
    );

  const engines = engineSeatsOf(source.engineBots ?? [], source.liveGames ?? [], source.modes ?? []);
  const drawnByEngines = new Set(
    engines.filter((seat) => seat.showsBoard).map((seat) => seat.game!.gameId),
  );

  return {
    onlineCount: source.onlineCount ?? 0,
    playerGames,
    botFights,
    botPlayerCount: source.botPlayerCount ?? 0,
    engines,
    // People playing each other are the heart of the community, so they rank
    // above an engine run that nothing below has claimed.
    watchable: [...playerGames, ...botFights].filter(
      (liveGame) => !drawnByEngines.has(liveGame.gameId),
    ),
    waiting,
    activeTournament: activeTournamentOf(source.tournaments ?? []),
    modes: source.modes ?? [],
  };
};

/** How many people the snapshot says are waiting for an opponent. */
export const waitingCount = (snapshot: LiveSnapshot): number =>
  snapshot.waiting.reduce((total, seat) => total + seat.count, 0);

/**
 * Decode the compact lobby snapshot into the same grid every board renders.
 *
 * A browser can briefly overlap a backend deployment that predates live board
 * rows. The mode opening is the honest first-frame fallback in that case: it
 * avoids both a blank board and a second made-up starting position.
 */
export const liveGameGrid = (
  game: Pick<LiveGameSummary, 'position'>,
  openingRows?: readonly string[],
): Grid => {
  const rows = isBoardRows(game.position?.rows)
    ? game.position.rows
    : isBoardRows(openingRows)
      ? openingRows
      : undefined;
  const grid = gridFromRows(rows);
  if (!isBoardRows(game.position?.owners)) return grid;

  const ownerAt = (x: number, y: number): PlayerColor => {
    const owner = game.position!.owners[y]?.[x];
    if (owner === 'r') return 'Red';
    if (owner === 'b') return 'Blue';
    return 'Neutral';
  };
  return grid.map((row, y) =>
    row.map((tile, x) => ({ ...tile, ownerColor: ownerAt(x, y) })),
  );
};

/**
 * Every live board, people first.
 *
 * For a screen with no engine rows on it — a phone's lobby — where nothing else
 * explains the boards two engines have to themselves. `watchable` is this list
 * minus the ones the rail's own engine rows already draw.
 */
export const allLiveBoards = (snapshot: LiveSnapshot): LiveGameSummary[] => [
  ...snapshot.playerGames,
  ...snapshot.botFights,
];

/** The dim second line of a live row: what this game is, or how the series stands. */
export const liveGameMeta = (game: LiveGameSummary, red: string, blue: string): string => {
  if (!game.series) {
    return game.spectatorCount
      ? `${game.modeName} · ${game.spectatorCount} watching`
      : `${game.modeName} · Room open`;
  }
  return `${seriesProgressLabel(game.series)} · ${seriesScoreLabel(
    seriesScoreOf(game.series, red, blue),
  )}`;
};

/** The next move label, safe for a live row without the preview extension. */
export const liveMoveLabel = (moveNumber: number | null | undefined): string =>
  typeof moveNumber === 'number' && Number.isFinite(moveNumber) && moveNumber > 0
    ? `Move ${moveNumber + 1}`
    : 'Opening position';

/**
 * The one line a phone has room for, in the top bar beside the connection dot.
 *
 * Only the parts that are non-zero, so a quiet server reads "3 here" rather
 * than "3 here · 0 live · 0 waiting", which looks broken. "here" rather than
 * "online" because the dot it sits next to already means online, and the two
 * senses of the word next to each other read as one number about the socket.
 */
export const liveHeadline = (snapshot: LiveSnapshot): string => {
  const parts = [`${snapshot.onlineCount} here`];
  const live = snapshot.playerGames.length + snapshot.botFights.length;
  if (live > 0) parts.push(`${live} live`);
  const waiting = waitingCount(snapshot);
  if (waiting > 0) parts.push(`${waiting} waiting`);
  if (snapshot.activeTournament?.status === 'in_progress') parts.push('tournament on');
  return parts.join(' · ');
};
