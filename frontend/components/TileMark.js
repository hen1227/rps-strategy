import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { board, players } from '../theme';

const ALL_CORNERS = [
  ['top', 'left'],
  ['top', 'right'],
  ['bottom', 'left'],
  ['bottom', 'right'],
];
const TOP_CORNERS = ALL_CORNERS.slice(0, 2);
const BOTTOM_CORNERS = ALL_CORNERS.slice(2);

function OutlineCorners({ compact = false, corners = ALL_CORNERS, inset = 3, markColor, quiet }) {
  const edgeInset = compact ? 1 : inset;
  const borderWidth = compact || quiet ? 1 : 1.5;
  const width = compact ? '30%' : quiet ? '15%' : '19%';

  return corners.map(([vertical, horizontal]) => {
    const verticalBorder = `border${vertical[0].toUpperCase()}${vertical.slice(1)}`;
    const horizontalBorder = `border${horizontal[0].toUpperCase()}${horizontal.slice(1)}`;
    return (
      <View
        key={`${vertical}-${horizontal}`}
        style={[
          styles.outlineCorner,
          {
            [vertical]: edgeInset,
            [horizontal]: edgeInset,
            [`${verticalBorder}Color`]: markColor,
            [`${verticalBorder}Width`]: borderWidth,
            [`${horizontalBorder}Color`]: markColor,
            [`${horizontalBorder}Width`]: borderWidth,
            width,
          },
        ]}
      />
    );
  });
}

function TerritoryMark({ compact, markColor, owner }) {
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

function GoalMark({ compact, markColor, owner }) {
  const edge = owner === 'Red' ? 'top' : 'bottom';
  const firstOffset = compact ? 1 : 3;
  const secondOffset = compact ? 3 : 6;

  return (
    <>
      <View
        style={[
          styles.goalRail,
          compact && styles.compactGoalRail,
          { [edge]: firstOffset, backgroundColor: markColor },
        ]}
      />
      <View
        style={[
          styles.goalRail,
          compact && styles.compactGoalRail,
          { [edge]: secondOffset, backgroundColor: markColor },
        ]}
      />
    </>
  );
}

function MoveMark({ markColor, variant }) {
  return (
    <>
      <View
        style={[
          styles.moveOutline,
          variant === 'moveFrom' ? styles.moveFromOutline : styles.moveToOutline,
          { borderColor: markColor },
        ]}
      />
      {/*{variant === 'moveTo' && (*/}
      {/*  <View style={[styles.moveToInnerOutline, { borderColor: markColor }]} />*/}
      {/*)}*/}
    </>
  );
}

function SelectionMark({ markColor }) {
  return <OutlineCorners markColor={markColor} />;
}

function AnnotationMark({ markColor }) {
  return <OutlineCorners inset={5} markColor={markColor} quiet />;
}

export default memo(function TileMark({ compact = false, owner, style, variant }) {
  const playerMark = players[owner]?.territoryMark;
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
      {variant === 'goal' && (
        <GoalMark compact={compact} markColor={markColor} owner={owner} />
      )}
      {(variant === 'moveFrom' || variant === 'moveTo') && (
        <MoveMark markColor={markColor} variant={variant} />
      )}
      {variant === 'selection' && <SelectionMark markColor={markColor} />}
      {variant === 'annotation' && <AnnotationMark markColor={markColor} />}
    </View>
  );
});

const styles = StyleSheet.create({
  mark: {
    ...StyleSheet.absoluteFillObject,
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
  moveToInnerOutline: {
    position: 'absolute',
    top: 6,
    right: 6,
    bottom: 6,
    left: 6,
    borderWidth: 1,
    borderRadius: 2,
  },
});
