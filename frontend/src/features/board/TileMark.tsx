import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { board, players } from '@/theme';
import type { PlayerColor } from '@/types/game';

// What a tile is marked with, drawn as outlines rather than fills.
//
// The marks have to read at every size the board is drawn at — a 620px analysis
// board and a 90px lobby thumbnail — which is why they are corners and rails
// rather than icons, and why `compact` exists.

/** What a mark is saying about its tile. */
export type TileMarkVariant =
  | 'territory'
  | 'goal'
  | 'moveFrom'
  | 'moveTo'
  | 'selection'
  | 'annotation';

type VerticalEdge = 'top' | 'bottom';
type HorizontalEdge = 'left' | 'right';
type Corner = readonly [VerticalEdge, HorizontalEdge];

const ALL_CORNERS: readonly Corner[] = [
  ['top', 'left'],
  ['top', 'right'],
  ['bottom', 'left'],
  ['bottom', 'right'],
];
const TOP_CORNERS = ALL_CORNERS.slice(0, 2);
const BOTTOM_CORNERS = ALL_CORNERS.slice(2);

/**
 * One corner bracket.
 *
 * Written out per edge rather than built from computed keys: `border${edge}Width`
 * is exactly the kind of string a style object accepts silently and then
 * ignores when the edge name is wrong.
 */
const cornerStyle = (
  [vertical, horizontal]: Corner,
  { inset, borderWidth, markColor }: { inset: number; borderWidth: number; markColor: string },
): ViewStyle => ({
  ...(vertical === 'top'
    ? { top: inset, borderTopColor: markColor, borderTopWidth: borderWidth }
    : { bottom: inset, borderBottomColor: markColor, borderBottomWidth: borderWidth }),
  ...(horizontal === 'left'
    ? { left: inset, borderLeftColor: markColor, borderLeftWidth: borderWidth }
    : { right: inset, borderRightColor: markColor, borderRightWidth: borderWidth }),
});

interface OutlineCornersProps {
  compact?: boolean;
  corners?: readonly Corner[];
  inset?: number;
  markColor: string;
  quiet?: boolean;
}

function OutlineCorners({
  compact = false,
  corners = ALL_CORNERS,
  inset = 3,
  markColor,
  quiet,
}: OutlineCornersProps) {
  const edgeInset = compact ? 1 : inset;
  const borderWidth = compact || quiet ? 1 : 1.5;
  const width = compact ? '30%' : quiet ? '15%' : '19%';

  return corners.map((corner) => (
    <View
      key={`${corner[0]}-${corner[1]}`}
      style={[
        styles.outlineCorner,
        cornerStyle(corner, { inset: edgeInset, borderWidth, markColor }),
        { width },
      ]}
    />
  ));
}

interface OwnedMarkProps {
  compact?: boolean;
  markColor: string;
  owner: PlayerColor | undefined;
}

function TerritoryMark({ compact, markColor, owner }: OwnedMarkProps) {
  return (
    <OutlineCorners
      compact={compact}
      corners={owner === 'Red' ? TOP_CORNERS : BOTTOM_CORNERS}
      inset={2}
      markColor={markColor}
      quiet
    />
  );
}

function GoalMark({ compact, markColor, owner }: OwnedMarkProps) {
  const edge: VerticalEdge = owner === 'Red' ? 'top' : 'bottom';
  const firstOffset = compact ? 1 : 3;
  const secondOffset = compact ? 3 : 6;
  const rail = (offset: number): ViewStyle =>
    edge === 'top'
      ? { top: offset, backgroundColor: markColor }
      : { bottom: offset, backgroundColor: markColor };

  return (
    <>
      <View style={[styles.goalRail, compact && styles.compactGoalRail, rail(firstOffset)]} />
      <View style={[styles.goalRail, compact && styles.compactGoalRail, rail(secondOffset)]} />
    </>
  );
}

function MoveMark({ markColor, variant }: { markColor: string; variant: TileMarkVariant }) {
  return (
    <View
      style={[
        styles.moveOutline,
        variant === 'moveFrom' ? styles.moveFromOutline : styles.moveToOutline,
        { borderColor: markColor },
      ]}
    />
  );
}

export interface TileMarkProps {
  compact?: boolean;
  owner?: PlayerColor;
  style?: StyleProp<ViewStyle>;
  variant: TileMarkVariant;
}

export default memo(function TileMark({ compact = false, owner, style, variant }: TileMarkProps) {
  const playerMark = owner === 'Red' || owner === 'Blue' ? players[owner].territoryMark : undefined;
  const markColor =
    variant === 'territory' || variant === 'goal'
      ? playerMark
      : variant === 'selection'
        ? board.selectionMark
        : variant === 'annotation'
          ? board.annotationMark
          : board.lastMoveMark;

  if (!markColor) return null;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.mark, style]}
    >
      {variant === 'territory' && (
        <TerritoryMark compact={compact} markColor={markColor} owner={owner} />
      )}
      {variant === 'goal' && <GoalMark compact={compact} markColor={markColor} owner={owner} />}
      {(variant === 'moveFrom' || variant === 'moveTo') && (
        <MoveMark markColor={markColor} variant={variant} />
      )}
      {variant === 'selection' && <OutlineCorners markColor={markColor} />}
      {variant === 'annotation' && <OutlineCorners inset={5} markColor={markColor} quiet />}
    </View>
  );
});

const styles = StyleSheet.create({
  mark: {
    ...StyleSheet.absoluteFill,
    overflow: 'hidden',
  },
  outlineCorner: {
    position: 'absolute',
    aspectRatio: 1,
    borderRadius: 1,
  },
  goalRail: {
    position: 'absolute',
    left: '19%',
    right: '19%',
    height: 1.5,
    borderRadius: 1,
  },
  compactGoalRail: { height: 1 },
  moveOutline: {
    position: 'absolute',
    borderRadius: 2,
  },
  moveFromOutline: {
    top: 5,
    right: 5,
    bottom: 5,
    left: 5,
    borderWidth: 1,
  },
  moveToOutline: {
    top: 3,
    right: 3,
    bottom: 3,
    left: 3,
    borderWidth: 1,
  },
});
