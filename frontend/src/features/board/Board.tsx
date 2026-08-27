import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated as NativeAnimated,
  Easing,
  Image,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import Svg, { Defs, Line, Marker, Polygon } from 'react-native-svg';

import PieceIcon from './PieceIcon';
import { usePieceDrag } from './pieceDrag';
import TileMark from './TileMark';
import { overlayCellAt, type BoardOverlay } from './overlay';
import { tintForTile } from './tint';
import MoveQualityBadge from '@/features/analysis/MoveQualityBadge';
import {
  animatedReplayPieceTracks,
  buildReplayPieceTracks,
  replayGridSignature,
  type PieceTrack,
  type ReplayTracks,
} from '@/engine/replayAnimation';
import type { MoveGrade } from '@/engine/gameReview';
import type { PieceLook } from './pieceLook';
import { board, players, shadows } from '@/theme';
import {
  samePosition,
  sameMove,
  type Grid,
  type ModeID,
  type Move,
  type PlayerColor,
  type Position,
  type Tile,
} from '@/types/game';

// Files and ranks as the archive writes them, so a square named on the
// board is the square named in the game's PGN. Twenty-six letters because a
// mode may be any rectangle up to that wide; the built-in modes use the first
// nine.
const FILES = 'abcdefghijklmnopqrstuvwxyz';

/**
 * The board's shape in tiles.
 *
 * Read off the grid rather than assumed, because a mode may be any rectangle.
 * Every piece of geometry below takes one of these: a percentage is `100 /
 * columns` across and `100 / rows` down, and the two are only the same number
 * on a square board.
 */
interface BoardShape {
  columns: number;
  rows: number;
}

const shapeOf = (grid: Grid): BoardShape => ({
  columns: grid[0]?.length ?? 0,
  rows: grid.length,
});

const columnPercent = ({ columns }: BoardShape) => (columns > 0 ? 100 / columns : 100);
const rowPercent = ({ rows }: BoardShape) => (rows > 0 ? 100 / rows : 100);

/**
 * One tile's side in pixels.
 *
 * `boardSize` is the square the layout set aside for the board, so a
 * non-square board fits inside it by its longer side and leaves the rest of
 * that square empty. Tiles stay square, which is what keeps every piece,
 * badge and dot circular.
 */
const squareSizeFor = (boardSize: number, shape: BoardShape) =>
  (boardSize - BOARD_BORDER_WIDTH * 2) / Math.max(shape.columns, shape.rows, 1);

/** The frame's real pixel size, which is the square only when the board is. */
const frameSizeFor = (boardSize: number, shape: BoardShape) => {
  const square = squareSizeFor(boardSize, shape);
  return {
    width: square * shape.columns + BOARD_BORDER_WIDTH * 2,
    height: square * shape.rows + BOARD_BORDER_WIDTH * 2,
  };
};

/**
 * What the board is called to a screen reader.
 *
 * The standard board keeps its exact old wording. That is not sentiment: it is
 * the handle everything addressing the board by label already uses, and a
 * rename would break those silently rather than loudly.
 */
const boardShapeLabel = ({ columns, rows }: BoardShape) =>
  columns === 9 && rows === 9 ? 'Nine by nine' : `${columns} by ${rows}`;
const ANNOTATION_COLOR = board.annotation;
const RIGHT_BUTTON = 2;
const RIGHT_BUTTON_MASK = 2;
const IS_WEB = Platform.OS === 'web';

/**
 * A mouse event, as either platform delivers it.
 *
 * React Native Web passes a synthetic event with the real one on
 * `nativeEvent`; a plain DOM listener passes the real one directly. Only the
 * four fields the annotation layer reads are named.
 */
interface MouseSource {
  button?: number;
  buttons?: number;
  clientX: number;
  clientY: number;
}

type MouseLikeEvent = MouseSource & { nativeEvent?: MouseSource };

/**
 * Style properties React Native's own `ViewStyle` has no name for, which React
 * Native Web passes through to CSS. `grab` and `grabbing` are what a draggable
 * piece should show, and `touch-action: none` is what keeps a touch that starts
 * on a piece from scrolling the page behind it — the browser's half of what
 * `pieceDrag.ts` does for iOS, and better than a flag because the browser is
 * told before the finger moves rather than in reply to it.
 */
const webDragStyle = (cursor: 'grab' | 'grabbing') =>
  ({ cursor, touchAction: 'none' } as unknown as ViewStyle);
const BOARD_BORDER_WIDTH = 3;
const MOVE_ANIMATION_DURATION = 230;
// A catch-up finishes before even the fastest watched bot can make its next
// move (250ms), so reaching the live edge never makes the board fall behind.
const FAST_REPLAY_MAX_DURATION = 220;
const FAST_REPLAY_MIN_DURATION = 72;
const FAST_REPLAY_MOVE_DURATION = 12;

const displayCenter = (value: number, isFlipped: boolean, extent: number) =>
  (isFlipped ? extent - 1 - value : value) + 0.5;

const displayCoordinate = (value: number, isFlipped: boolean, extent: number) =>
  isFlipped ? extent - 1 - value : value;

const pieceSizeForBoard = (boardSize: number) => Math.max(20, Math.min(46, boardSize / 12));
const moveBadgeSizeForBoard = (boardSize: number, shape: BoardShape) =>
  Math.round(Math.max(13, Math.min(22, squareSizeFor(boardSize, shape) * 0.36)));

const positionFromDrag = (
  from: Position,
  dx: number,
  dy: number,
  boardSize: number,
  isFlipped: boolean,
  shape: BoardShape,
): Position => {
  const squareSize = squareSizeFor(boardSize, shape);
  const displayXOffset = Math.round(dx / squareSize);
  const displayYOffset = Math.round(dy / squareSize);
  const direction = isFlipped ? -1 : 1;
  const to = {
    x: from.x + displayXOffset * direction,
    y: from.y + displayYOffset * direction,
  };

  if (to.x < 0 || to.x >= shape.columns || to.y < 0 || to.y >= shape.rows) {
    return from;
  }
  return to;
};

