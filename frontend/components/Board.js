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
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Defs, Line, Marker, Polygon } from 'react-native-svg';

import MoveQualityBadge from './MoveQualityBadge';
import PieceIcon from './PieceIcon';
import TileMark from './TileMark';
import {
  buildReplayPieceTracks,
  replayGridSignature,
} from '../engine/replayAnimation';
import { board, players, shadows } from '../theme';

const BOARD_SIZE = 9;
// Files and ranks as the archive writes them, so a square named on the
// board is the square named in the game's PGN.
const FILES = 'abcdefghi';
const MODE_ANNIHILATION = 'V1';
const MODE_INFILTRATION = 'V3';
const MODE_TOTAL_WAR = 'V5';
const TILE_PERCENTAGE = 100 / BOARD_SIZE;
const ANNOTATION_COLOR = board.annotation;
const RIGHT_BUTTON = 2;
const RIGHT_BUTTON_MASK = 2;
const IS_WEB = Platform.OS === 'web';
const BOARD_BORDER_WIDTH = 3;
const MOVE_ANIMATION_DURATION = 230;
// A catch-up finishes before even the fastest watched bot can make its next
// move (250ms), so reaching the live edge never makes the board fall behind.
const FAST_REPLAY_MAX_DURATION = 220;
const FAST_REPLAY_MIN_DURATION = 72;
const FAST_REPLAY_MOVE_DURATION = 12;

const samePosition = (first, second) => first?.x === second?.x && first?.y === second?.y;

const sameArrow = (first, second) =>
  samePosition(first?.from, second?.from) && samePosition(first?.to, second?.to);

const displayCenter = (value, isFlipped) =>
  (isFlipped ? BOARD_SIZE - 1 - value : value) + 0.5;

const displayCoordinate = (value, isFlipped) =>
  isFlipped ? BOARD_SIZE - 1 - value : value;

const pieceSizeForBoard = (boardSize) => Math.max(20, Math.min(46, boardSize / 12));
const moveBadgeSizeForBoard = (boardSize) =>
  Math.round(
    Math.max(
      13,
      Math.min(22, ((boardSize - BOARD_BORDER_WIDTH * 2) / BOARD_SIZE) * 0.36),
    ),
  );

const tintForTile = (modeId, tile) => {
  if (modeId === MODE_ANNIHILATION) return null;

  if (modeId === MODE_INFILTRATION) {
    if (tile.y === 0) return { color: 'Red', kind: 'goal' };
    if (tile.y === BOARD_SIZE - 1) return { color: 'Blue', kind: 'goal' };
    return null;
  }

  if (
    modeId === MODE_TOTAL_WAR &&
    (tile.ownerColor === 'Red' || tile.ownerColor === 'Blue')
  ) {
    return { color: tile.ownerColor, kind: 'territory' };
  }

  return null;
};

const positionFromDrag = (from, dx, dy, boardSize, isFlipped) => {
  const squareSize = (boardSize - BOARD_BORDER_WIDTH * 2) / BOARD_SIZE;
  const displayXOffset = Math.round(dx / squareSize);
  const displayYOffset = Math.round(dy / squareSize);
  const direction = isFlipped ? -1 : 1;
  const to = {
    x: from.x + displayXOffset * direction,
    y: from.y + displayYOffset * direction,
  };

  if (to.x < 0 || to.x >= BOARD_SIZE || to.y < 0 || to.y >= BOARD_SIZE) {
    return from;
  }
  return to;
};

const positionFromClientPoint = (rect, clientX, clientY, isFlipped) => {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;

  const displayX = Math.floor(((clientX - rect.left) / rect.width) * BOARD_SIZE);
  const displayY = Math.floor(((clientY - rect.top) / rect.height) * BOARD_SIZE);
  if (
    displayX < 0 ||
    displayX >= BOARD_SIZE ||
    displayY < 0 ||
    displayY >= BOARD_SIZE
  ) {
    return null;
  }

  return isFlipped
    ? { x: BOARD_SIZE - 1 - displayX, y: BOARD_SIZE - 1 - displayY }
    : { x: displayX, y: displayY };
};

const DraggablePiece = memo(function DraggablePiece({
  boardSize,
  boardX,
  boardY,
  dragEnabled,
  displayX,
  displayY,
  isFlipped,
  isSelected,
  onDragEnd,
  onDragStart,
  tile,
}) {
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
  const latest = useRef(null);
  latest.current = {
    boardSize,
    dragEnabled,
    isFlipped,
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
          );
          setIsDragging(false);
          latest.current.onDragEnd(position, to);
          resetPosition();
        },
        onPanResponderTerminate: () => {
          setIsDragging(false);
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
          height: `${TILE_PERCENTAGE}%`,
          left: `${displayX * TILE_PERCENTAGE}%`,
          top: `${displayY * TILE_PERCENTAGE}%`,
          width: `${TILE_PERCENTAGE}%`,
        },
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
          size={pieceSize}
        />
      </NativeAnimated.View>
    </View>
  );
});

