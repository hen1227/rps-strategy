import { memo, useId, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { Defs, Line, Marker, Polygon } from 'react-native-svg';

import PieceIcon from './PieceIcon';
import TileMark from './TileMark';
import { overlayCellAt, type BoardOverlay } from './overlay';
import type { PieceLook } from '@/engine/spec/interpret';
import { tintForTile } from './tint';
import { board, players } from '@/theme';
import { boardHeight, boardWidth, type Grid, type ModeID, type Move, type SideColor } from '@/types/game';

// A board nobody can touch.
//
// The live board is nine hundred lines of dragging, arrows, animation and
// accessibility, none of which a picture of a position needs — and a picture
// of a position is what the lobby thumbnail and every opening-book diagram
// actually are. What they must not have is a second opinion about how a board
// looks, which is why the tiles, the tints and the marks all come from the
// same modules the real board uses.

/**
 * A piece that fills most of its square, at whatever size the board is.
 *
 * `across` is the longer side of the board in tiles, because that is what the
 * square edge divides into: a rectangle fits inside the space given to it by
 * its longer side and leaves the rest empty, the same rule the live board uses.
 */
const pieceSizeFor = (size: number, across: number) =>
  Math.max(5, Math.round((size / Math.max(across, 1)) * 0.92));

/** Below this the corner marks need their tighter geometry to read at all. */
const COMPACT_BELOW = 260;

// How far the move arrow keeps clear of the two piece icons it runs between,
// in squares. A book move is a single step, so the whole arrow is about one
// square long and the head is most of it: any less clearance and the head
// disappears under the piece it is pointing at.
const ARROW_TAIL_CLEARANCE = 0.26;
const ARROW_HEAD_CLEARANCE = 0.2;

export interface MiniBoardProps {
  /** Ring the destination, to say the move took a piece. */
  capture?: boolean;
  grid: Grid;
  /** Decides the goal ranks and whether territory is drawn. */
  modeId?: ModeID;
  /**
   * How each kind is drawn, for a mode that declared its own kinds: the
   * artwork it borrows, and the letter it falls back to without one. Absent for
   * the built-in modes, whose ids name their own artwork. See `looksFor`.
   */
  pieceLooks?: Record<string, PieceLook>;
  /**
   * A picture painted under the whole board, from the mode's `board.art`.
   *
   * Absent for every built-in mode. Fill it with `modeBackground`.
   */
  boardBackground?: string;
  /** Drawn on top: both squares marked, and an arrow between them. */
  move?: Move | null;
  /** Whose arrow it is. Defaults to whoever now stands on the destination. */
  mover?: SideColor;
  /** A finished per-square decoration from an analysis. See `./overlay.ts`. */
  overlay?: BoardOverlay | null;
  /** Overrides the piece artwork size, for a diagram tuned by hand. */
  pieceSize?: number;
  /**
   * The square the board is drawn inside, in points. A board that is not square
   * fills it by its longer side, so the picture keeps square tiles.
   */
  size: number;
}

export default memo(function MiniBoard({
  capture = false,
  grid,
  modeId,
  pieceLooks,
  boardBackground,
  move,
  mover,
  overlay = null,
  pieceSize,
  size,
}: MiniBoardProps) {
  // Several of these diagrams share a page, and an SVG marker is addressed by
  // a document-wide id, so a fixed one would give every arrow on the screen the
  // colour of whichever board rendered first.
  const arrowId = `mini-board-arrow-${useId().replace(/:/g, '')}`;
  // Even a diagram needs this: without it a background that will not load leaves
  // the tiles dimmed over nothing, which reads worse than no picture at all.
  const [backgroundFailed, setBackgroundFailed] = useState<string | null>(null);
  const overArt = Boolean(boardBackground) && boardBackground !== backgroundFailed;
  // The shape comes from the grid: a mode may be any rectangle.
  const columns = boardWidth(grid);
  const rows = boardHeight(grid);
  const square = size / Math.max(columns, rows, 1);
  const pieces = pieceSize ?? pieceSizeFor(size, Math.max(columns, rows));
  const compact = size < COMPACT_BELOW;
  const destination = move ? grid[move.to.y]?.[move.to.x] : null;
  const arrowOwner = mover ?? (destination?.occupantOwner === 'Blue' ? 'Blue' : 'Red');
  const arrowColor = players[arrowOwner].strong;

  // Centre to centre, pulled back at both ends. In viewBox units one square is
  // one unit, so the clearances above are literal fractions of a square.
  const span = move
    ? Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) || 1
    : 1;
  const stepX = move ? (move.to.x - move.from.x) / span : 0;
  const stepY = move ? (move.to.y - move.from.y) / span : 0;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.board, { width: square * columns, height: square * rows }]}
    >
      {overArt ? (
        // Inert, for the reason Board's copy of this states: an overlay across
        // the board swallows every touch on Fabric.
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
      {grid.map((row, y) => (
        <View key={`row-${y}`} style={styles.row}>
          {row.map((tile, x) => {
            const tint = tintForTile(modeId, tile, rows);
            const overlayCell = overlayCellAt(overlay, x, y);
            const isFrom = move?.from.x === x && move.from.y === y;
            const isTo = move?.to.x === x && move.to.y === y;

            return (
              <View
                key={`${x}-${y}`}
                style={[
                  styles.tile,
                  (x + y) % 2 === 0 ? styles.lightTile : styles.darkTile,
                  overArt && ((x + y) % 2 === 0 ? styles.lightTileOverArt : styles.darkTileOverArt),
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
                    <TileMark compact={compact} owner={tint.color} variant={tint.kind} />
                  </>
                )}
                {overlayCell?.fill && (
                  <View
                    style={[
                      styles.overlayFill,
                      { backgroundColor: overlayCell.fill },
                      overlayCell.dim && styles.overlayDim,
                    ]}
                  />
                )}
                {overlayCell?.ring && (
                  <View style={[styles.overlayRing, { borderColor: overlayCell.ring }]} />
                )}
                {(isFrom || isTo) && (
                  <>
                    <View
                      style={[
                        styles.moveTint,
                        isFrom ? styles.moveFromTint : styles.moveToTint,
                      ]}
                    />
                    <TileMark
                      compact={compact}
                      style={styles.moveMark}
                      variant={isFrom ? 'moveFrom' : 'moveTo'}
                    />
                  </>
                )}
                <View style={styles.pieceLayer}>
                  <PieceIcon
                    color={tile.occupantOwner}
                    piece={tile.occupant}
                    look={pieceLooks?.[tile.occupant]}
                    size={pieces}
                  />
                </View>
                {isTo && capture && <View style={styles.captureRing} />}
              </View>
            );
          })}
        </View>
      ))}

      {move && (
        <Svg aria-hidden style={styles.arrowLayer} viewBox={`0 0 ${columns} ${rows}`}>
          <Defs>
            <Marker
              id={arrowId}
              markerHeight="4"
              markerUnits="strokeWidth"
              markerWidth="4"
              orient="auto"
              refX="8"
              refY="5"
              viewBox="0 0 10 10"
            >
              <Polygon fill={arrowColor} points="0,0 10,5 0,10 2.5,5" />
            </Marker>
          </Defs>
          <Line
            markerEnd={`url(#${arrowId})`}
            opacity={0.95}
            stroke={arrowColor}
            strokeLinecap="round"
            strokeWidth={0.13}
            x1={move.from.x + 0.5 + stepX * ARROW_TAIL_CLEARANCE}
            x2={move.to.x + 0.5 - stepX * ARROW_HEAD_CLEARANCE}
            y1={move.from.y + 0.5 + stepY * ARROW_TAIL_CLEARANCE}
            y2={move.to.y + 0.5 - stepY * ARROW_HEAD_CLEARANCE}
          />
        </Svg>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  board: {
    overflow: 'hidden',
    pointerEvents: 'none',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: board.frame,
    backgroundColor: board.frame,
  },
  row: { flex: 1, flexDirection: 'row' },
  tile: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
  tileTint: { ...StyleSheet.absoluteFill, borderWidth: 0.5 },
  redTint: { backgroundColor: players.Red.tint, borderColor: players.Red.tintBorder },
  blueTint: { backgroundColor: players.Blue.tint, borderColor: players.Blue.tintBorder },
  goalTint: { borderColor: board.goalOutline },
  // No numbers at this size — a thumbnail takes the wash and the outline only.
  overlayFill: { ...StyleSheet.absoluteFill },
  overlayRing: {
    position: 'absolute',
    zIndex: 2,
    top: 1,
    right: 1,
    bottom: 1,
    left: 1,
    borderRadius: 2,
    borderWidth: 1,
  },
  overlayDim: { opacity: 0.35 },
  moveTint: { ...StyleSheet.absoluteFill, zIndex: 1 },
  moveFromTint: { backgroundColor: board.lastMoveFrom },
  moveToTint: { backgroundColor: board.lastMoveTo },
  moveMark: { zIndex: 1 },
  // Above the move tint. A destination square is washed with 70% green, and a
  // piece painted underneath it comes out olive — which is exactly the piece
  // the diagram exists to point at.
  pieceLayer: { zIndex: 2 },
  captureRing: {
    position: 'absolute',
    zIndex: 3,
    width: '84%',
    aspectRatio: 1,
    borderRadius: 50,
    borderWidth: 2,
    borderColor: board.moveHint,
  },
  arrowLayer: { ...StyleSheet.absoluteFill, zIndex: 4 },
});
