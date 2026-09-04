import type { ActiveGame, GameStore } from './types';
import {
  applyAnalysisMove,
  createAnalysisGame,
  validMovesFor,
  type AnalysisGame,
} from '@/engine/analysisGame';
import { inferMoveBetweenGrids } from '@/engine/moveDiff';
import { openingLineOf } from '@/engine/openingLine';
import { encodePGN, encodePosition, resultFor, type WritableMove } from '@/engine/pgn';
import {
  FIRST_TO_MOVE,
  opposingColor,
  samePosition,
  type GameEndReason,
  type ModeDefinition,
  type Move,
  type PlayerColor,
  type PlayerProfile,
  type Position,
  type SideColor,
} from '@/types/game';
import type { StateCreator } from 'zustand';

// Two people, one device, no server.
//
// The bot session next door already proved the shape: run the rules from
// `engine/analysisGame.ts`, publish a server-shaped `gameState`, and let the
// live board render it without knowing where it came from. This is that with
// the opponent taken out — nobody is thinking in a worker, so there is no turn
// to wait for and no side the person at the keyboard owns.
//
// It is the only game in the app that sends the server nothing at all. A bot
// game still announces itself so the lobby can count who is busy; this one has
// no such traffic, which is what makes it work with the socket down.

/** Everything about a local game that is not the board itself. */
export interface LocalSessionState {
  gameId: string;
  modeId: string;
  startedAtUnixMs: number;
  /**
   * The side the board is drawn from.
   *
   * Turned by the player, never by the turn. Auto-flipping to face whoever is
   * to move is the obvious thing to do with a device on a table between two
   * people, and it is wrong for the far commoner case of two people sitting
   * side by side: the board would spin under a hand already reaching for it.
   * So the orientation moves when somebody asks for it and not otherwise.
   */
  viewColor: SideColor;
}

/** One move of a local game, kept so the game can be written out as a record. */
export interface LocalMove extends WritableMove {
  player: SideColor;
}

// A local game has no accounts on either side of it, and inventing one for the
// browser's own player would be a lie on the seat the other person is using.
// The seats are named after the colours instead, which is also how the record
// and the review screen will read them back.
const seatProfile = (color: SideColor): PlayerProfile => ({
  userId: `local:${color.toLowerCase()}`,
  username: color,
  discord: '',
});

// No clock and no rating, so the fields a server game would fill are null —
// exactly as a bot game leaves them, and every consumer already reads a missing
// clock as "no clock to show".
const toGameState = (
  game: AnalysisGame,
  session: LocalSessionState,
  moves: LocalMove[],
): ActiveGame => ({
  bluePlayer: seatProfile('Blue'),
  clock: null,
  currentTurn: game.currentTurn,
  // A draw here is agreed by one person on behalf of both, so there is never an
  // offer on the table waiting to be answered.
  drawOfferedBy: undefined,
  drawOfferUsedBy: undefined,
  endReason: game.endReason ?? undefined,
  gameId: session.gameId,
  grid: game.grid,
  local: { viewColor: session.viewColor },
  mode: game.mode,
  moveNumber: game.moveNumber,
  // Written here rather than received, because nothing on the server knows
  // this game is happening. A shared board always starts from the mode's own
  // opening, so the moves as played are the line.
  openingLine: openingLineOf(moves),
  redPlayer: seatProfile('Red'),
  status: game.status,
  timeControl: null,
  timeOfferedBy: undefined,
  timeOfferUsedBy: undefined,
  winner: game.winner,
});

/** What a local game contributes to the store. */
export interface LocalState {
  localSession: LocalSessionState | null;
  localGame: AnalysisGame | null;
  localHistory: AnalysisGame[];
  localMoves: LocalMove[];
}

export interface LocalActions {
  startLocalGame: (options: { mode?: ModeDefinition | null; viewColor?: SideColor }) => void;
  restartLocalGame: () => void;
  localSelectTile: (position: Position) => void;
  localMovePiece: (from: Position, to: Position) => void;
  undoLocalMove: () => void;
  flipLocalBoard: () => void;
  drawLocalGame: () => void;
  resignLocalGame: () => void;
  endLocalSession: () => void;
  localGamePGN: () => string | null;
}

export type LocalSlice = LocalState & LocalActions;

export const initialLocalState: LocalState = {
  localSession: null,
  localGame: null,
  localHistory: [],
  // The moves as played. Nothing on the server knows this game happened, so if
  // the browser does not keep the move list there is nothing to review.
  localMoves: [],
};