/** A DOM-ish rectangle, as `getBoundingClientRect` returns on the web. */
interface SurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const positionFromClientPoint = (
  rect: SurfaceRect | null | undefined,
  clientX: number,
  clientY: number,
  isFlipped: boolean,
  shape: BoardShape,
): Position | null => {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;

  const displayX = Math.floor(((clientX - rect.left) / rect.width) * shape.columns);
  const displayY = Math.floor(((clientY - rect.top) / rect.height) * shape.rows);
  if (
    displayX < 0 ||
    displayX >= shape.columns ||
    displayY < 0 ||
    displayY >= shape.rows
  ) {
    return null;
  }

  return isFlipped
    ? { x: shape.columns - 1 - displayX, y: shape.rows - 1 - displayY }
    : { x: displayX, y: displayY };
};

interface DraggablePieceProps {
  boardSize: number;
  shape: BoardShape;
  look?: PieceLook;
  boardX: number;
  boardY: number;
  dragEnabled: boolean;
  displayX: number;
  displayY: number;
  isFlipped: boolean;
  isHidden: boolean;
  isSelected: boolean;
  onDragActiveChange: (active: boolean) => void;
  onDragEnd: (from: Position, to: Position) => void;
  onDragStart: (position: Position) => void;
  tile: Tile;
}

const DraggablePiece = memo(function DraggablePiece({
  boardSize,
  shape,
  look,
  boardX,
  boardY,
  dragEnabled,
  displayX,
  displayY,
  isFlipped,
  isHidden,
  isSelected,
  onDragActiveChange,
  onDragEnd,
  onDragStart,
  tile,
}: DraggablePieceProps) {
  const translation = useRef(new NativeAnimated.ValueXY()).current;
  const [isDragging, setIsDragging] = useState(false);
  const pieceSize = pieceSizeForBoard(boardSize);

  const resetPosition = useCallback(() => {
    NativeAnimated.spring(translation, {
      toValue: { x: 0, y: 0 },
      damping: 18,
      stiffness: 260,
      mass: 0.55,
      useNativeDriver: false,
    }).start();
  }, [translation]);

  // A PanResponder accumulates `gesture.dx`/`dy` on the instance it granted
  // with, so rebuilding one mid-drag restarts the offset at zero and snaps the
  // piece back to its square. The board re-renders for reasons that have
  // nothing to do with the drag (the server broadcasts player counts every two
  // seconds), so the responder is built once and reads everything it needs from
  // a ref instead of from the closure.
  const latest = useRef({
    boardSize,
    shape,
    dragEnabled,
    isFlipped,
    onDragActiveChange,
    onDragEnd,
    onDragStart,
    position: { x: boardX, y: boardY },
  });
  latest.current = {
    boardSize,
    shape,
    dragEnabled,
    isFlipped,
    onDragActiveChange,
    onDragEnd,
    onDragStart,
    position: { x: boardX, y: boardY },
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => latest.current.dragEnabled,
        onMoveShouldSetPanResponder: (_, gesture) =>
          latest.current.dragEnabled &&
          Math.abs(gesture.dx) + Math.abs(gesture.dy) > 4,
        onPanResponderGrant: () => {
          setIsDragging(true);
          // Announced on the grant rather than on the first movement, which is
          // the whole point: the page has to stop scrolling before the finger
          // moves, not after it already has.
          latest.current.onDragActiveChange(true);
          latest.current.onDragStart(latest.current.position);
        },
        onPanResponderMove: (_, gesture) => {
          translation.setValue({ x: gesture.dx, y: gesture.dy });
        },
        onPanResponderRelease: (_, gesture) => {
          const { position } = latest.current;
          const to = positionFromDrag(
            position,
            gesture.dx,
            gesture.dy,
            latest.current.boardSize,
            latest.current.isFlipped,
            latest.current.shape,
          );
          setIsDragging(false);
          latest.current.onDragActiveChange(false);
          latest.current.onDragEnd(position, to);
          resetPosition();
        },
        onPanResponderTerminate: () => {
          setIsDragging(false);
          latest.current.onDragActiveChange(false);
          resetPosition();
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [resetPosition, translation],
  );

  return (
    <View
      style={[
        styles.pieceLayout,
        {
          height: `${rowPercent(shape)}%`,
          left: `${displayX * columnPercent(shape)}%`,
          top: `${displayY * rowPercent(shape)}%`,
          width: `${columnPercent(shape)}%`,
        },
        isHidden && styles.hiddenPieceLayout,
        isSelected && styles.selectedPieceLayout,
        isDragging && styles.draggingPieceLayout,
      ]}
    >
      <NativeAnimated.View
        {...panResponder.panHandlers}
        style={[
          styles.piece,
          dragEnabled && styles.draggablePiece,
          isDragging && styles.draggingPiece,
          {
            pointerEvents: dragEnabled ? 'auto' : 'none',
            transform: [
              ...translation.getTranslateTransform(),
              { scale: isDragging ? 1.14 : isSelected ? 1.08 : 1 },
            ],
          },
        ]}
      >
        <PieceIcon
          color={tile.occupantOwner}
          dropShadow={isDragging}
          piece={tile.occupant}
          look={look}
          size={pieceSize}
        />
      </NativeAnimated.View>
    </View>
  );
});

const replayPieceOpacity = (
  progress: NativeAnimated.Value,
  track: PieceTrack,
  steps: number,
): NativeAnimated.AnimatedInterpolation<number> | number => {
  const fade = 0.05;
  const appears = track.startStep > 0;
  const disappears = track.endStep < steps;
  if (!appears && !disappears) return 1;

  if (appears && disappears) {
    return progress.interpolate({
      inputRange: [
        0,
        track.startStep - fade,
        track.startStep,
        track.endStep - fade,
        track.endStep,
        steps,
      ],
      outputRange: [0, 0, 1, 1, 0, 0],
    });
  }
  if (appears) {
    return progress.interpolate({
      inputRange: [0, track.startStep - fade, track.startStep],
      outputRange: [0, 0, 1],
      extrapolate: 'clamp',
    });
  }
  return progress.interpolate({
    inputRange: [0, track.endStep - fade, track.endStep, steps],
    outputRange: [1, 1, 0, 0],
  });
};

interface ReplayPieceProps {
  boardSize: number;
  shape: BoardShape;
  pieceLooks?: Record<string, PieceLook>;
  isFlipped: boolean;
  progress: NativeAnimated.Value;
  steps: number;
  track: PieceTrack;
}

const ReplayPiece = memo(function ReplayPiece({
  boardSize,
  shape,
  pieceLooks,
  isFlipped,
  progress,
  steps,
  track,
}: ReplayPieceProps) {
  const pieceSize = pieceSizeForBoard(boardSize);
  const squareSize = squareSizeFor(boardSize, shape);
  // A track carries a null for every step it is off the board; the slice
  // between its own start and end is exactly the run where it is on.
  const positions = track.positions
    .slice(track.startStep, track.endStep + 1)
    .filter((position): position is Position => position !== null);
  const first = positions[0];
  const inputRange = positions.map((unused, index) => track.startStep + index);
  const offsetFor = (position: Position, axis: 'x' | 'y') => {
    const extent = axis === 'x' ? shape.columns : shape.rows;
    return (
      (displayCoordinate(position[axis], isFlipped, extent) -
        displayCoordinate(first ? first[axis] : 0, isFlipped, extent)) *
      squareSize
    );
  };
  const translate = (axis: 'x' | 'y') => {
    if (inputRange.length < 2) return 0;
    return progress.interpolate({
      inputRange,
      outputRange: positions.map((position) => offsetFor(position, axis)),
      extrapolate: 'clamp',
    });
  };

  if (!first) return null;

  return (
    <NativeAnimated.View
      pointerEvents="none"
      style={[
        styles.pieceLayout,
        styles.movingPieceLayout,
        {
          height: `${rowPercent(shape)}%`,
          left: `${displayCoordinate(first.x, isFlipped, shape.columns) * columnPercent(shape)}%`,
          opacity: replayPieceOpacity(progress, track, steps),
          top: `${displayCoordinate(first.y, isFlipped, shape.rows) * rowPercent(shape)}%`,
          width: `${columnPercent(shape)}%`,
          transform: [
            { translateX: translate('x') },
            { translateY: translate('y') },
          ],
        },
      ]}
    >
      <PieceIcon
        piece={track.piece}
        color={track.color}
        look={track.piece ? pieceLooks?.[track.piece] : undefined}
        size={pieceSize}
      />
    </NativeAnimated.View>
  );
});

/** One animation from one board to another, and how long it should take. */
interface ReplayTransitionState extends ReplayTracks {
  duration: number;
  key: string;
}

interface ReplayTransitionProps {
  boardSize: number;
  shape: BoardShape;
  pieceLooks?: Record<string, PieceLook>;
  isFlipped: boolean;
  onComplete: (key: string) => void;
  transition: ReplayTransitionState;
}

const ReplayTransition = memo(function ReplayTransition({
  boardSize,
  shape,
  pieceLooks,
  isFlipped,
  onComplete,
  transition,
}: ReplayTransitionProps) {
  const progress = useRef(new NativeAnimated.Value(0)).current;

  useEffect(() => {
    progress.setValue(0);
    const animation = NativeAnimated.timing(progress, {
      toValue: transition.steps,
      duration: transition.duration,
      easing: transition.steps === 1 ? Easing.out(Easing.cubic) : Easing.linear,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) onComplete(transition.key);
    });
    return () => animation.stop();
  }, [onComplete, progress, transition]);

  return transition.tracks.map((track) => (
    <ReplayPiece
      boardSize={boardSize}
      shape={shape}
      pieceLooks={pieceLooks}
      isFlipped={isFlipped}
      key={track.id}
      progress={progress}
      steps={transition.steps}
      track={track}
    />
  ));
});