const replayPieceOpacity = (progress, track, steps) => {
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

const ReplayPiece = memo(function ReplayPiece({
  boardSize,
  isFlipped,
  progress,
  steps,
  track,
}) {
  const pieceSize = pieceSizeForBoard(boardSize);
  const squareSize = (boardSize - BOARD_BORDER_WIDTH * 2) / BOARD_SIZE;
  const positions = track.positions.slice(track.startStep, track.endStep + 1);
  const first = positions[0];
  const inputRange = positions.map((unused, index) => track.startStep + index);
  const offsetFor = (position, axis) =>
    (displayCoordinate(position[axis], isFlipped) -
      displayCoordinate(first[axis], isFlipped)) *
    squareSize;
  const translate = (axis) => {
    if (inputRange.length < 2) return 0;
    return progress.interpolate({
      inputRange,
      outputRange: positions.map((position) => offsetFor(position, axis)),
      extrapolate: 'clamp',
    });
  };

  return (
    <NativeAnimated.View
      pointerEvents="none"
      style={[
        styles.pieceLayout,
        styles.movingPieceLayout,
        {
          height: `${TILE_PERCENTAGE}%`,
          left: `${displayCoordinate(first.x, isFlipped) * TILE_PERCENTAGE}%`,
          opacity: replayPieceOpacity(progress, track, steps),
          top: `${displayCoordinate(first.y, isFlipped) * TILE_PERCENTAGE}%`,
          width: `${TILE_PERCENTAGE}%`,
          transform: [
            { translateX: translate('x') },
            { translateY: translate('y') },
          ],
        },
      ]}
    >
      <PieceIcon piece={track.piece} color={track.color} size={pieceSize} />
    </NativeAnimated.View>
  );
});

const ReplayTransition = memo(function ReplayTransition({
  boardSize,
  isFlipped,
  onComplete,
  transition,
}) {
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
      isFlipped={isFlipped}
      key={track.id}
      progress={progress}
      steps={transition.steps}
      track={track}
    />
  ));
});

