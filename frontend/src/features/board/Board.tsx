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
import Svg, { Path } from 'react-native-svg';

import { arrowPath } from './arrowShape';
import CaptureEffectLayer, {
  along,
  useCaptureEffectClock,
  type CaptureEffectState,
} from './CaptureEffectLayer';
import {
  CHOREOGRAPHY,
  decideCaptureEffect,
  effectOutlivesStep,
  impactAfter,
} from './captureEffect';
import PieceIcon from './PieceIcon';
import { usePieceDrag } from './pieceDrag';
import TileMark from './TileMark';
import { overlayCellAt, type BoardOverlay } from './overlay';
import { tintForTile } from './tint';
import MoveQualityBadge from '@/features/analysis/MoveQualityBadge';
import { MAX_BOARD } from '@/hooks/useBoardLayout';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import {
  animatedReplayPieceTracks,
  buildReplayPieceTracks,
  replayGridSignature,
  type PieceTrack,
  type ReplayTracks,
} from '@/engine/replayAnimation';
import type { MoveGrade } from '@/engine/gameReview';
import type { RulesEra } from '@/engine/goals';
import type { PieceLook } from './pieceLook';
import { board, players, shadows, themedSheet } from '@/theme';
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
/** In squares, like everything else an arrow is measured in. */
const ARROW_OUTLINE_WIDTH = 0.028;
/** A drawn arrow sits between the engine's best and its also-rans: it is the reader's own note. */
const ANNOTATION_ARROW_WIDTH = 0.17;
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
// The capture effect resizes a taker as it lands and must hand it back at its
// own size inside this; see `ATTACKER_SETTLED_BY_MS`.
const MOVE_ANIMATION_DURATION = 230;
// A catch-up finishes before even the fastest watched bot can make its next
// move (250ms), so reaching the live edge never makes the board fall behind.
const FAST_REPLAY_MAX_DURATION = 220;
const FAST_REPLAY_MIN_DURATION = 72;
const FAST_REPLAY_MOVE_DURATION = 12;
// How long a dropped piece waits where it was let go for the move to come
// back. A local board answers within a frame; this is the server's round
// trip, with room for a slow phone connection, and is only ever reached when
// the move is refused or lost.
const DROP_HOLD_TIMEOUT = 1500;

/** Milliseconds on a clock that only goes forwards, for timing steps against each other. */
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** How far a piece was dragged from the middle of its square, in pixels. */
interface DropOffset {
  x: number;
  y: number;
}

/** A piece let go on a legal square, waiting for the board to play it. */
interface HeldDrop {
  from: Position;
  to: Position;
  offset: DropOffset;
}

// The board is drawn the way a chessboard is: file a on the left, rank 1 at the
// bottom. Rank 1 is Blue's home boundary, so an unturned board is already
// Blue's own view, and turning it round for Red is the half turn a chessboard
// makes for Black -- which mirrors the files and un-mirrors the ranks.
//
// Two helpers rather than one because the two axes no longer answer the same
// way, and each is its own inverse, so the same call converts a square to the
// screen and a screen square back.
const displayFile = (x: number, isFlipped: boolean, columns: number) =>
  isFlipped ? columns - 1 - x : x;

const displayRank = (y: number, isFlipped: boolean, rows: number) =>
  isFlipped ? y : rows - 1 - y;

const displayCoordinate = (
  value: number,
  isFlipped: boolean,
  extent: number,
  axis: 'x' | 'y',
) => (axis === 'x' ? displayFile(value, isFlipped, extent) : displayRank(value, isFlipped, extent));

const fileCenter = (x: number, isFlipped: boolean, columns: number) =>
  displayFile(x, isFlipped, columns) + 0.5;

const rankCenter = (y: number, isFlipped: boolean, rows: number) =>
  displayRank(y, isFlipped, rows) + 0.5;

/**
 * How much larger than its design size a board is drawn: 1 for every board up
 * to `MAX_BOARD`, which is all of them but an analysis board given a tall
 * window. The pieces and badges below stop growing at what a `MAX_BOARD` board
 * draws, so past it they are scaled with the board — the same board larger,
 * rather than the same pieces swimming in bigger squares.
 */
const grownBy = (boardSize: number) => Math.max(1, boardSize / MAX_BOARD);
const pieceSizeForBoard = (boardSize: number) =>
  Math.max(20, Math.min(46, boardSize / 12)) * grownBy(boardSize);