/**
 * A corner note's text style, given how many lines are stacked there.
 *
 * Three lines of the one-line size run into the piece on a small board, so the
 * size and the leading come down as the stack grows. Stated as a function
 * rather than three styles because the base size is already a function of the
 * board.
 */
const overlayLabelText = (size: number, lines: number) => {
  const fontSize = lines > 2 ? size - 1 : size;
  return { fontSize, lineHeight: fontSize + 1 };
};

/** One ranked engine suggestion, drawn as an arrow. */
export interface AnalysisArrow extends Move {}

export interface BoardProps {
  /** Up to three ranked engine suggestions, best first. */
  analysisArrows?: AnalysisArrow[];
  boardSize: number;
  /** Whether pieces of `movableColor` can be dragged. */
  canMove: boolean;
  grid: Grid;
  lastMove: Move | null;
  /** The grade of `lastMove`, badged on its destination square. */
  lastMoveGrade?: MoveGrade | null;
  modeId?: ModeID;
  /**
   * How each kind is drawn, for a mode that declared its own kinds: the
   * artwork it borrows, and the letter it falls back to without one. Absent for
   * the built-in modes, whose ids name their own artwork. See `looksFor`.
   */
  pieceLooks?: Record<string, PieceLook>;
  /**
   * A picture painted under the whole board.
   *
   * Nothing sets it today: no mode carries artwork. Kept because the board
   * already draws it correctly, so a mode format that brings one back needs no
   * change here.
   */
  boardBackground?: string;
  /**
   * Whose pieces may move, when that is not the viewer's own colour — an
   * analysis board where one person plays both sides.
   */
  movableColor?: PlayerColor | null;
  onPieceDrop: (from: Position, to: Position) => void;
  onTilePress: (position: Position) => void;
  /**
   * A finished decoration for every square, from an analysis outside the board.
   *
   * Drawn under the board's own marks and under the pieces, because it is
   * context rather than a control. See `./overlay.ts`.
   */
  overlay?: BoardOverlay | null;
  /** The side the board is drawn from. Blue sees it flipped. */
  playerColor: PlayerColor | null;
  /**
   * Where along `replayPositions` the board is standing. Together they let a
   * jump of several moves animate through the positions in between rather than
   * cutting straight to the destination.
   */
  replayIndex?: number | null;
  replayPositions?: ({ grid: Grid } | Grid)[] | null;
  selectedTile: Position | null;
  validMoves: Position[];
}