export default function Board({
  analysisArrows = [],
  boardSize,
  canMove,
  grid,
  lastMove,
  lastMoveGrade = null,
  modeId,
  movableColor,
  onPieceDrop,
  onTilePress,
  playerColor,
  replayIndex = null,
  replayPositions = null,
  selectedTile,
  validMoves,
}) {
  const isFlipped = playerColor === 'Blue';
  const moveBadgeSize = moveBadgeSizeForBoard(boardSize);
  const activeMoveColor = movableColor ?? playerColor;
  const validMoveKeys = new Set(validMoves.map(({ x, y }) => `${x}:${y}`));
  const displayedGrid = useMemo(() => {
    if (!isFlipped) return grid;
    return [...grid].reverse().map((row) => [...row].reverse());
  }, [grid, isFlipped]);

  const handleDragStart = useCallback(
    (position) => {
      onTilePress(position);
    },
    [onTilePress],
  );

  const handleDragEnd = useCallback(
    (from, to) => {
      if (!samePosition(from, to)) onPieceDrop(from, to);
    },
    [onPieceDrop],
  );

  const surfaceRef = useRef(null);
  const arrowOrigin = useRef(null);
  const [highlights, setHighlights] = useState([]);
  const [arrows, setArrows] = useState([]);
  const [pendingArrow, setPendingArrow] = useState(null);

  const positionSignature = useMemo(
    () => replayGridSignature(grid),
    [grid],
  );
  const displayedPositionKey = Number.isInteger(replayIndex)
    ? `${replayIndex}:${positionSignature}`
    : positionSignature;
  const previousGrid = useRef(grid);
  const previousReplayIndex = useRef(replayIndex);
  const [replayTransition, setReplayTransition] = useState(null);

  // Work out the requested transition during the render that receives the new
  // grid. Waiting until an effect to do this lets the destination position
  // flash first: on rewind that looks like B teleports back, then the previous
  // move A animates. Rendering this request immediately keeps the old position
  // on screen until B has actually travelled back to its origin.
  const before = previousGrid.current;
  const beforeIndex = previousReplayIndex.current;
  const beforeSignature = replayGridSignature(before);
  const replayIndexChanged =
    Number.isInteger(beforeIndex) &&
    Number.isInteger(replayIndex) &&
    beforeIndex !== replayIndex;
  const positionChanged =
    beforeSignature !== positionSignature || replayIndexChanged;
  let requestedReplayTransition = null;

  if (positionChanged) {
    let grids = [before, grid];
    if (
      Number.isInteger(beforeIndex) &&
      Number.isInteger(replayIndex) &&
      Math.abs(replayIndex - beforeIndex) > 1 &&
      Array.isArray(replayPositions)
    ) {
      const direction = replayIndex > beforeIndex ? 1 : -1;
      const candidate = [];
      for (
        let index = beforeIndex;
        direction > 0 ? index <= replayIndex : index >= replayIndex;
        index += direction
      ) {
        const position = replayPositions[index];
        const candidateGrid = position?.grid ?? position;
        if (!Array.isArray(candidateGrid)) {
          candidate.length = 0;
          break;
        }
        candidate.push(candidateGrid);
      }
      if (
        candidate.length > 1 &&
        replayGridSignature(candidate[0]) === beforeSignature &&
        replayGridSignature(candidate[candidate.length - 1]) === positionSignature
      ) {
        grids = candidate;
      }
    }

    const replay = buildReplayPieceTracks(grids);
    if (replay) {
      requestedReplayTransition = {
        ...replay,
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

  const handleReplayTransitionComplete = useCallback((key) => {
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
    (event) => {
      const rect = surfaceRef.current?.getBoundingClientRect?.();
      return positionFromClientPoint(rect, event.clientX, event.clientY, isFlipped);
    },
    [isFlipped],
  );

  const handleMouseDown = useCallback(
    (event) => {
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
    (event) => {
      if (!arrowOrigin.current) return;
      const source = event.nativeEvent ?? event;
      if ((source.buttons & RIGHT_BUTTON_MASK) === 0) {
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
    (event) => {
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

      const arrow = { from, to };
      setArrows((current) =>
        current.some((candidate) => sameArrow(candidate, arrow))
          ? current.filter((candidate) => !sameArrow(candidate, arrow))
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
        onContextMenu: (event) => event.preventDefault(),
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
      ...arrows.filter((candidate) => !sameArrow(candidate, pendingArrow)),
      pendingArrow,
    ];
  }, [arrows, pendingArrow]);

  return (
    <View
      accessibilityLabel="Nine by nine game board"
      style={[styles.boardFrame, { width: boardSize, height: boardSize }]}
    >
      <View ref={surfaceRef} style={styles.boardSurface} {...annotationHandlers}>
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
              const tint = tintForTile(modeId, tile);
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
                  }${tile.y + 1}${tintLabel}${selectionLabel}${highlightLabel}${lastMoveLabel}`}
                  onPress={() => onTilePress(position)}
                  style={[
                    styles.tile,
                    isLight ? styles.lightTile : styles.darkTile,
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
                  {displayY === BOARD_SIZE - 1 && (
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
          <Svg
            aria-hidden
            style={styles.analysisLayer}
            viewBox="0 0 9 9"
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
              const fromX = displayCenter(arrow.from.x, isFlipped);
              const fromY = displayCenter(arrow.from.y, isFlipped);
              const toX = displayCenter(arrow.to.x, isFlipped);
              const toY = displayCenter(arrow.to.y, isFlipped);
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
        )}

        {annotationArrows.length > 0 && (
          <Svg aria-hidden style={styles.annotationLayer} viewBox="0 0 9 9">
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
                x1={displayCenter(arrow.from.x, isFlipped)}
                x2={displayCenter(arrow.to.x, isFlipped)}
                y1={displayCenter(arrow.from.y, isFlipped)}
                y2={displayCenter(arrow.to.y, isFlipped)}
              />
            ))}
          </Svg>
        )}

        {!visibleReplayTransition &&
          displayedGrid.flatMap((row, displayY) =>
            row.map((tile, displayX) => {
              if (tile.occupant === 'Empty') return null;
              const position = { x: tile.x, y: tile.y };
              const dragEnabled = canMove && tile.occupantOwner === activeMoveColor;

              return (
                <DraggablePiece
                  boardSize={boardSize}
                  boardX={tile.x}
                  boardY={tile.y}
                  displayX={displayX}
                  displayY={displayY}
                  dragEnabled={dragEnabled}
                  isFlipped={isFlipped}
                  isSelected={samePosition(selectedTile, position)}
                  key={`${tile.x}-${tile.y}`}
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
                height: `${TILE_PERCENTAGE}%`,
                left: `${displayCoordinate(displayedLastMove.to.x, isFlipped) * TILE_PERCENTAGE}%`,
                top: `${displayCoordinate(displayedLastMove.to.y, isFlipped) * TILE_PERCENTAGE}%`,
                width: `${TILE_PERCENTAGE}%`,
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
  analysisLayer: { ...StyleSheet.absoluteFillObject, zIndex: 4, pointerEvents: 'none' },
  annotationLayer: { ...StyleSheet.absoluteFillObject, zIndex: 5, pointerEvents: 'none' },
  tile: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  lightTile: { backgroundColor: board.lightTile },
  darkTile: { backgroundColor: board.darkTile },
  tileTint: {
    ...StyleSheet.absoluteFillObject,
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
  lastMoveTint: { ...StyleSheet.absoluteFillObject, zIndex: 1, pointerEvents: 'none' },
  lastMoveMark: { zIndex: 1 },
  lastMoveFromTint: { backgroundColor: board.lastMoveFrom },
  lastMoveToTint: { backgroundColor: board.lastMoveTo },
  selectionTint: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
    pointerEvents: 'none',
    backgroundColor: board.selectionTint,
  },
  selectionMark: { zIndex: 1 },
  annotationTint: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
    pointerEvents: 'none',
    backgroundColor: board.annotationTint,
  },
  annotationMark: { zIndex: 2 },
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
  draggablePiece: { cursor: 'grab' },
  draggingPiece: {
    cursor: 'grabbing',
  },
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
