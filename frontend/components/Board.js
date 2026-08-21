import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated as NativeAnimated,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import Svg, { Defs, Line, Marker, Polygon } from 'react-native-svg';

import PieceIcon from './PieceIcon';

const BOARD_SIZE = 9;
const FILES = 'ABCDEFGHI';
const MODE_ANNIHILATION = 'V1';
const MODE_INFILTRATION = 'V3';
const MODE_TOTAL_WAR = 'V5';
const TILE_PERCENTAGE = 100 / BOARD_SIZE;
const ANNOTATION_COLOR = '#f2811d';
const RIGHT_BUTTON = 2;
const RIGHT_BUTTON_MASK = 2;
const IS_WEB = Platform.OS === 'web';

const samePosition = (first, second) => first?.x === second?.x && first?.y === second?.y;

const sameArrow = (first, second) =>
  samePosition(first?.from, second?.from) && samePosition(first?.to, second?.to);

const displayCenter = (value, isFlipped) =>
  (isFlipped ? BOARD_SIZE - 1 - value : value) + 0.5;

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
  const squareSize = boardSize / BOARD_SIZE;
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
  dragEnabled,
  displayX,
  displayY,
  isFlipped,
  isSelected,
  onDragEnd,
  onDragStart,
  position,
  tile,
}) {
  const translation = useRef(new NativeAnimated.ValueXY()).current;
  const [isDragging, setIsDragging] = useState(false);
  const pieceSize = Math.max(20, Math.min(46, boardSize / 12));

  const resetPosition = useCallback(() => {
    NativeAnimated.spring(translation, {
      toValue: { x: 0, y: 0 },
      damping: 18,
      stiffness: 260,
      mass: 0.55,
      useNativeDriver: false,
    }).start();
  }, [translation]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => dragEnabled,
        onMoveShouldSetPanResponder: (_, gesture) =>
          dragEnabled && Math.abs(gesture.dx) + Math.abs(gesture.dy) > 4,
        onPanResponderGrant: () => {
          setIsDragging(true);
          onDragStart(position);
        },
        onPanResponderMove: (_, gesture) => {
          translation.setValue({ x: gesture.dx, y: gesture.dy });
        },
        onPanResponderRelease: (_, gesture) => {
          const to = positionFromDrag(
            position,
            gesture.dx,
            gesture.dy,
            boardSize,
            isFlipped,
          );
          setIsDragging(false);
          onDragEnd(position, to);
          resetPosition();
        },
        onPanResponderTerminate: () => {
          setIsDragging(false);
          resetPosition();
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [
      boardSize,
      dragEnabled,
      isFlipped,
      onDragEnd,
      onDragStart,
      position,
      resetPosition,
      translation,
    ],
  );

  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(140)}
      layout={LinearTransition.springify().damping(19)}
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
        <PieceIcon piece={tile.occupant} color={tile.occupantOwner} size={pieceSize} />
      </NativeAnimated.View>
    </Animated.View>
  );
});

