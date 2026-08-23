import { send } from './socketSend';
import type { ActiveGame, GameStore } from './types';
import {
  applyAnalysisMove,
  createAnalysisGame,
  enginePosition,
  validMovesFor,
  type AnalysisGame,
} from '@/engine/analysisGame';
import { createBot, createSeededRandom, type Bot } from '@/engine/bots/engine';
import { BOT_TUNING, botProfile } from '@/engine/bots/profiles';
import { inferMoveBetweenGrids } from '@/engine/moveDiff';
import { encodePGN, encodePosition, resultFor, type WritableMove } from '@/engine/pgn';
import { analyzeExclusive } from '@/engine/rpsfish/client';
import {
  opposingColor,
  samePosition,
  type GameEndReason,
  type ModeDefinition,
  type Move,
  type PlayerColor,
  type Position,
  type SideColor,
} from '@/types/game';
import type { PlayerProfile } from '@/types/game';
import type { Account } from '@/types/protocol';
import type { StateCreator } from 'zustand';

// The bot board runs entirely in the browser: RPSFish thinks in the WASM
// worker, the mode rules come from `engine/analysisGame.ts`, and the server
// never sees a move. It does hear that the player is busy, so the lobby can
// say so — that is the only traffic a bot game generates.
//
// The session publishes a server-shaped `gameState`, which is what lets the
// real match screen, the sound effects, and the board component render a bot
// game without knowing it is one. `gameState.bot` is the marker that tells
// them a bot is on the other side.

/** The move RPSFish would play, when the player has asked for one. */
export interface BotHint {
  depth: number;
  from: Position;
  score: number;
  to: Position;
}

/** Everything about a bot game that is not the board itself. */
export interface BotSessionState {
  botBlurb: string;
  botColor: SideColor;
  botName: string;
  botRating: number;
  drawNotice: string | null;
  // `undefined` for "nobody", which is also how the server spells it: the Go
  // fields are `omitempty`, so an absent offer is an absent field.
  drawOfferUsedBy: PlayerColor | undefined;
  drawOfferedBy: PlayerColor | undefined;
  engineError: string | null;
  gameId: string;
  hint: BotHint | null;
  hintPending: boolean;
  modeId: string;
  playerColor: SideColor;
  profileId: string;
  randomSeed: number;
  startedAtUnixMs: number;
  thinking: boolean;
}

/** One move of a bot game, kept so the game can be written out as a record. */
export interface BotMove extends WritableMove {
  player: SideColor;
}

// Driver state that is not render state. Keeping it out of the store means a
// cancelled search or a stale turn cannot cause a re-render.
let activeBot: Bot | null = null;
let turnSequence = 0;
let turnController: AbortController | null = null;
let hintSequence = 0;
let hintController: AbortController | null = null;

const cancelBotWork = () => {
  turnSequence += 1;
  hintSequence += 1;
  turnController?.abort();
  turnController = null;
  hintController?.abort();
  hintController = null;
};

const botPlayerProfile = (bot: { id: string; name: string }): PlayerProfile => ({
  userId: `bot:${bot.id}`,
  username: bot.name,
  discord: '',
});

const humanPlayerProfile = (
  accountId: string,
  account: Account | null | undefined,
): PlayerProfile => ({
  userId: accountId,
  // 'Guest' is the placeholder the player bar already knows how to replace, so
  // an unnamed account still reads as "You" on their own side of the board.
  username: account?.username?.trim() || 'Guest',
  discord: account?.discord ?? '',
});

// Bot games carry no clock and no rating, so the fields a server game would
// fill are deliberately null. Every consumer already treats a missing clock as
// "no clock to show".
const toGameState = (
  game: AnalysisGame,
  session: BotSessionState,
  profiles: { bot: PlayerProfile; human: PlayerProfile },
): ActiveGame => ({
  bot: {
    blurb: session.botBlurb,
    color: session.botColor,
    name: session.botName,
    profileId: session.profileId,
    rating: session.botRating,
  },
  bluePlayer: session.botColor === 'Blue' ? profiles.bot : profiles.human,
  clock: null,
  currentTurn: game.currentTurn,
  drawOfferedBy: session.drawOfferedBy,
  drawOfferUsedBy: session.drawOfferUsedBy,
  endReason: game.endReason ?? undefined,
  gameId: session.gameId,
  grid: game.grid,
  mode: game.mode,
  moveNumber: game.moveNumber,
  redPlayer: session.botColor === 'Red' ? profiles.bot : profiles.human,
  status: game.status,
  timeControl: null,
  // A bot game has no clock, so there is never a time extension to answer.
  timeOfferedBy: undefined,
  timeOfferUsedBy: undefined,
  winner: game.winner,
});