export default function Board({
  analysisArrows = [],
  boardSize,
  canMove,
  grid,
  lastMove,
  lastMoveGrade = null,
  modeId,
  pieceLooks,
  boardBackground,
  movableColor,
  onPieceDrop,
  onTilePress,
  overlay = null,
  playerColor,
  replayIndex = null,
  replayPositions = null,
  selectedTile,
  validMoves,
}: BoardProps) {
  // A background that will not load leaves nothing behind on react-native-web —
  // an <Image> paints through the wrapper's background-image, so a failed one is
  // silent — which is the right degradation but has to be a decision. Keyed by
  // URL rather than a flag, so a mode whose picture changes tries the new one.
  const [backgroundFailed, setBackgroundFailed] = useState<string | null>(null);
  const overArt = Boolean(boardBackground) && boardBackground !== backgroundFailed;

  const isFlipped = playerColor === 'Blue';
  // The board's shape comes from the grid it was handed. Nothing here may
  // assume nine: a spec-defined mode is any rectangle, and the frame below
  // sizes itself to fit inside the square the layout set aside.
  const shape = shapeOf(grid);
  const frameSize = frameSizeFor(boardSize, shape);
  const moveBadgeSize = moveBadgeSizeForBoard(boardSize, shape);
  // The overlay's numbers have to stay legible on a 280px analysis board and
  // stay out of the way on a 620px one, the same problem `moveBadgeSizeForBoard`
  // solves for the grade badge.
  const overlayLabelSize = Math.max(8, Math.round(boardSize / 62));
  const activeMoveColor = movableColor ?? playerColor;
  const validMoveKeys = new Set(validMoves.map(({ x, y }) => `${x}:${y}`));
  const displayedGrid = useMemo(() => {
    if (!isFlipped) return grid;
    return [...grid].reverse().map((row) => [...row].reverse());
  }, [grid, isFlipped]);

  const handleDragStart = useCallback(
    (position: Position) => {
      onTilePress(position);
    },
    [onTilePress],
  );

  // The pages that put a board inside a ScrollView read this and stop
  // scrolling. Stable, so the memoized responder in each piece never has to be
  // rebuilt for it, and it is the board that knows this rather than the piece:
  // a piece knows it is being dragged, not that it is inside a page.
  const handleDragActiveChange = useCallback((active: boolean) => {
    usePieceDrag.getState().setDragging(active);
  }, []);

  // A board that goes away mid-drag — a finished game replaced by its review,
  // or a navigation — would otherwise leave the page unable to scroll.
  useEffect(
    () => () => {
      usePieceDrag.getState().setDragging(false);
    },
    [],
  );

  const handleDragEnd = useCallback(
    (from: Position, to: Position) => {
      if (!samePosition(from, to)) onPieceDrop(from, to);
    },
    [onPieceDrop],
  );

  // Web only: the annotation layer needs the board's screen rectangle to turn
  // a mouse position into a square, which React Native's View type has no
  // notion of.
  const surfaceRef = useRef<(View & { getBoundingClientRect?: () => SurfaceRect }) | null>(null);
  const arrowOrigin = useRef<Position | null>(null);
  const [highlights, setHighlights] = useState<Position[]>([]);
  const [arrows, setArrows] = useState<Move[]>([]);
  const [pendingArrow, setPendingArrow] = useState<Move | null>(null);

  const positionSignature = useMemo(
    () => replayGridSignature(grid),
    [grid],
  );
  const displayedPositionKey = Number.isInteger(replayIndex)
    ? `${replayIndex}:${positionSignature}`
    : positionSignature;
  const previousGrid = useRef(grid);
  const previousReplayIndex = useRef(replayIndex);
  const [replayTransition, setReplayTransition] = useState<ReplayTransitionState | null>(null);

  // Work out the requested transition during the render that receives the new
  // grid. Waiting until an effect to do this lets the destination position
  // flash first: on rewind that looks like B teleports back, then the previous
  // move A animates. Rendering this request immediately keeps the old position
  // on screen until B has actually travelled back to its origin.
  const before = previousGrid.current;
  const beforeIndex = previousReplayIndex.current;
  const beforeSignature = replayGridSignature(before);
  // Both indices, or neither: a board with no replay track behind it (a live
  // game) passes none, and then only the grid can say the position changed.
  const replayStep =
    Number.isInteger(beforeIndex) && Number.isInteger(replayIndex)
      ? { from: beforeIndex as number, to: replayIndex as number }
      : null;
  const replayIndexChanged = Boolean(replayStep && replayStep.from !== replayStep.to);
  const positionChanged =
    beforeSignature !== positionSignature || replayIndexChanged;
  let requestedReplayTransition: ReplayTransitionState | null = null;

  if (positionChanged) {
    let grids: Grid[] = [before, grid];
    if (replayStep && Math.abs(replayStep.to - replayStep.from) > 1 && Array.isArray(replayPositions)) {
      const direction = replayStep.to > replayStep.from ? 1 : -1;
      const candidate: Grid[] = [];
      for (
        let index = replayStep.from;
        direction > 0 ? index <= replayStep.to : index >= replayStep.to;
        index += direction
      ) {
        const position = replayPositions[index];
        const candidateGrid = Array.isArray(position) ? position : position?.grid;
        if (!Array.isArray(candidateGrid)) {
          candidate.length = 0;
          break;
        }
        candidate.push(candidateGrid);
      }
      const firstCandidate = candidate[0];
      const lastCandidate = candidate[candidate.length - 1];
      if (
        candidate.length > 1 &&
        firstCandidate &&
        lastCandidate &&
        replayGridSignature(firstCandidate) === beforeSignature &&
        replayGridSignature(lastCandidate) === positionSignature
      ) {
        grids = candidate;
      }
    }

    const replay = buildReplayPieceTracks(grids);
    if (replay) {
      const firstGrid = grids[0];
      const finalGrid = grids[grids.length - 1];
      requestedReplayTransition = {
        ...replay,
        tracks:
          firstGrid && finalGrid
            ? animatedReplayPieceTracks(replay, firstGrid, finalGrid)
            : replay.tracks,
        duration:
          replay.steps === 1
            ? MOVE_ANIMATION_DURATION
            : Math.min(
                FAST_REPLAY_MAX_DURATION,
                Math.max(FAST_REPLAY_MIN_DURATION, replay.steps * FAST_REPLAY_MOVE_DURATION),
              ),
        key: `${beforeIndex ?? 'board'}:${replayIndex ?? 'board'}:${beforeSignature}:${positionSignature}`,
      };
    }
  }

  useLayoutEffect(() => {
    previousGrid.current = grid;
    previousReplayIndex.current = replayIndex;
    if (positionChanged) setReplayTransition(requestedReplayTransition);
    // `requestedReplayTransition` is deliberately captured from the render
    // caused by these props. Adding it as a dependency would run this effect a
    // second time after the refs advance and immediately clear the animation.
  }, [grid, positionSignature, replayIndex, replayPositions]);

  const visibleReplayTransition = requestedReplayTransition ?? replayTransition;
  const displayedLastMove = visibleReplayTransition ? null : lastMove;
  const hiddenSettledPieceKeys = useMemo(() => {
    const hidden = new Set<string>();
    if (!visibleReplayTransition) return hidden;
    visibleReplayTransition.tracks.forEach((track) => {
      const position = track.positions[visibleReplayTransition.steps];
      if (position) hidden.add(`${position.x}:${position.y}`);
    });
    return hidden;
  }, [visibleReplayTransition]);

  const handleReplayTransitionComplete = useCallback((key: string) => {
    setReplayTransition((current) => (current?.key === key ? null : current));
  }, []);

  const clearAnnotations = useCallback(() => {
    arrowOrigin.current = null;
    setPendingArrow(null);
    setHighlights((current) => (current.length ? [] : current));
    setArrows((current) => (current.length ? [] : current));
  }, []);

  // Chess.com behaviour: annotations survive only until the next move is played.
  useEffect(() => {
    clearAnnotations();
  }, [clearAnnotations, displayedPositionKey]);

  const positionFromEvent = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const rect = surfaceRef.current?.getBoundingClientRect?.();
      return positionFromClientPoint(rect, event.clientX, event.clientY, isFlipped, shape);
    },
    [isFlipped],
  );

  const handleMouseDown = useCallback(
    (event: MouseLikeEvent) => {
      const source = event.nativeEvent ?? event;
      if (source.button === RIGHT_BUTTON) {
        const position = positionFromEvent(source);
        arrowOrigin.current = position;
        setPendingArrow(position ? { from: position, to: position } : null);
        return;
      }
      // Any left press on the board wipes the annotations, move or not.
      clearAnnotations();
    },
    [clearAnnotations, positionFromEvent],
  );

  const handleMouseMove = useCallback(
    (event: MouseLikeEvent) => {
      if (!arrowOrigin.current) return;
      const source = event.nativeEvent ?? event;
      if (((source.buttons ?? 0) & RIGHT_BUTTON_MASK) === 0) {
        arrowOrigin.current = null;
        setPendingArrow(null);
        return;
      }

      const from = arrowOrigin.current;
      const to = positionFromEvent(source) ?? from;
      setPendingArrow((current) =>
        samePosition(current?.to, to) ? current : { from, to },
      );
    },
    [positionFromEvent],
  );

  const handleMouseUp = useCallback(
    (event: MouseLikeEvent) => {
      const source = event.nativeEvent ?? event;
      if (source.button !== RIGHT_BUTTON) return;

      const from = arrowOrigin.current;
      arrowOrigin.current = null;
      setPendingArrow(null);
      if (!from) return;

      const to = positionFromEvent(source);
      if (!to) return;

      if (samePosition(from, to)) {
        setHighlights((current) =>
          current.some((tile) => samePosition(tile, to))
            ? current.filter((tile) => !samePosition(tile, to))
            : [...current, to],
        );
        return;
      }

      const arrow: Move = { from, to };
      setArrows((current) =>
        current.some((candidate) => sameMove(candidate, arrow))
          ? current.filter((candidate) => !sameMove(candidate, arrow))
          : [...current, arrow],
      );
    },
    [positionFromEvent],
  );

  // A release outside the board, or losing focus mid-drag, abandons the arrow.
  useEffect(() => {
    if (!IS_WEB || !pendingArrow) return undefined;

    const abandonArrow = () => {
      arrowOrigin.current = null;
      setPendingArrow(null);
    };

    window.addEventListener('mouseup', abandonArrow);
    window.addEventListener('blur', abandonArrow);
    return () => {
      window.removeEventListener('mouseup', abandonArrow);
      window.removeEventListener('blur', abandonArrow);
    };
  }, [pendingArrow]);

  const annotationHandlers = IS_WEB
    ? {
        onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault(),
        onMouseDown: handleMouseDown,
        onMouseMove: handleMouseMove,
        onMouseUp: handleMouseUp,
      }
    : {};

  const highlightKeys = useMemo(
    () => new Set(highlights.map(({ x, y }) => `${x}:${y}`)),
    [highlights],
  );

  const annotationArrows = useMemo(() => {
    if (!pendingArrow || samePosition(pendingArrow.from, pendingArrow.to)) return arrows;
    return [
      ...arrows.filter((candidate) => !sameMove(candidate, pendingArrow)),
      pendingArrow,
    ];
  }, [arrows, pendingArrow]);

  return (
    <View
      accessibilityLabel={`${boardShapeLabel(shape)} game board${overlay?.legend ? `. ${overlay.legend}` : ''}`}
      style={[styles.boardFrame, frameSize]}
    >
      <View ref={surfaceRef} style={styles.boardSurface} {...annotationHandlers}>
        {overArt ? (
          // Wrapped in a view that is inert in its style — this project has been
          // bitten once by an <Svg> over the board eating every touch on Fabric,
          // and this is the same hazard.
          <View style={styles.boardBackground}>
            <Image
              accessibilityIgnoresInvertColors
              accessible={false}
              onError={() => setBackgroundFailed(boardBackground ?? null)}
              resizeMode="cover"
              source={{ uri: boardBackground }}
              style={styles.boardBackgroundImage}
            />
          </View>
        ) : null}
        {displayedGrid.map((row, displayY) => (
          <View key={`row-${displayY}`} style={styles.row}>
            {row.map((tile, displayX) => {
              const position = { x: tile.x, y: tile.y };
              const isSelected = samePosition(selectedTile, position);
              const isValid = validMoveKeys.has(`${tile.x}:${tile.y}`);
              const isCapture = isValid && tile.occupant !== 'Empty';
              const isLight = (tile.x + tile.y) % 2 === 0;
              const isHighlighted = highlightKeys.has(`${tile.x}:${tile.y}`);
              const isLastMoveFrom = samePosition(displayedLastMove?.from, position);
              const isLastMoveTo = samePosition(displayedLastMove?.to, position);
              const tint = tintForTile(modeId, tile, shape.rows);
              const overlayCell = overlayCellAt(overlay, tile.x, tile.y);
              const overlayLabel = overlayCell?.describe ? `, ${overlayCell.describe}` : '';
              const tintLabel = tint
                ? tint.kind === 'goal'
                  ? `, ${tint.color} goal tile`
                  : `, owned by ${tint.color}`
                : '';
              const highlightLabel = isHighlighted ? ', marked' : '';
              const selectionLabel = isSelected ? ', selected' : '';
              const lastMoveLabel = isLastMoveFrom
                ? ', previous move origin'
                : isLastMoveTo
                  ? `, previous move destination${
                      lastMoveGrade ? `, ${lastMoveGrade.label} move` : ''
                    }`
                  : '';

              return (
                <Pressable
                  key={`${tile.x}-${tile.y}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${tile.occupantOwner} ${tile.occupant} on ${
                    FILES[tile.x]
                  }${tile.y + 1}${tintLabel}${selectionLabel}${highlightLabel}${lastMoveLabel}${overlayLabel}`}
                  onPress={() => onTilePress(position)}
                  style={[
                    styles.tile,
                    isLight ? styles.lightTile : styles.darkTile,
                    overArt && (isLight ? styles.lightTileOverArt : styles.darkTileOverArt),
                  ]}
                >
                  {tint && (
                    <>
                      <View
                        style={[
                          styles.tileTint,
                          tint.color === 'Red' ? styles.redTint : styles.blueTint,
                          tint.kind === 'goal' && styles.goalTint,
                        ]}
                      />
                      <TileMark owner={tint.color} variant={tint.kind} />
                    </>
                  )}
                  {overlayCell && (
                    <>
                      {overlayCell.fill && (
                        <View
                          style={[
                            styles.overlayFill,
                            { backgroundColor: overlayCell.fill },
                            overlayCell.dim && styles.overlayDim,
                          ]}
                        />
                      )}
                      {overlayCell.ring && (
                        <View style={[styles.overlayRing, { borderColor: overlayCell.ring }]} />
                      )}
                      {overlayCell.labels?.length ? (
                        <View
                          pointerEvents="none"
                          style={[styles.overlayLabels, overlayCell.dim && styles.overlayDim]}
                        >
                          {/*
                            Keyed by position, not by text: a contested square
                            shows both sides' answer and they are often the same
                            string — `R3` over `R3`, told apart by colour.
                          */}
                          {overlayCell.labels.map((entry, line) => (
                            <Text
                              key={`${line}-${entry.text}`}
                              style={[
                                styles.overlayLabel,
                                { color: entry.color ?? board.labelOnDark },
                                overlayLabelText(overlayLabelSize, overlayCell.labels?.length ?? 1),
                              ]}
                            >
                              {entry.text}
                            </Text>
                          ))}
                        </View>
                      ) : null}
                    </>
                  )}
                  {(isLastMoveFrom || isLastMoveTo) && (
                    <>
                      <View
                        style={[
                          styles.lastMoveTint,
                          isLastMoveFrom ? styles.lastMoveFromTint : styles.lastMoveToTint,
                        ]}
                      />
                      <TileMark
                        style={styles.lastMoveMark}
                        variant={isLastMoveFrom ? 'moveFrom' : 'moveTo'}
                      />
                    </>
                  )}
                  {isSelected && (
                    <>
                      <View style={styles.selectionTint} />
                      <TileMark style={styles.selectionMark} variant="selection" />
                    </>
                  )}
                  {isHighlighted && (
                    <>
                      <View style={styles.annotationTint} />
                      <TileMark style={styles.annotationMark} variant="annotation" />
                    </>
                  )}
                  {isValid &&
                    (isCapture ? (
                      <View style={styles.captureRing} />
                    ) : (
                      <View style={styles.validDot} />
                    ))}

                  {displayX === 0 && (
                    <Text
                      style={[
                        styles.rankLabel,
                        isLight ? styles.labelOnLight : styles.labelOnDark,
                      ]}
                    >
                      {tile.y + 1}
                    </Text>
                  )}
                  {displayY === shape.rows - 1 && (
                    <Text
                      style={[
                        styles.fileLabel,
                        isLight ? styles.labelOnLight : styles.labelOnDark,
                      ]}
                    >
                      {FILES[tile.x]}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        ))}

        {analysisArrows.length > 0 && (
          <View style={styles.analysisLayer}>
            <Svg
              aria-hidden
              style={styles.arrowSurface}
              viewBox={`0 0 ${shape.columns} ${shape.rows}`}
            >
              <Defs>
                {analysisArrows.slice(0, 3).map((arrow, index) => {
                  const color = board.analysisArrows[index];
                  return (
                    <Marker
                      id={`analysis-arrow-${index}`}
                      key={`marker-${index}`}
                      markerHeight="5"
                      markerUnits="strokeWidth"
                      markerWidth="5"
                      orient="auto"
                      refX="8"
                      refY="5"
                      viewBox="0 0 10 10"
                    >
                      <Polygon fill={color} points="0,0 10,5 0,10 2.5,5" />
                    </Marker>
                  );
                })}
              </Defs>
              {analysisArrows.slice(0, 3).map((arrow, index) => {
                const color = board.analysisArrows[index];
                const fromX = displayCenter(arrow.from.x, isFlipped, shape.columns);
                const fromY = displayCenter(arrow.from.y, isFlipped, shape.rows);
                const toX = displayCenter(arrow.to.x, isFlipped, shape.columns);
                const toY = displayCenter(arrow.to.y, isFlipped, shape.rows);
                return (
                  <Line
                    key={`${arrow.from.x}:${arrow.from.y}-${arrow.to.x}:${arrow.to.y}`}
                    markerEnd={`url(#analysis-arrow-${index})`}
                    opacity={index === 0 ? 0.94 : 0.76}
                    stroke={color}
                    strokeLinecap="round"
                    strokeWidth={index === 0 ? 0.18 : 0.13}
                    x1={fromX}
                    x2={toX}
                    y1={fromY}
                    y2={toY}
                  />
                );
              })}
            </Svg>
          </View>
        )}

        {annotationArrows.length > 0 && (
          <View style={styles.annotationLayer}>
            <Svg
              aria-hidden
              style={styles.arrowSurface}
              viewBox={`0 0 ${shape.columns} ${shape.rows}`}
            >
              <Defs>
                <Marker
                  id="board-annotation-arrow"
                  markerHeight="5"
                  markerUnits="strokeWidth"
                  markerWidth="5"
                  orient="auto"
                  refX="8"
                  refY="5"
                  viewBox="0 0 10 10"
                >
                  <Polygon fill={ANNOTATION_COLOR} points="0,0 10,5 0,10 2.5,5" />
                </Marker>
              </Defs>
              {annotationArrows.map((arrow) => (
                <Line
                  key={`${arrow.from.x}:${arrow.from.y}-${arrow.to.x}:${arrow.to.y}`}
                  markerEnd="url(#board-annotation-arrow)"
                  opacity={0.68}
                  stroke={ANNOTATION_COLOR}
                  strokeLinecap="round"
                  strokeWidth={0.12}
                  x1={displayCenter(arrow.from.x, isFlipped, shape.columns)}
                  x2={displayCenter(arrow.to.x, isFlipped, shape.columns)}
                  y1={displayCenter(arrow.from.y, isFlipped, shape.rows)}
                  y2={displayCenter(arrow.to.y, isFlipped, shape.rows)}
                />
              ))}
            </Svg>
          </View>
        )}

        {displayedGrid.flatMap((row, displayY) =>
          row.map((tile, displayX) => {
            if (tile.occupant === 'Empty') return null;
            const position = { x: tile.x, y: tile.y };
            const isHidden = hiddenSettledPieceKeys.has(`${tile.x}:${tile.y}`);
            const dragEnabled =
              !visibleReplayTransition && canMove && tile.occupantOwner === activeMoveColor;

            return (
              <DraggablePiece
                boardSize={boardSize}
                shape={shape}
                look={pieceLooks?.[tile.occupant]}
                boardX={tile.x}
                boardY={tile.y}
                displayX={displayX}
                displayY={displayY}
                dragEnabled={dragEnabled}
                isFlipped={isFlipped}
                isHidden={isHidden}
                isSelected={!isHidden && samePosition(selectedTile, position)}
                key={`${tile.x}-${tile.y}`}
                onDragActiveChange={handleDragActiveChange}
                onDragEnd={handleDragEnd}
                onDragStart={handleDragStart}
                tile={tile}
              />
            );
          }),
        )}

        {visibleReplayTransition && (
          <ReplayTransition
            boardSize={boardSize}
            shape={shape}
            pieceLooks={pieceLooks}
            isFlipped={isFlipped}
            key={visibleReplayTransition.key}
            onComplete={handleReplayTransitionComplete}
            transition={visibleReplayTransition}
          />
        )}

        {displayedLastMove?.to && lastMoveGrade ? (
          <View
            pointerEvents="none"
            style={[
              styles.moveQualityBadgeLayout,
              {
                height: `${rowPercent(shape)}%`,
                left: `${displayCoordinate(displayedLastMove.to.x, isFlipped, shape.columns) * columnPercent(shape)}%`,
                top: `${displayCoordinate(displayedLastMove.to.y, isFlipped, shape.rows) * rowPercent(shape)}%`,
                width: `${columnPercent(shape)}%`,
              },
            ]}
          >
            <MoveQualityBadge
              accessible={false}
              compact
              grade={lastMoveGrade}
              showLabel={false}
              size={moveBadgeSize}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  boardFrame: {
    borderWidth: BOARD_BORDER_WIDTH,
    borderColor: board.frame,
    borderRadius: 10,
    backgroundColor: board.frame,
    boxShadow: shadows.board,
    elevation: 8,
  },
  boardSurface: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 6,
    userSelect: 'none',
  },
  row: { flex: 1, flexDirection: 'row' },
  // The arrow layers cover the whole board, so anything they catch is a tap or
  // a drop the board never sees. `pointerEvents` on the `Svg` itself is not
  // enough to stop that: on iOS's new architecture react-native-svg's view
  // claims every touch inside its bounding box as soon as it has drawn
  // anything, whatever it was told (software-mansion/react-native-svg#2690).
  // A plain `View` is honoured on both platforms and nothing below one is
  // hit-tested, so each layer is wrapped in one and the `Svg` inside only
  // paints.
  analysisLayer: { ...StyleSheet.absoluteFill, zIndex: 4, pointerEvents: 'none' },
  annotationLayer: { ...StyleSheet.absoluteFill, zIndex: 5, pointerEvents: 'none' },
  arrowSurface: { ...StyleSheet.absoluteFill },
  tile: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  lightTile: { backgroundColor: board.lightTile },
  darkTile: { backgroundColor: board.darkTile },
  lightTileOverArt: { backgroundColor: board.lightTileOverArt },
  darkTileOverArt: { backgroundColor: board.darkTileOverArt },
  boardBackground: {
    bottom: 0,
    left: 0,
    // Inert, without exception: an overlay across interactive board UI swallows
    // every touch on Fabric, and a background that ate every move would be a
    // board nobody can play on.
    pointerEvents: 'none',
    position: 'absolute',
    right: 0,
    top: 0,
  },
  boardBackgroundImage: { height: '100%', width: '100%' },
  tileTint: {
    ...StyleSheet.absoluteFill,
    pointerEvents: 'none',
    borderWidth: 1,
  },
  redTint: {
    backgroundColor: players.Red.tint,
    borderColor: players.Red.tintBorder,
  },
  blueTint: {
    backgroundColor: players.Blue.tint,
    borderColor: players.Blue.tintBorder,
  },
  goalTint: {
    borderWidth: 1,
    borderColor: board.goalOutline,
  },
  lastMoveTint: { ...StyleSheet.absoluteFill, zIndex: 1, pointerEvents: 'none' },
  lastMoveMark: { zIndex: 1 },
  lastMoveFromTint: { backgroundColor: board.lastMoveFrom },
  lastMoveToTint: { backgroundColor: board.lastMoveTo },
  selectionTint: {
    ...StyleSheet.absoluteFill,
    zIndex: 1,
    pointerEvents: 'none',
    backgroundColor: board.selectionTint,
  },
  selectionMark: { zIndex: 1 },
  annotationTint: {
    ...StyleSheet.absoluteFill,
    zIndex: 2,
    pointerEvents: 'none',
    backgroundColor: board.annotationTint,
  },
  annotationMark: { zIndex: 2 },
  // Analysis washes sit below everything the board says for itself: the last
  // move, the selection and the move dots all have to stay readable through one.
  overlayFill: {
    ...StyleSheet.absoluteFill,
    pointerEvents: 'none',
  },
  overlayRing: {
    position: 'absolute',
    zIndex: 2,
    pointerEvents: 'none',
    top: 1,
    right: 1,
    bottom: 1,
    left: 1,
    borderRadius: 3,
    borderWidth: 1.5,
  },
  // Top right: the rank label owns the top left corner and the file label the
  // bottom right, so this is the one corner of a tile that is always free.
  overlayLabels: {
    position: 'absolute',
    zIndex: 2,
    top: 1,
    right: 3,
    alignItems: 'flex-end',
    pointerEvents: 'none',
  },
  overlayLabel: { fontWeight: '800' },
  overlayDim: { opacity: 0.35 },
  validDot: {
    position: 'absolute',
    zIndex: 2,
    pointerEvents: 'none',
    width: '24%',
    aspectRatio: 1,
    borderRadius: 30,
    backgroundColor: board.moveHint,
  },
  captureRing: {
    position: 'absolute',
    zIndex: 2,
    pointerEvents: 'none',
    width: '84%',
    aspectRatio: 1,
    borderRadius: 50,
    borderWidth: 4,
    borderColor: board.moveHint,
  },
  pieceLayout: {
    position: 'absolute',
    zIndex: 3,
    // Reanimated writes this style inline on web, so it never reaches the
    // react-native-web compiler that expands 'box-none' into real CSS. Spell
    // out the equivalent instead: the wrapper ignores clicks and the piece
    // inside re-enables itself when it is draggable. Left as 'box-none' the
    // wrapper swallows every click on an occupied square, so clicking a
    // destination that holds an enemy piece never reaches the tile below.
    pointerEvents: IS_WEB ? 'none' : 'box-none',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedPieceLayout: { zIndex: 3 },
  hiddenPieceLayout: { opacity: 0 },
  draggingPieceLayout: { zIndex: 100, elevation: 24 },
  movingPieceLayout: { zIndex: 6 },
  moveQualityBadgeLayout: {
    position: 'absolute',
    zIndex: 7,
    alignItems: 'flex-end',
    paddingTop: 1,
    paddingRight: 1,
  },
  piece: { alignItems: 'center', justifyContent: 'center' },
  // `grab`/`grabbing` are web cursors; React Native's own type knows only
  // `auto` and `pointer`, so the recipes are declared as web styles.
  draggablePiece: webDragStyle('grab'),
  draggingPiece: webDragStyle('grabbing'),
  rankLabel: {
    position: 'absolute',
    zIndex: 3,
    top: 2,
    left: 3,
    fontSize: 7,
    fontWeight: '900',
  },
  fileLabel: {
    position: 'absolute',
    zIndex: 3,
    right: 3,
    bottom: 2,
    fontSize: 7,
    fontWeight: '900',
  },
  labelOnLight: { color: board.labelOnLight },
  labelOnDark: { color: board.labelOnDark },
});
