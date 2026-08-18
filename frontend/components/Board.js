import { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated as NativeAnimated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import PieceIcon from './PieceIcon';

const BOARD_SIZE = 9;
const FILES = 'ABCDEFGHI';

const samePosition = (first, second) => first?.x === second?.x && first?.y === second?.y;

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

const DraggablePiece = memo(function DraggablePiece({
  boardSize,
  dragEnabled,
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
      style={[styles.pieceLayout, (isSelected || isDragging) && styles.selectedPiece]}
    >
      <NativeAnimated.View
        {...panResponder.panHandlers}
        style={[
          styles.piece,
          dragEnabled && styles.draggablePiece,
          isDragging && styles.draggingPiece,
          {
            transform: [
              ...translation.getTranslateTransform(),
              { scale: isDragging ? 1.14 : 1 },
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
  boardSize,
  canMove,
  grid,
  onPieceDrop,
  onTilePress,
  playerColor,
  selectedTile,
  validMoves,
}) {
  const isFlipped = playerColor === 'Blue';
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

  return (
    <View
      accessibilityLabel="Nine by nine game board"
      style={[styles.board, { width: boardSize, height: boardSize }]}
    >
      {displayedGrid.map((row, displayY) => (
        <View key={`row-${displayY}`} style={styles.row}>
          {row.map((tile, displayX) => {
            const position = { x: tile.x, y: tile.y };
            const isSelected = samePosition(selectedTile, position);
            const isValid = validMoveKeys.has(`${tile.x}:${tile.y}`);
            const isCapture = isValid && tile.occupant !== 'Empty';
            const isLight = (tile.x + tile.y) % 2 === 0;
            const dragEnabled =
              canMove && tile.occupant !== 'Empty' && tile.occupantOwner === playerColor;

            return (
              <Pressable
                key={`${tile.x}-${tile.y}`}
                accessibilityRole="button"
                accessibilityLabel={`${tile.occupantOwner} ${tile.occupant} on ${FILES[tile.x]}${BOARD_SIZE - tile.y}`}
                onPress={() => onTilePress(position)}
                style={[
                  styles.tile,
                  isLight ? styles.lightTile : styles.darkTile,
                  tile.ownerColor === 'Red' && styles.redTerritory,
                  tile.ownerColor === 'Blue' && styles.blueTerritory,
                  isSelected && styles.selectedTile,
                ]}
              >
                {isValid &&
                  (isCapture ? <View style={styles.captureRing} /> : <View style={styles.validDot} />)}

                {tile.occupant !== 'Empty' && (
                  <DraggablePiece
                    boardSize={boardSize}
                    dragEnabled={dragEnabled}
                    isFlipped={isFlipped}
                    isSelected={isSelected}
                    onDragEnd={handleDragEnd}
                    onDragStart={handleDragStart}
                    position={position}
                    tile={tile}
                  />
                )}

                {displayX === 0 && (
                  <Text style={[styles.rankLabel, isLight ? styles.labelOnLight : styles.labelOnDark]}>
                    {BOARD_SIZE - tile.y}
                  </Text>
                )}
                {displayY === BOARD_SIZE - 1 && (
                  <Text style={[styles.fileLabel, isLight ? styles.labelOnLight : styles.labelOnDark]}>
                    {FILES[tile.x]}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  board: {
    borderWidth: 3,
    borderColor: '#202631',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#202631',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.32,
    shadowRadius: 16,
    elevation: 8,
  },
  row: { flex: 1, flexDirection: 'row' },
  tile: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lightTile: { backgroundColor: '#d8d1c1' },
  darkTile: { backgroundColor: '#6f8f8c' },
  redTerritory: { backgroundColor: '#b86b66' },
  blueTerritory: { backgroundColor: '#6285a3' },
  selectedTile: {
    backgroundColor: '#d5bb63',
    borderWidth: 2,
    borderColor: '#ffe497',
  },
  validDot: {
    position: 'absolute',
    zIndex: 1,
    width: '24%',
    aspectRatio: 1,
    borderRadius: 30,
    backgroundColor: 'rgba(21, 39, 38, 0.42)',
  },
  captureRing: {
    position: 'absolute',
    zIndex: 1,
    width: '84%',
    aspectRatio: 1,
    borderRadius: 50,
    borderWidth: 4,
    borderColor: 'rgba(21, 39, 38, 0.42)',
  },
  pieceLayout: { zIndex: 2, alignItems: 'center', justifyContent: 'center' },
  piece: { alignItems: 'center', justifyContent: 'center' },
  draggablePiece: { cursor: 'grab' },
  draggingPiece: {
    zIndex: 20,
    cursor: 'grabbing',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.4,
    shadowRadius: 7,
    elevation: 12,
  },
  selectedPiece: { transform: [{ scale: 1.08 }] },
  rankLabel: {
    position: 'absolute',
    top: 2,
    left: 3,
    fontSize: 7,
    fontWeight: '900',
  },
  fileLabel: {
    position: 'absolute',
    right: 3,
    bottom: 2,
    fontSize: 7,
    fontWeight: '900',
  },
  labelOnLight: { color: '#547774' },
  labelOnDark: { color: '#e5ded0' },
});