const moveBadgeSizeForBoard = (boardSize: number, shape: BoardShape) =>
  Math.round(
    Math.max(13, Math.min(22, squareSizeFor(boardSize, shape) * 0.36)) * grownBy(boardSize),
  );

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
  // Down the screen is down the ranks only on a turned board, which is the one
  // axis the two views disagree about.
  const to = {
    x: from.x + displayXOffset * (isFlipped ? -1 : 1),
    y: from.y + displayYOffset * (isFlipped ? 1 : -1),
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

  return {
    x: displayFile(displayX, isFlipped, shape.columns),
    y: displayRank(displayY, isFlipped, shape.rows),
  };
};

/**
 * A move drawn by the piece that makes it, rather than by a copy laid over the
 * board for the length of the animation.
 *
 * The copy was a new image view every move, and the piece it stood in for left
 * the board in the same frame. A new image view on a phone paints nothing until
 * its picture is handed back to it, which can be a frame after it first goes on
 * screen — so now and then a piece blinked out for a frame as it set off. A
 * capture's effect drew over the gap; a quiet move showed it. The piece's own
 * view already has its picture, so it carries itself.
 *
 * Built once per move and handed down unchanged until the move ends: the
 * transform it describes is driven natively, and a native-driven view that is
 * restyled mid-animation can be left at the animation's start on iOS.
 */
interface CarriedMove {
  progress: NativeAnimated.Value;
  /** How far the move carries the piece, in pixels, from where it stands. */
  dx: number;
  dy: number;
  /** The taker's size as it lands on a capture, from the capture effect's clock. */
  landing?: NativeAnimated.AnimatedInterpolation<number>;
}

/** A carried piece takes no touches, so it is handed these and never re-rendered by new ones. */
const ignoreDragActive = () => {};
const ignoreDragStart = () => {};
const refuseDrop = () => false;

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
  /** Left where it was dropped, waiting for the board to play the move. */
  isHeld: boolean;
  isHidden: boolean;
  isSelected: boolean;
  onDragActiveChange: (active: boolean) => void;
  /** Returns whether the board is holding the piece where it was let go. */
  onDragEnd: (from: Position, to: Position, offset: DropOffset) => boolean;
  onDragStart: (position: Position) => void;
  tile: Tile;
  /** The move this piece is making, while it makes it. */
  travel?: CarriedMove;
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
  isHeld,
  isHidden,
  isSelected,
  onDragActiveChange,
  onDragEnd,
  onDragStart,
  tile,
  travel,
}: DraggablePieceProps) {
  const translation = useRef(new NativeAnimated.ValueXY()).current;
  // Memoised on the move, so a re-render while it plays hands the same nodes
  // back rather than restyling the view under the native driver.
  const travelStyle = useMemo(
    () =>
      travel
        ? {
            transform: [
              {
                translateX: travel.progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, travel.dx],
                  extrapolate: 'clamp',
                }),
              },
              {
                translateY: travel.progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, travel.dy],
                  extrapolate: 'clamp',
                }),
              },
              ...(travel.landing ? [{ scale: travel.landing }] : []),
            ],
          }
        : null,
    [travel],
  );
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

  // A held piece that is still here when the board lets go of it was never
  // moved — the move was refused, or never arrived — so it goes home.
  const wasHeld = useRef(isHeld);
  useEffect(() => {
    if (wasHeld.current && !isHeld) resetPosition();
    wasHeld.current = isHeld;
  }, [isHeld, resetPosition]);

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
          const held = latest.current.onDragEnd(position, to, {
            x: gesture.dx,
            y: gesture.dy,
          });
          if (!held) resetPosition();
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
        (isDragging || isHeld) && styles.draggingPieceLayout,
        travel && styles.travellingPieceLayout,
      ]}
    >
      {/*
        Rendered whether or not the piece is moving, so that starting a move
        never changes the tree around the image — see `CarriedMove`.
      */}
      <NativeAnimated.View style={[styles.pieceTravel, travelStyle]}>
        {/*
          One size, always. Selecting and dragging used to scale the piece, but
          the scale was a React prop on a view whose drag offset is written
          straight to it: every finger movement wrote the offset back without the
          scale and every re-render put it back, so a dragged piece pulsed between
          two sizes as it went. The tile's frame says a piece is selected and the
          shadow says it is lifted.
        */}
        <NativeAnimated.View
          {...panResponder.panHandlers}
          style={[
            styles.piece,
            dragEnabled ? styles.pieceGrip : styles.pieceInert,
            dragEnabled && styles.draggablePiece,
            isDragging && styles.draggingPiece,
            { transform: translation.getTranslateTransform() },
          ]}
        >
          {/*
            `liftable` says the shadow is coming before it does. Without it the
            artwork is thrown away and drawn again on the touch and again on the
            release — see the prop on `PieceIcon` — which on a phone is a piece
            that blinks twice every time it is tapped. The same tree swap the
            `pieceGrip` note below is about, costing a picture rather than a
            gesture.
          */}
          <PieceIcon
            color={tile.occupantOwner}
            dropShadow={isDragging}
            liftable
            piece={tile.occupant}
            look={look}
            size={pieceSize}
          />
        </NativeAnimated.View>
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
  /** The taker's size as it lands on a capture, from the capture effect's clock. */
  landing?: NativeAnimated.AnimatedInterpolation<number>;
  progress: NativeAnimated.Value;
  /** Where a dragged piece was let go, which is where it sets off from. */
  startOffset?: DropOffset;
  steps: number;
  track: PieceTrack;
}