/** One publish: the rules state, and whichever pieces of board state moved. */
interface PublishPatch {
  session?: Partial<LocalSessionState>;
  localGame?: AnalysisGame;
  localHistory?: AnalysisGame[];
  localMoves?: LocalMove[];
  lastMove?: Move | null;
  selectedTile?: Position | null;
  validMoves?: Position[];
}

export const createLocalSlice: StateCreator<GameStore, [], [], LocalSlice> = (set, get) => {
  // Rebuilds the public snapshot from the private rules state. Every local
  // action ends here so the screen only ever sees consistent state.
  const publish = (patch: PublishPatch = {}) => {
    const { localGame, localMoves, localSession } = get();
    if (!localSession || !localGame) return;
    const session = { ...localSession, ...(patch.session ?? {}) };
    const game = patch.localGame ?? localGame;
    const moves = patch.localMoves ?? localMoves;
    set({
      localSession: session,
      localGame: game,
      ...(patch.localHistory ? { localHistory: patch.localHistory } : {}),
      ...(patch.localMoves ? { localMoves: patch.localMoves } : {}),
      gameState: toGameState(game, session, moves),
      ...(patch.lastMove !== undefined ? { lastMove: patch.lastMove } : {}),
      ...(patch.selectedTile !== undefined ? { selectedTile: patch.selectedTile } : {}),
      ...(patch.validMoves !== undefined ? { validMoves: patch.validMoves } : {}),
    });
  };

  const finish = (winner: PlayerColor, endReason: GameEndReason) => {
    const game = get().localGame;
    if (!game || game.status !== 'InProgress') return;
    publish({
      localGame: { ...game, status: 'Finished', winner, endReason },
      selectedTile: null,
      validMoves: [],
    });
  };

  // Applies a legal move for whichever side is to move. Which is every side:
  // the person at the keyboard is playing both of them.
  const applyMove = (from: Position, to: Position) => {
    const { localGame, localHistory, localMoves } = get();
    if (!localGame) return false;
    const source = localGame.grid[from.y]?.[from.x];
    const destination = localGame.grid[to.y]?.[to.x];
    if (!source || !destination || source.occupant === 'Empty') return false;
    const result = applyAnalysisMove(localGame, from, to);
    if (!result) return false;
    publish({
      localGame: result.game,
      localHistory: [...localHistory, localGame],
      localMoves: [
        ...localMoves,
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
    });
    return true;
  };

  return {
    ...initialLocalState,

    /**
     * Open a game both players share. Nothing is sent anywhere, which is what
     * lets this start — and finish — with no connection at all.
     */
    startLocalGame: ({ mode, viewColor = FIRST_TO_MOVE }) => {
      if (!mode) {
        set({ error: 'Choose a game mode before starting a local game.' });
        return;
      }
      // A server game owns the board and the persisted session id, so it is
      // never replaced by a local one.
      const current = get().gameState;
      if (current && !current.local) {
        set({ error: 'Leave your current game before starting a local one.' });
        return;
      }
      const game = createAnalysisGame(mode);
      const session: LocalSessionState = {
        // A fresh identifier per game so the board, the move sounds, and the
        // outcome card all treat a rematch as a new game.
        gameId: `local-${mode.id}-${Date.now()}`,
        modeId: mode.id,
        startedAtUnixMs: Date.now(),
        // The board is drawn from the side that opens by default, so the first
        // player to move is the one facing the right way up. A rematch passes
        // back whichever way round the players had turned it, because they have
        // not moved.
        viewColor,
      };

      set({
        localSession: session,
        localGame: game,
        localHistory: [],
        localMoves: [],
        // Nobody at this board owns a colour, and the screen reads `local`
        // rather than this to decide who may move.
        playerColor: null,
        isSpectating: false,
        spectatedGameId: null,
        lastMove: null,
        selectedTile: null,
        validMoves: [],
        opponentReconnectDeadline: null,
        chatMessages: [],
        chatRoomId: null,
        chatOccupancy: 0,
        error: null,
      });
      publish();
    },

    /** Same mode, fresh board, and the orientation the last game ended on. */
    restartLocalGame: () => {
      const { localGame, localSession } = get();
      if (!localSession || !localGame) return;
      get().startLocalGame({ mode: localGame.mode, viewColor: localSession.viewColor });
    },

    localSelectTile: (position) => {
      const { localGame, localSession, selectedTile, validMoves } = get();
      if (!localSession || !localGame || localGame.status !== 'InProgress') return;

      if (selectedTile && validMoves.some((move) => samePosition(move, position))) {
        applyMove(selectedTile, position);
        return;
      }
      if (selectedTile && samePosition(selectedTile, position)) {
        publish({ selectedTile: null, validMoves: [] });
        return;
      }
      const moves = validMovesFor(localGame, position);
      publish({
        selectedTile: moves.length > 0 ? position : null,
        validMoves: moves,
      });
    },

    localMovePiece: (from, to) => {
      const { localGame, localSession } = get();
      if (!localSession || !localGame || localGame.status !== 'InProgress') return;
      applyMove(from, to);
    },

    /**
     * Take back the last move, whoever played it.
     *
     * One move rather than the bot board's two: there is no reply to undo, and
     * a player who wants the position from before their opponent's move can
     * press it again.
     */
    undoLocalMove: () => {
      const { localHistory, localSession } = get();
      if (!localSession || localHistory.length === 0) return;

      const history = [...localHistory];
      const game = history.pop();
      if (!game) return;
      const previous = history[history.length - 1];
      // One move per history entry, so the record stays a description of the
      // board that is actually on screen.
      set({ localHistory: history, localMoves: get().localMoves.slice(0, history.length) });
      publish({
        localGame: game,
        lastMove: previous ? inferMoveBetweenGrids(previous.grid, game.grid) : null,
        selectedTile: null,
        validMoves: [],
      });
    },

    /** Turn the board around, for the player sitting on the other side of it. */
    flipLocalBoard: () => {
      const session = get().localSession;
      if (!session) return;
      publish({ session: { viewColor: opposingColor(session.viewColor) } });
    },

    /**
     * Agree a draw.
     *
     * One press rather than an offer and an acceptance: the two players are in
     * the same room, so the negotiation happened out loud before anybody
     * touched the screen, and a button that asks the other half of the same
     * person to confirm is ceremony rather than consent.
     */
    drawLocalGame: () => finish('Neutral', 'draw_agreement'),

    /** The side to move resigns, which is the only side that can. */
    resignLocalGame: () => {
      const game = get().localGame;
      if (!game || game.status !== 'InProgress' || game.currentTurn === 'Neutral') return;
      finish(opposingColor(game.currentTurn), 'resignation');
    },

    /** Close the local game. Nothing to tell anybody: nobody was told. */
    endLocalSession: () => {
      if (!get().localSession) return;
      set({
        ...initialLocalState,
        gameState: null,
        lastMove: null,
        playerColor: null,
        selectedTile: null,
        validMoves: [],
      });
    },

    /**
     * The finished local game as a record, in the archive's own dialect.
     *
     * The same reasoning as `botGamePGN`: this game will never reach a server,
     * so this is the only record it will ever have, and writing it in the
     * archive's format means the review screen reads one format rather than
     * three.
     */
    localGamePGN: () => {
      const { localGame, localHistory, localMoves, localSession } = get();
      if (!localSession || !localGame || localMoves.length === 0) return null;
      const start = localHistory[0] ?? localGame;
      return encodePGN({
        tags: [
          { name: 'Event', value: 'Local game' },
          { name: 'Site', value: 'RPS Strategy' },
          {
            name: 'Date',
            value: new Date(localSession.startedAtUnixMs)
              .toISOString()
              .slice(0, 10)
              .replace(/-/g, '.'),
          },
          { name: 'Red', value: 'Red' },
          { name: 'Blue', value: 'Blue' },
          { name: 'Result', value: resultFor(localGame.status, localGame.winner) },
          { name: 'GameId', value: localSession.gameId },
          { name: 'Variant', value: localGame.mode.name },
          { name: 'ModeId', value: localGame.mode.id },
          { name: 'BoardSize', value: '9' },
          { name: 'SetUp', value: '1' },
          { name: 'FEN', value: encodePosition(start.grid, start.currentTurn) },
          { name: 'RedId', value: 'local:red' },
          { name: 'BlueId', value: 'local:blue' },
          { name: 'Ranked', value: 'false' },
          { name: 'EndReason', value: localGame.endReason ?? '' },
        ],
        moves: localMoves,
        endReason: localGame.endReason,
        winner: localGame.winner,
        result: resultFor(localGame.status, localGame.winner),
      });
    },
  };
};