export default function Board({
  analysisArrows = [],
  boardSize,
  canMove,
  grid,
  lastMove,
  modeId,
  movableColor,
  onPieceDrop,
  onTilePress,
  playerColor,
  selectedTile,
  validMoves,
}) {
  const isFlipped = playerColor === 'Blue';
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
    () =>
      grid
        .map((row) => row.map((tile) => `${tile.occupant}${tile.occupantOwner}`).join())
        .join('|'),
    [grid],
  );

  const clearAnnotations = useCallback(() => {
    arrowOrigin.current = null;
    setPendingArrow(null);
    setHighlights((current) => (current.length ? [] : current));
    setArrows((current) => (current.length ? [] : current));
  }, []);

  // Chess.com behaviour: annotations survive only until the next move is played.
  useEffect(() => {
    clearAnnotations();
  }, [clearAnnotations, positionSignature]);

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
              const isLastMoveFrom = samePosition(lastMove?.from, position);
              const isLastMoveTo = samePosition(lastMove?.to, position);
              const tint = tintForTile(modeId, tile);
              const tintLabel = tint
                ? tint.kind === 'goal'
                  ? `, ${tint.color} goal tile`
                  : `, captured by ${tint.color}`
                : '';
              const highlightLabel = isHighlighted ? ', marked' : '';
              const lastMoveLabel = isLastMoveFrom
                ? ', previous move origin'
                : isLastMoveTo
                  ? ', previous move destination'
                  : '';

              return (
                <Pressable
                  key={`${tile.x}-${tile.y}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${tile.occupantOwner} ${tile.occupant} on ${
                    FILES[tile.x]
                  }${BOARD_SIZE - tile.y}${tintLabel}${highlightLabel}${lastMoveLabel}`}
                  onPress={() => onTilePress(position)}
                  style={[
                    styles.tile,
                    isLight ? styles.lightTile : styles.darkTile,
                    isSelected && styles.selectedTile,
                  ]}
                >
                  {tint && (
                    <View
                      style={[
                        styles.tileTint,
                        tint.color === 'Red' ? styles.redTint : styles.blueTint,
                        tint.kind === 'goal' && styles.goalTint,
                      ]}
                    />
                  )}
                  {(isLastMoveFrom || isLastMoveTo) && (
                    <View
                      style={[
                        styles.lastMoveTint,
                        isLastMoveFrom ? styles.lastMoveFromTint : styles.lastMoveToTint,
                      ]}
                    />
                  )}
                  {isSelected && <View style={styles.selectionTint} />}
                  {isHighlighted && <View style={styles.annotationTint} />}
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
                      {BOARD_SIZE - tile.y}
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
                const color = ['#51d6a9', '#55a9ff', '#f0b857'][index];
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
              const color = ['#51d6a9', '#55a9ff', '#f0b857'][index];
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

        {displayedGrid.flatMap((row, displayY) =>
          row.map((tile, displayX) => {
            if (tile.occupant === 'Empty') return null;
            const position = { x: tile.x, y: tile.y };
            const dragEnabled = canMove && tile.occupantOwner === activeMoveColor;

            return (
              <DraggablePiece
                boardSize={boardSize}
                displayX={displayX}
                displayY={displayY}
                dragEnabled={dragEnabled}
                isFlipped={isFlipped}
                isSelected={samePosition(selectedTile, position)}
                key={`${tile.x}-${tile.y}`}
                onDragEnd={handleDragEnd}
                onDragStart={handleDragStart}
                position={position}
                tile={tile}
              />
            );
          }),
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  boardFrame: {
    borderWidth: 3,
    borderColor: '#202631',
    borderRadius: 10,
    backgroundColor: '#202631',
    boxShadow: [
      { offsetX: 0, offsetY: 10, blurRadius: 16, color: 'rgba(0, 0, 0, 0.32)' },
    ],
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
  lightTile: { backgroundColor: '#d8d1c1' },
  darkTile: { backgroundColor: '#6f8f8c' },
  tileTint: { ...StyleSheet.absoluteFillObject, pointerEvents: 'none' },
  redTint: { backgroundColor: 'rgba(190, 56, 65, 0.42)' },
  blueTint: { backgroundColor: 'rgba(47, 111, 174, 0.42)' },
  goalTint: {
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.28)',
  },
  lastMoveTint: { ...StyleSheet.absoluteFillObject, zIndex: 1, pointerEvents: 'none' },
  lastMoveFromTint: { backgroundColor: 'rgba(45, 204, 165, 0.17)' },
  lastMoveToTint: {
    backgroundColor: 'rgba(45, 204, 165, 0.3)',
    borderWidth: 1,
    borderColor: 'rgba(220, 255, 247, 0.42)',
  },
  selectedTile: {
    borderWidth: 2,
    borderColor: '#ffe497',
  },
  selectionTint: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
    pointerEvents: 'none',
    backgroundColor: 'rgba(242, 192, 67, 0.38)',
  },
  annotationTint: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
    pointerEvents: 'none',
    backgroundColor: 'rgba(242, 129, 29, 0.78)',
  },
  validDot: {
    position: 'absolute',
    zIndex: 2,
    pointerEvents: 'none',
    width: '24%',
    aspectRatio: 1,
    borderRadius: 30,
    backgroundColor: 'rgba(21, 39, 38, 0.42)',
  },
  captureRing: {
    position: 'absolute',
    zIndex: 2,
    pointerEvents: 'none',
    width: '84%',
    aspectRatio: 1,
    borderRadius: 50,
    borderWidth: 4,
    borderColor: 'rgba(21, 39, 38, 0.42)',
  },
  pieceLayout: {
    position: 'absolute',
    zIndex: 3,
    pointerEvents: 'box-none',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedPieceLayout: { zIndex: 3 },
  draggingPieceLayout: { zIndex: 100, elevation: 24 },
  piece: { alignItems: 'center', justifyContent: 'center' },
  draggablePiece: { cursor: 'grab' },
  draggingPiece: {
    cursor: 'grabbing',
    boxShadow: [
      { offsetX: 0, offsetY: 7, blurRadius: 7, color: 'rgba(0, 0, 0, 0.4)' },
    ],
    elevation: 12,
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
  labelOnLight: { color: '#547774' },
  labelOnDark: { color: '#e5ded0' },
});