const ReplayPiece = memo(function ReplayPiece({
  boardSize,
  shape,
  pieceLooks,
  isFlipped,
  landing,
  progress,
  startOffset,
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
      (displayCoordinate(position[axis], isFlipped, extent, axis) -
        displayCoordinate(first ? first[axis] : 0, isFlipped, extent, axis)) *
      squareSize
    );
  };
  const translate = (axis: 'x' | 'y') => {
    if (inputRange.length < 2) return 0;
    const outputRange = positions.map((position) => offsetFor(position, axis));
    // Set off from the finger rather than the square: starting a dropped piece
    // from its square teleports it home before it moves.
    if (startOffset) outputRange[0] = startOffset[axis];
    return progress.interpolate({ inputRange, outputRange, extrapolate: 'clamp' });
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
          left: `${displayFile(first.x, isFlipped, shape.columns) * columnPercent(shape)}%`,
          opacity: replayPieceOpacity(progress, track, steps),
          top: `${displayRank(first.y, isFlipped, shape.rows) * rowPercent(shape)}%`,
          width: `${columnPercent(shape)}%`,
          // The scale is there from the first frame or not at all: a piece
          // whose transform changes shape while the native driver is moving it
          // can be left behind at the animation's start.
          transform: [
            { translateX: translate('x') },
            { translateY: translate('y') },
            ...(landing ? [{ scale: landing }] : []),
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
  /**
   * A capture this move is drawn as: the effect, and which of the tracks are
   * its taker and the piece that fell. The fallen piece is the effect's to
   * draw, so the transition leaves it out.
   */
  capture?: { effect: CaptureEffectState; attackerTrackId: string; victimTrackId: string };
  /** The piece that was dragged into this move, and where it was let go. */
  drop?: { trackId: string; offset: DropOffset };
  duration: number;
  key: string;
  /**
   * The move's clock, made with the transition rather than by the layer that
   * plays it, because the pieces that carry themselves run on it too.
   */
  progress: NativeAnimated.Value;
  /** Tracks drawn by the piece's own view instead of this layer. See `CarriedMove`. */
  carriedTrackIds: readonly string[];
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
  const { progress } = transition;

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

  const { capture } = transition;
  const landing = useMemo(() => {
    const frames = capture ? CHOREOGRAPHY[capture.effect.matchup].attackerScale : null;
    return capture && frames ? along(capture.effect, frames) : undefined;
  }, [capture]);

  return transition.tracks.map((track) =>
    track.id === capture?.victimTrackId || transition.carriedTrackIds.includes(track.id) ? null : (
      <ReplayPiece
        boardSize={boardSize}
        shape={shape}
        pieceLooks={pieceLooks}
        isFlipped={isFlipped}
        key={track.id}
        landing={track.id === capture?.attackerTrackId ? landing : undefined}
        progress={progress}
        startOffset={transition.drop?.trackId === track.id ? transition.drop.offset : undefined}
        steps={transition.steps}
        track={track}
      />
    ),
  );
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

/**
 * One ranked suggestion, drawn as an arrow.
 *
 * `weight` is what makes the same arrow serve two different claims. Without it
 * an arrow is drawn by its *rank* -- best one thickest -- which is what an
 * engine's variations are: an ordered list where the order is the whole point.
 * With it the arrow is drawn by its *size*, which is what a frequency is: the
 * opening explorer's second-most-played move can be nearly as popular as the
 * first or a twentieth of it, and drawing those two the same way would throw
 * away the only interesting thing about them.
 */
export interface AnalysisArrow extends Move {
  /** 0 to 1. Absent means "draw me by my rank". */
  weight?: number;
  /**
   * Which suggestion this arrow belongs to, and so which colour it is drawn in.
   *
   * Absent means "my place in the list", which is what a plain ranked list
   * wants. It is given when one suggestion needs more than one arrow: on a
   * board that is its own reflection two different moves reach the same
   * position, so they are one continuation with one set of numbers, and drawing
   * them in two colours would say they were two.
   */
  rank?: number;
  /**
   * Drawn hollow, as a dashed outline: the same move, spelled the other way.
   *
   * Only ever true for the second and later arrows of one rank. Solid is the
   * move the list is labelled with and dashed is its twin, so a reader can see
   * that both are on offer without having to work out why two arrows are the
   * same colour.
   */
  dashed?: boolean;
}

/** How many suggestions the board will draw. Twins do not count against it. */
const MAXIMUM_ARROWS = 5;

/** The dash pattern for a twin, in squares. Long enough to read as a line. */
const TWIN_DASH = '0.12,0.09';
/** A ghosted arrow is drawn by its outline, so the outline has to carry it. */
const TWIN_OUTLINE_WIDTH = 0.055;
/**
 * How much of the fill a twin keeps.
 *
 * Not zero. A purely hollow arrow reads as a different *kind* of mark rather
 * than as the same move written elsewhere, and at the weight a rare
 * continuation is drawn at there is barely a line left to see. A ghost of the
 * fill under a dashed edge keeps the pair looking like one thing.
 */
const TWIN_FILL_OPACITY = 0.24;

/**
 * How thick and how solid an arrow is drawn.
 *
 * Weighted arrows keep a floor: a move two percent of games played is still a
 * move somebody played, and an arrow too faint to see is worse than no arrow
 * because the reader cannot tell it from a rendering fault.
 */
/**
 * The colour for an arrow at this rank.
 *
 * The palette names three, and the board now draws up to five, so the ranks
 * past it share the last colour rather than reading `undefined` and painting
 * nothing -- a silent blank arrow being exactly the kind of failure that looks
 * like the data was missing.
 */
const arrowColor = (index: number) =>
  board.analysisArrows[Math.min(index, board.analysisArrows.length - 1)];

const arrowInk = (arrow: AnalysisArrow, rank: number) => {
  if (typeof arrow.weight !== 'number' || !Number.isFinite(arrow.weight)) {
    return { width: rank === 0 ? 0.185 : 0.145, opacity: rank === 0 ? 0.95 : 0.8 };
  }
  const share = Math.max(0, Math.min(1, arrow.weight));
  return { width: 0.09 + share * 0.1, opacity: 0.58 + share * 0.37 };
};

/**
 * Which suggestion an arrow belongs to.
 *
 * Its place in the list unless it says otherwise, which keeps every caller that
 * hands over a plain ranked list drawing exactly what it drew before.
 */
const arrowRank = (arrow: AnalysisArrow, index: number) => arrow.rank ?? index;

export interface BoardProps {
  /**
   * Ranked suggestions, best first, of which the board draws the top five.
   *
   * Ordinarily one arrow each. A suggestion that can be played more than one
   * way -- two moves reaching the same position on a board that is its own
   * reflection -- hands over one arrow per spelling, all carrying the same
   * `rank`, and they are drawn in one colour with the twins dashed.
   */
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
   * Which rules say where this mode's goal tiles are. Absent means today's,
   * which is every live game; a review of a record from before the 2026-09-03
   * board flip passes `preChange` so the tinted squares are the ones that
   * record is actually won on. See `@/engine/goals`.
   */
  era?: RulesEra;
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
  /**
   * The side the board is drawn from. Red sees it flipped.
   *
   * Rank 1 is Blue's home boundary and is drawn at the bottom, the way rank 1
   * is drawn at the bottom of a chessboard, so an unflipped board is already
   * the view of the side that opens.
   */
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
  era = 'current',
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

  const isFlipped = playerColor === 'Red';
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
  // Rank 1 is drawn at the bottom, so the rows are always reversed on the way
  // to the screen; a turned board mirrors the files instead.
  const displayedGrid = useMemo(
    () =>
      isFlipped
        ? grid.map((row) => [...row].reverse())
        : [...grid].reverse(),
    [grid, isFlipped],
  );

  // A drop on a square the board knows is legal is held where it was let go
  // until the move comes back, and then sets off from there — rather than
  // springing home and starting again from its square. Read during render, so
  // a ref: a move the parent plays in the same event has to find it in the
  // render that receives the new grid, whichever update React gets to first.
  // The state copy is only what tells the piece it is being held.
  const heldDropRef = useRef<HeldDrop | null>(null);
  const [heldDrop, setHeldDrop] = useState<HeldDrop | null>(null);
  const holdDrop = useCallback((drop: HeldDrop | null) => {
    heldDropRef.current = drop;
    setHeldDrop(drop);
  }, []);

  // A move goes out to a server and may never come back: refused, or the
  // socket gone. The piece cannot wait for it forever.
  useEffect(() => {
    if (!heldDrop) return undefined;
    const timer = setTimeout(() => holdDrop(null), DROP_HOLD_TIMEOUT);
    return () => clearTimeout(timer);
  }, [heldDrop, holdDrop]);

  // Read by the drag callbacks, which outlive the render they were made in.
  const selection = useRef({ selectedTile, validMoves });
  selection.current = { selectedTile, validMoves };
  // The press below can clear the moves a piece was already showing — a second
  // press on a selected piece deselects it — so they are kept for the drop.
  const movesAtGrab = useRef<{ from: Position; moves: Position[] } | null>(null);

  const handleDragStart = useCallback(
    (position: Position) => {
      holdDrop(null);
      const { selectedTile: selected, validMoves: moves } = selection.current;
      movesAtGrab.current = samePosition(selected, position)
        ? { from: position, moves }
        : null;
      onTilePress(position);
    },
    [holdDrop, onTilePress],
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

  // A square the board cannot vouch for springs home at once, as it always
  // has: holding it would leave a refused move hanging for the whole timeout.
  // Online the legal moves arrive a round trip after the grab, so only a flick
  // faster than that is ever unvouched for.
  const handleDragEnd = useCallback(
    (from: Position, to: Position, offset: DropOffset) => {
      if (samePosition(from, to)) return false;
      const { selectedTile: selected, validMoves: moves } = selection.current;
      const grabbed = movesAtGrab.current;
      const known = [
        ...(grabbed && samePosition(grabbed.from, from) ? grabbed.moves : []),
        ...(samePosition(selected, from) ? moves : []),
      ];
      const legal = known.some((move) => samePosition(move, to));
      if (legal) holdDrop({ from, to, offset });
      onPieceDrop(from, to);
      return legal;
    },
    [holdDrop, onPieceDrop],
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

  // What the capture effect needs to tell a move being played from a step
  // through the record: how long ago the board last moved, and where the end of
  // its line was then. Both are written only when the position changes — a live
  // board hears that the line grew a render before it is moved along it, and
  // reading the end as of the last render would lose exactly that.
  const reducedMotion = useReducedMotion();
  const lineEnd = Array.isArray(replayPositions) ? replayPositions.length - 1 : null;
  const lineEndAtLastChange = useRef(lineEnd);
  const lastChangeAt = useRef(Number.NEGATIVE_INFINITY);
  const [captureEffect, setCaptureEffect] = useState<CaptureEffectState | null>(null);

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
  let requestedCaptureEffect: CaptureEffectState | null = null;
  const changedAt = positionChanged ? nowMs() : lastChangeAt.current;
  // An effect still playing when the board moves on is either left to finish
  // or dropped, never waited for. See `effectOutlivesStep`.
  const captureEffectOutlives = Boolean(
    positionChanged &&
      captureEffect &&
      effectOutlivesStep(captureEffect.capture.to, { step: replayStep, before, after: grid }),
  );

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
      const tracks =
        firstGrid && finalGrid
          ? animatedReplayPieceTracks(replay, firstGrid, finalGrid)
          : replay.tracks;
      // Whatever moves a held piece, it is on screen where it was let go.
      const held = heldDropRef.current;
      const dropped = held
        ? tracks.find(
            (track) => track.startStep === 0 && samePosition(track.positions[0], held.from),
          )
        : undefined;
      const key = `${beforeIndex ?? 'board'}:${replayIndex ?? 'board'}:${beforeSignature}:${positionSignature}`;

      // A capture made by this one move is drawn as the throw that won it,
      // when `decideCaptureEffect` says this is a move worth drawing that way.
      let capture: ReplayTransitionState['capture'];
      if (replay.steps === 1) {
        const decision = decideCaptureEffect({
          before,
          after: grid,
          step: replayStep,
          lineEnd,
          lineEndBefore: lineEndAtLastChange.current,
          sinceLastChange: changedAt - lastChangeAt.current,
          reducedMotion,
          looks: pieceLooks,
        });
        if (decision.play) {
          const { from, to } = decision.capture;
          const attacker = tracks.find(
            ({ positions }) => samePosition(positions[0], from) && samePosition(positions[1], to),
          );
          const victim = tracks.find(
            (track) =>
              track !== attacker && track.endStep === 1 && samePosition(track.positions[0], to),
          );
          if (attacker && victim) {
            // How far the taker sets off from its victim, in squares: a whole
            // step, or what is left of one when it was dragged most of the way.
            const square = squareSizeFor(boardSize, shape);
            const offset = held && dropped === attacker ? held.offset : { x: 0, y: 0 };
            const column = ({ x }: Position) => displayFile(x, isFlipped, shape.columns);
            const row = ({ y }: Position) => displayRank(y, isFlipped, shape.rows);
            const across = (column(to) - column(from)) * square - offset.x;
            const down = (row(to) - row(from)) * square - offset.y;
            requestedCaptureEffect = {
              capture: decision.capture,
              clock: new NativeAnimated.Value(0),
              impactMs: impactAfter(Math.hypot(across, down) / square, MOVE_ANIMATION_DURATION),
              key,
              matchup: decision.matchup,
            };
            capture = {
              attackerTrackId: attacker.id,
              effect: requestedCaptureEffect,
              victimTrackId: victim.id,
            };
          }
        }
      }

      // One piece stepping off a square nothing else will stand on draws its
      // own move — see `CarriedMove`. A square something else is restored to
      // (a capture being stepped back through) keeps the copy, because the
      // restored piece is given the square's place in the board's list.
      const carriedTrackIds =
        replay.steps === 1
          ? tracks
              .filter((track) => {
                const [from, to] = track.positions;
                return Boolean(
                  track.startStep === 0 &&
                    track.endStep === 1 &&
                    from &&
                    to &&
                    !samePosition(from, to) &&
                    grid[from.y]?.[from.x]?.occupant === 'Empty',
                );
              })
              .map((track) => track.id)
          : [];

      requestedReplayTransition = {
        ...replay,
        capture,
        carriedTrackIds,
        drop: held && dropped ? { trackId: dropped.id, offset: held.offset } : undefined,
        progress: new NativeAnimated.Value(0),
        tracks,
        duration:
          replay.steps === 1
            ? MOVE_ANIMATION_DURATION
            : Math.min(
                FAST_REPLAY_MAX_DURATION,
                Math.max(FAST_REPLAY_MIN_DURATION, replay.steps * FAST_REPLAY_MOVE_DURATION),
              ),
        key,
      };
    }
  }
  const visibleCaptureEffect = positionChanged
    ? (requestedCaptureEffect ?? (captureEffectOutlives ? captureEffect : null))
    : captureEffect;

  useLayoutEffect(() => {
    previousGrid.current = grid;
    previousReplayIndex.current = replayIndex;
    if (positionChanged) {
      setReplayTransition(requestedReplayTransition);
      setCaptureEffect(visibleCaptureEffect);
      lastChangeAt.current = changedAt;
      lineEndAtLastChange.current = lineEnd;
      // Played or not, a held drop is settled by the next position: the move
      // carried it away, or the piece is still on its square and goes home.
      holdDrop(null);
    }
    // `requestedReplayTransition` and the capture effect are deliberately
    // captured from the render caused by these props. Adding them as
    // dependencies would run this effect a second time after the refs advance
    // and immediately clear the animation.
  }, [grid, holdDrop, positionSignature, replayIndex, replayPositions]);

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

  // Built once per move from values that hold still while it plays, so every
  // render during it hands each carried piece the very same props. See
  // `CarriedMove` for why that matters.
  const { columns, rows } = shape;
  const carriedPieces = useMemo(() => {
    const transition = visibleReplayTransition;
    if (!transition?.carriedTrackIds.length) return [];
    const carriedShape = { columns, rows };
    const square = squareSizeFor(boardSize, carriedShape);
    const { capture, drop, progress } = transition;
    const frames = capture ? CHOREOGRAPHY[capture.effect.matchup].attackerScale : null;
    const landing = capture && frames ? along(capture.effect, frames) : undefined;
    return transition.tracks.flatMap((track) => {
      const [from, to] = track.positions;
      if (!from || !to || !transition.carriedTrackIds.includes(track.id)) return [];
      // A dragged piece sets off from where it was let go: its drag offset is
      // still on it, so the move covers only what is left.
      const offset = drop?.trackId === track.id ? drop.offset : { x: 0, y: 0 };
      const tile: Tile = {
        x: from.x,
        y: from.y,
        occupant: track.piece ?? 'Empty',
        occupantOwner: track.color ?? 'Neutral',
        ownerColor: 'Neutral',
      };
      return [
        {
          from,
          held: drop?.trackId === track.id,
          shape: carriedShape,
          tile,
          travel: {
            progress,
            dx:
              (displayFile(to.x, isFlipped, columns) - displayFile(from.x, isFlipped, columns)) *
                square -
              offset.x,
            dy:
              (displayRank(to.y, isFlipped, rows) - displayRank(from.y, isFlipped, rows)) * square -
              offset.y,
            landing: capture?.attackerTrackId === track.id ? landing : undefined,
          } satisfies CarriedMove,
        },
      ];
    });
  }, [boardSize, columns, isFlipped, rows, visibleReplayTransition]);
  const carriedFrom = useMemo(
    () => new Map(carriedPieces.map((carried) => [`${carried.from.x}:${carried.from.y}`, carried])),
    [carriedPieces],
  );

  const handleReplayTransitionComplete = useCallback((key: string) => {
    setReplayTransition((current) => (current?.key === key ? null : current));
  }, []);

  const handleCaptureEffectComplete = useCallback((key: string) => {
    setCaptureEffect((current) => (current?.key === key ? null : current));
  }, []);
  useCaptureEffectClock(visibleCaptureEffect, handleCaptureEffectComplete);

  // Where the effect is drawn, in pixels and as plain numbers, so its layers
  // can be memoised on them and are never restyled while they play.
  const squareSize = squareSizeFor(boardSize, shape);
  const captureGeometry = useMemo(() => {
    if (!visibleCaptureEffect) return null;
    const { from, to } = visibleCaptureEffect.capture;
    const column = displayFile(to.x, isFlipped, shape.columns);
    const row = displayRank(to.y, isFlipped, shape.rows);
    const across = column - displayFile(from.x, isFlipped, shape.columns);
    const down = row - displayRank(from.y, isFlipped, shape.rows);
    const length = Math.hypot(across, down) || 1;
    return {
      headingX: across / length,
      headingY: down / length,
      left: column * squareSize,
      pieceSize: pieceSizeForBoard(boardSize),
      squareSize,
      top: row * squareSize,
    };
  }, [boardSize, isFlipped, shape.columns, shape.rows, squareSize, visibleCaptureEffect]);
  const captureVictimLook = visibleCaptureEffect
    ? pieceLooks?.[visibleCaptureEffect.capture.victim.piece]
    : undefined;

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
              const tint = tintForTile(modeId, tile, shape, era);
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
              {analysisArrows.map((arrow, index) => {
                // Capped by rank rather than by position, so a suggestion that
                // needs two arrows still costs one of the five.
                const rank = arrowRank(arrow, index);
                if (rank >= MAXIMUM_ARROWS) return null;
                const ink = arrowInk(arrow, rank);
                const path = arrowPath({
                  fromX: fileCenter(arrow.from.x, isFlipped, shape.columns),
                  fromY: rankCenter(arrow.from.y, isFlipped, shape.rows),
                  toX: fileCenter(arrow.to.x, isFlipped, shape.columns),
                  toY: rankCenter(arrow.to.y, isFlipped, shape.rows),
                  width: ink.width,
                });
                if (!path) return null;
                // A twin is the same shape drawn hollow: the filled arrow is
                // traced instead of painted, so it reads as the same move at
                // the same weight in the same colour, and as the other one.
                return (
                  <Path
                    d={path}
                    fill={arrowColor(rank)}
                    fillOpacity={arrow.dashed ? TWIN_FILL_OPACITY : 1}
                    key={`${arrow.from.x}:${arrow.from.y}-${arrow.to.x}:${arrow.to.y}`}
                    opacity={ink.opacity}
                    stroke={arrow.dashed ? arrowColor(rank) : board.arrowOutline}
                    strokeDasharray={arrow.dashed ? TWIN_DASH : undefined}
                    strokeLinejoin="round"
                    strokeWidth={arrow.dashed ? TWIN_OUTLINE_WIDTH : ARROW_OUTLINE_WIDTH}
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
              {annotationArrows.map((arrow) => {
                const path = arrowPath({
                  fromX: fileCenter(arrow.from.x, isFlipped, shape.columns),
                  fromY: rankCenter(arrow.from.y, isFlipped, shape.rows),
                  toX: fileCenter(arrow.to.x, isFlipped, shape.columns),
                  toY: rankCenter(arrow.to.y, isFlipped, shape.rows),
                  width: ANNOTATION_ARROW_WIDTH,
                });
                if (!path) return null;
                return (
                  <Path
                    d={path}
                    fill={board.annotation}
                    key={`${arrow.from.x}:${arrow.from.y}-${arrow.to.x}:${arrow.to.y}`}
                    opacity={0.82}
                    stroke={board.arrowOutline}
                    strokeLinejoin="round"
                    strokeWidth={ARROW_OUTLINE_WIDTH}
                  />
                );
              })}
            </Svg>
          </View>
        )}

        {/*
          Beneath the pieces: what is left of the piece that fell. Placed
          before them at their own height, so the taker — moving, then settled
          — is always drawn over its victim.
        */}
        {visibleCaptureEffect && captureGeometry ? (
          <CaptureEffectLayer
            effect={visibleCaptureEffect}
            key={`${visibleCaptureEffect.key}:beneath`}
            layer="beneath"
            victimLook={captureVictimLook}
            {...captureGeometry}
          />
        ) : null}

        {/*
          A carried piece is drawn in the slot of the square it is leaving,
          under the key its view had as that square's piece a moment ago. Same
          key and same place in the list, so React hands it the very same view
          — picture already painted — rather than mounting a new one or moving
          the old one. See `CarriedMove`.
        */}
        {displayedGrid.flatMap((row, displayY) =>
          row.map((tile, displayX) => {
            if (tile.occupant === 'Empty') {
              const carried = carriedFrom.get(`${tile.x}:${tile.y}`);
              if (!carried) return null;
              // Every prop here holds still for the length of the move, so the
              // memo keeps the piece from re-rendering while it travels.
              return (
                <DraggablePiece
                  boardSize={boardSize}
                  shape={carried.shape}
                  look={pieceLooks?.[carried.tile.occupant]}
                  boardX={tile.x}
                  boardY={tile.y}
                  displayX={displayX}
                  displayY={displayY}
                  dragEnabled={false}
                  isFlipped={isFlipped}
                  // A dragged piece stays held until its move is over, which
                  // is what keeps it from springing back to the square it is
                  // leaving.
                  isHeld={carried.held}
                  isHidden={false}
                  isSelected={false}
                  key={`${tile.x}-${tile.y}`}
                  onDragActiveChange={ignoreDragActive}
                  onDragEnd={refuseDrop}
                  onDragStart={ignoreDragStart}
                  tile={carried.tile}
                  travel={carried.travel}
                />
              );
            }
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
                isHeld={samePosition(heldDrop?.from, position)}
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

        {visibleCaptureEffect && captureGeometry ? (
          <CaptureEffectLayer
            effect={visibleCaptureEffect}
            key={`${visibleCaptureEffect.key}:above`}
            layer="above"
            victimLook={captureVictimLook}
            {...captureGeometry}
          />
        ) : null}

        {displayedLastMove?.to && lastMoveGrade ? (
          <View
            pointerEvents="none"
            style={[
              styles.moveQualityBadgeLayout,
              {
                height: `${rowPercent(shape)}%`,
                left: `${displayFile(displayedLastMove.to.x, isFlipped, shape.columns) * columnPercent(shape)}%`,
                top: `${displayRank(displayedLastMove.to.y, isFlipped, shape.rows) * rowPercent(shape)}%`,
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

const styles = themedSheet(() => ({
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
  // Where the overlay's copy used to travel, so a piece carrying itself is
  // stacked exactly as that copy was: over the arrows, under a capture's top
  // layer, and — dragged there or not — no longer lifted.
  travellingPieceLayout: { zIndex: 6, elevation: 0 },
  moveQualityBadgeLayout: {
    position: 'absolute',
    zIndex: 7,
    alignItems: 'flex-end',
    paddingTop: 1,
    paddingRight: 1,
  },
  piece: { alignItems: 'center', justifyContent: 'center' },
  // Between the square's frame and the piece's grip. It hugs the piece, so
  // nothing about where the piece sits changes, and it lets touches through to
  // the grip the same way `pieceLayout` does.
  pieceTravel: {
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: IS_WEB ? 'none' : 'box-none',
  },
  // The piece takes the touch; the artwork inside it never does.
  //
  // `PieceIcon` used to draw a different tree once `dropShadow` turned on, so
  // the node under the finger was replaced the instant a drag was granted —
  // and a touch belongs for its whole life to the node it started on.
  // Detached, that node stops bubbling to the document, where
  // react-native-web's responder system listens, so the responder never heard
  // another move or the release: the piece sat still, sprang back, and the
  // *next* drag worked because the swap had already happened. This view is
  // rendered unconditionally, so `box-only` makes it the same target from
  // touch to release.
  //
  // `liftable` has since taken the swap out at the source — see the prop on
  // `PieceIcon`, and the note beside it above — but this stays: it is what
  // makes the target one node rather than whatever the artwork happens to be
  // drawn as, and the failure it prevents is silent.
  //
  // Registered here rather than written inline beside the transform, because
  // `box-only` is not a CSS value — only a style that reaches react-native-web's
  // compiler is expanded into the two rules it needs. Same trap as
  // `pieceLayout` above, and it fails the same silent way: the property is
  // dropped and the piece stops taking touches at all.
  pieceGrip: { pointerEvents: 'box-only' },
  pieceInert: { pointerEvents: 'none' },
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
}));