/** What a bot game contributes to the store. */
export interface BotState {
  botSession: BotSessionState | null;
  botGame: AnalysisGame | null;
  botHistory: AnalysisGame[];
  botMoves: BotMove[];
}

export interface BotActions {
  startBotGame: (options: {
    mode?: ModeDefinition | null;
    profileId?: string;
    playerColor?: SideColor | 'random';
  }) => void;
  restartBotGame: () => void;
  botSelectTile: (position: Position) => void;
  botMovePiece: (from: Position, to: Position) => void;
  undoBotMove: () => void;
  requestBotHint: () => Promise<void>;
  offerBotDraw: () => Promise<void>;
  resignBotGame: () => void;
  endBotSession: () => void;
  botGamePGN: () => string | null;
  announceBotPresence: () => void;
}

export type BotSlice = BotState & BotActions;

export const initialBotState: BotState = {
  botSession: null,
  botGame: null,
  botHistory: [],
  // The moves as played, so a finished bot game can be written out as a
  // record. Nothing on the server knows this game happened, so if the browser
  // does not keep the move list there is nothing to review.
  botMoves: [],
};

/** One publish: the rules state, and whichever pieces of board state moved. */
interface PublishPatch {
  session?: Partial<BotSessionState>;
  botGame?: AnalysisGame;
  botHistory?: AnalysisGame[];
  botMoves?: BotMove[];
  lastMove?: Move | null;
  selectedTile?: Position | null;
  validMoves?: Position[];
}

export const createBotSlice: StateCreator<GameStore, [], [], BotSlice> = (set, get) => {
  // Rebuilds the public snapshot from the private rules state. Every bot action
  // ends here so the screen only ever sees consistent state.
  const publish = (patch: PublishPatch = {}) => {
    const { account, accountId, botGame, botSession } = get();
    if (!botSession || !botGame) return;
    const session = { ...botSession, ...(patch.session ?? {}) };
    const game = patch.botGame ?? botGame;
    set({
      botSession: session,
      botGame: game,
      ...(patch.botHistory ? { botHistory: patch.botHistory } : {}),
      ...(patch.botMoves ? { botMoves: patch.botMoves } : {}),
      gameState: toGameState(game, session, {
        bot: botPlayerProfile(activeBot ?? { id: session.profileId, name: session.botName }),
        human: humanPlayerProfile(accountId, account),
      }),
      ...(patch.lastMove !== undefined ? { lastMove: patch.lastMove } : {}),
      ...(patch.selectedTile !== undefined ? { selectedTile: patch.selectedTile } : {}),
      ...(patch.validMoves !== undefined ? { validMoves: patch.validMoves } : {}),
    });
  };

  const finish = (winner: PlayerColor, endReason: GameEndReason) => {
    const game = get().botGame;
    if (!game) return;
    cancelBotWork();
    publish({
      botGame: { ...game, status: 'Finished', winner, endReason },
      session: { thinking: false, drawOfferedBy: undefined, hint: null, hintPending: false },
      selectedTile: null,
      validMoves: [],
    });
  };

  // Applies a legal move for whichever side is to move and, when the bot is
  // next, starts it thinking.
  const applyMove = (from: Position, to: Position) => {
    const { botGame, botHistory, botMoves } = get();
    if (!botGame) return false;
    const source = botGame.grid[from.y]?.[from.x];
    const destination = botGame.grid[to.y]?.[to.x];
    if (!source || !destination || source.occupant === 'Empty') return false;
    const result = applyAnalysisMove(botGame, from, to);
    if (!result) return false;
    publish({
      botGame: result.game,
      botHistory: [...botHistory, botGame],
      botMoves: [
        ...botMoves,
        {
          from,
          to,
          player: result.mover,
          piece: source.occupant,
          captured: destination.occupant,
        },
      ],
      lastMove: { from, to },
      selectedTile: null,
      validMoves: [],
      // A draw offer is spent for one move only, the same rule a server game
      // follows, and a hint belongs to the position it was asked about.
      session: {
        drawNotice: null,
        drawOfferUsedBy: undefined,
        drawOfferedBy: undefined,
        hint: null,
        hintPending: false,
      },
    });
    return true;
  };

  const runBotTurn = async () => {
    const session = get().botSession;
    const game = get().botGame;
    if (!activeBot || !session || !game) return;
    if (game.status !== 'InProgress' || game.currentTurn !== session.botColor) return;

    const sequence = (turnSequence += 1);
    turnController?.abort();
    const controller = new AbortController();
    turnController = controller;
    publish({ session: { thinking: true, engineError: null } });

    let decision;
    try {
      decision = await activeBot.chooseMove(game, {
        history: get().botHistory,
        signal: controller.signal,
      });
    } catch (error) {
      const failure = error as { name?: string; message?: string } | null;
      if (failure?.name === 'AbortError' || sequence !== turnSequence) return;
      publish({ session: { thinking: false, engineError: failure?.message ?? 'The bot stopped.' } });
      return;
    }
    if (sequence !== turnSequence || !get().botSession) return;

    if (!decision) {
      publish({ session: { thinking: false } });
      return;
    }
    // `decision.resigns` is deliberately ignored here. A bot that concedes a
    // lost position is playing correctly, but it takes the win away from the
    // person who earned it, so on this board the bot always plays on and the
    // player finishes the game themselves. The flag still exists for the arena,
    // where nobody is watching and a decided game is only costing time.

    publish({ session: { thinking: false } });
    if (!applyMove(decision.from, decision.to)) {
      // Only reachable if a bot proposes a move the rules reject, which is a
      // bug in the bot. Saying so beats a board that silently stops.
      publish({
        session: {
          engineError: `${session.botName} proposed a move the rules rejected. Undo to continue.`,
        },
      });
    }
  };

  return {
    ...initialBotState,

    /**
     * Open a local game against a bot. The server is told only that this
     * player is busy with bots, never what is on the board.
     */
    startBotGame: ({ mode, profileId, playerColor = 'random' }) => {
      if (!mode) {
        set({ error: 'Choose a game mode before playing a bot.' });
        return;
      }
      // A server game owns the board and the persisted session id, so it is
      // never replaced by a local practice game.
      const current = get().gameState;
      if (current && !current.bot) {
        set({ error: 'Leave your current game before playing a bot.' });
        return;
      }
      cancelBotWork();
      const profile = botProfile(profileId);
      // A bot game runs off a recorded seed rather than `Math.random`, so a
      // game that produced a strange move can be replayed from the seed and
      // the move list alone. Undo still diverges: the stream has already
      // advanced, so a retried position gets the next draw rather than the
      // same one.
      const randomSeed = Date.now() * 4096 + Math.floor(Math.random() * 4096);
      activeBot = createBot(profile, { random: createSeededRandom(randomSeed) });
      const humanColor: SideColor =
        playerColor === 'Red' || playerColor === 'Blue'
          ? playerColor
          : Math.random() < 0.5
            ? 'Red'
            : 'Blue';
      const game = createAnalysisGame(mode);
      const session: BotSessionState = {
        botBlurb: profile.blurb,
        botColor: opposingColor(humanColor),
        botName: profile.name,
        botRating: profile.rating,
        drawNotice: null,
        drawOfferUsedBy: undefined,
        drawOfferedBy: undefined,
        engineError: null,
        // A fresh identifier per game so the board, the move sounds, and the
        // outcome card all treat a rematch as a new game.
        gameId: `bot-${profile.id}-${mode.id}-${Date.now()}`,
        hint: null,
        hintPending: false,
        modeId: mode.id,
        playerColor: humanColor,
        profileId: profile.id,
        randomSeed,
        startedAtUnixMs: Date.now(),
        thinking: false,
      };

      set({
        botSession: session,
        botGame: game,
        botHistory: [],
        botMoves: [],
        playerColor: humanColor,
        isSpectating: false,
        spectatedGameId: null,
        lastMove: null,
        selectedTile: null,
        validMoves: [],
        opponentReconnectDeadline: null,
        chatMessages: [],
        chatRoomId: null,
        error: null,
      });
      publish();
      send(get().socket, { type: 'bot_session_start', modeId: mode.id });
      if (session.botColor === game.currentTurn) runBotTurn();
    },

    /** Same mode and bot, fresh board, opposite colours. */
    restartBotGame: () => {
      const { botGame, botSession } = get();
      if (!botSession || !botGame) return;
      get().startBotGame({
        mode: botGame.mode,
        profileId: botSession.profileId,
        playerColor: opposingColor(botSession.playerColor),
      });
    },

    botSelectTile: (position) => {
      const { botGame, botSession, selectedTile, validMoves } = get();
      if (!botSession || !botGame || botGame.status !== 'InProgress') return;
      if (botGame.currentTurn !== botSession.playerColor) return;

      if (selectedTile && validMoves.some((move) => samePosition(move, position))) {
        if (applyMove(selectedTile, position)) runBotTurn();
        return;
      }
      if (selectedTile && samePosition(selectedTile, position)) {
        publish({ selectedTile: null, validMoves: [] });
        return;
      }
      const moves = validMovesFor(botGame, position);
      publish({
        selectedTile: moves.length > 0 ? position : null,
        validMoves: moves,
      });
    },

    botMovePiece: (from, to) => {
      const { botGame, botSession } = get();
      if (!botSession || !botGame || botGame.status !== 'InProgress') return;
      if (botGame.currentTurn !== botSession.playerColor) return;
      if (applyMove(from, to)) runBotTurn();
    },

    /**
     * Take the board back to the player's own turn, which means undoing their
     * last move and the bot's reply together. A bot mid-search is cancelled.
     */
    undoBotMove: () => {
      const { botHistory, botSession } = get();
      if (!botSession || botHistory.length === 0) return;
      cancelBotWork();

      const history = [...botHistory];
      let game: AnalysisGame | undefined = history.pop();
      while (game && game.currentTurn !== botSession.playerColor && history.length > 0) {
        game = history.pop();
      }
      if (!game) return;

      const previous = history[history.length - 1];
      // One move per history entry, so the record stays a description of the
      // board that is actually on screen.
      set({ botHistory: history, botMoves: get().botMoves.slice(0, history.length) });
      publish({
        botGame: game,
        lastMove: previous ? inferMoveBetweenGrids(previous.grid, game.grid) : null,
        selectedTile: null,
        validMoves: [],
        session: {
          drawNotice: null,
          drawOfferUsedBy: undefined,
          drawOfferedBy: undefined,
          engineError: null,
          hint: null,
          hintPending: false,
          thinking: false,
        },
      });
      // The bot moves first in some games, so an undone position can still be
      // its turn — for example after undoing the player's opening reply.
      if (game.currentTurn === botSession.botColor) runBotTurn();
    },

    /** Ask RPSFish for the player's strongest move. Always a full-strength search. */
    requestBotHint: async () => {
      const { botGame, botHistory, botSession } = get();
      if (!botSession || !botGame || botGame.status !== 'InProgress') return;
      if (botGame.currentTurn !== botSession.playerColor) return;
      if (botSession.hint) {
        publish({ session: { hint: null } });
        return;
      }

      const sequence = (hintSequence += 1);
      hintController?.abort();
      const controller = new AbortController();
      hintController = controller;
      publish({ session: { hintPending: true, engineError: null } });

      try {
        const analysis = await analyzeExclusive(
          {
            ...enginePosition(botGame),
            history: botHistory.map(enginePosition),
          },
          {
            maxNodes: BOT_TUNING.maxNodes,
            ...BOT_TUNING.hint,
            signal: controller.signal,
            throttleMs: BOT_TUNING.throttleMs,
            variations: 1,
          },
        );
        if (sequence !== hintSequence || !get().botSession) return;
        const best = analysis?.lines?.[0];
        publish({
          session: {
            hintPending: false,
            hint: best
              ? { depth: analysis.depth, from: best.from, score: best.score, to: best.to }
              : null,
            engineError: best ? null : 'RPSFish found no move to suggest.',
          },
        });
      } catch (error) {
        const failure = error as { name?: string; message?: string } | null;
        if (failure?.name === 'AbortError' || sequence !== hintSequence) return;
        publish({
          session: {
            hintPending: false,
            engineError: failure?.message ?? 'RPSFish could not answer.',
          },
        });
      }
    },

    /**
     * Offer the bot a draw. Its answer depends on how the position looks from
     * its own side, tuned by `manners.acceptDrawWithinArmies`.
     */
    offerBotDraw: async () => {
      const { botGame, botHistory, botSession } = get();
      if (!activeBot || !botSession || !botGame || botGame.status !== 'InProgress') return;
      if (botSession.drawOfferUsedBy === botSession.playerColor) return;
      publish({
        session: {
          drawNotice: null,
          drawOfferUsedBy: botSession.playerColor,
          drawOfferedBy: botSession.playerColor,
        },
      });

      let scoreForBot: number | null = null;
      try {
        const analysis = await activeBot.search(botGame, { history: botHistory });
        // The search speaks from the point of view of the side to move, which
        // on a draw offer is the player. The bot judges the mirror image.
        const score = analysis?.lines?.[0]?.score ?? analysis?.score;
        if (typeof score === 'number') scoreForBot = -score;
      } catch {
        // An unanswerable position is declined below, and the player keeps
        // their once-per-move offer spent either way.
      }
      const current = get().botSession;
      const currentGame = get().botGame;
      if (!current || !currentGame || current.gameId !== botSession.gameId) return;
      if (currentGame.status !== 'InProgress') return;

      if (activeBot.acceptsDraw(currentGame, scoreForBot)) {
        finish('Neutral', 'draw_agreement');
        return;
      }
      publish({
        session: {
          drawNotice: `${current.botName} declined the draw.`,
          drawOfferedBy: undefined,
        },
      });
    },

    resignBotGame: () => {
      const session = get().botSession;
      if (!session || get().botGame?.status !== 'InProgress') return;
      finish(session.botColor, 'resignation');
    },

    /** Close the bot game and tell the lobby this player is free again. */
    endBotSession: () => {
      if (!get().botSession) return;
      cancelBotWork();
      activeBot = null;
      send(get().socket, { type: 'bot_session_end' });
      set({
        ...initialBotState,
        gameState: null,
        lastMove: null,
        playerColor: null,
        selectedTile: null,
        validMoves: [],
      });
    },

    /**
     * The finished bot game as a record, in the archive's own dialect.
     *
     * A bot game never reaches the server, so this is the only record it will
     * ever have. Writing it in the same format the archive uses means the
     * review screen reads one format rather than two.
     */
    botGamePGN: () => {
      const { botGame, botHistory, botMoves, botSession, account, accountId } = get();
      if (!botSession || !botGame || botMoves.length === 0) return null;
      const start = botHistory[0] ?? botGame;
      // 'Guest' is the placeholder the rest of the app already knows how to
      // read as "the person at this browser".
      const human = account?.username?.trim() || 'Guest';
      const names: Record<SideColor, string> = {
        [botSession.playerColor]: human,
        [botSession.botColor]: botSession.botName,
      } as Record<SideColor, string>;
      const ids: Record<SideColor, string> = {
        [botSession.playerColor]: accountId,
        [botSession.botColor]: `bot:${botSession.profileId}`,
      } as Record<SideColor, string>;
      return encodePGN({
        tags: [
          { name: 'Event', value: 'Bot practice' },
          { name: 'Site', value: 'RPS Strategy' },
          { name: 'Date', value: new Date(botSession.startedAtUnixMs).toISOString().slice(0, 10).replace(/-/g, '.') },
          { name: 'Red', value: names.Red },
          { name: 'Blue', value: names.Blue },
          { name: 'Result', value: resultFor(botGame.status, botGame.winner) },
          { name: 'GameId', value: botSession.gameId },
          { name: 'Variant', value: botGame.mode.name },
          { name: 'ModeId', value: botGame.mode.id },
          { name: 'BoardSize', value: '9' },
          { name: 'SetUp', value: '1' },
          { name: 'FEN', value: encodePosition(start.grid, 'Red') },
          { name: 'RedId', value: ids.Red },
          { name: 'BlueId', value: ids.Blue },
          { name: 'Ranked', value: 'false' },
          { name: 'EndReason', value: botGame.endReason ?? '' },
          { name: 'BotProfile', value: botSession.profileId },
          { name: 'BotRating', value: String(botSession.botRating) },
        ],
        moves: botMoves,
        endReason: botGame.endReason,
        winner: botGame.winner,
        result: resultFor(botGame.status, botGame.winner),
      });
    },

    // A reconnect loses the server's memory of this session, so presence is
    // re-announced from `connection_ready`.
    announceBotPresence: () => {
      const session = get().botSession;
      if (session) send(get().socket, { type: 'bot_session_start', modeId: session.modeId });
    },
  };
};
