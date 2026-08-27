import { useCallback, useMemo } from 'react';

import { positionSignature } from '@/engine/gameAnalysis';
import { supportsReachRace } from '@/engine/reach';
import type { PositionLike } from '@/engine/analysisGame';
import { REACH_TOOL_ENABLED } from '@/featureFlags';
import { buildReachOverlay, type ReachOverlayResult } from '@/features/reach/reachOverlay';
import type { GhostPiece, ReachSettings } from '@/features/reach/settings';
import { useGameStore } from '@/store/gameStore';
import type { Position, SideColor } from '@/types/game';

// The reach tool, bound to a screen.
//
// Every host goes through this: the settings come from the one store slice, the
// overlay comes from the one pure builder, and a screen's whole job is to hand
// over a position, render the panel, and pass `overlay` to its board. Nothing
// screen-local computes a distance — the same rule `useGameAnalysis` and
// `usePositionAnalysis` follow, and for the same reason. Two screens showing
// different numbers for one position would be worse than showing none.
//
// No worker and no debounce: the whole analysis is a handful of breadth-first
// walks over eighty-one squares, so it costs less than the render it feeds.

export interface ReachToolResult extends ReachOverlayResult {
  settings: ReachSettings;
  /**
   * Whether the tool exists here at all.
   *
   * False in an exported build, and false in a mode with no goal row to race
   * to. A host renders its toggle only when this is true, so both answers are
   * given in one place rather than screen by screen.
   */
  available: boolean;
  /** On, and in a mode that supports it. */
  active: boolean;
  setSettings: (patch: Partial<ReachSettings>) => void;
  toggle: () => void;
  setGhost: (ghost: GhostPiece | null) => void;
  /**
   * Offer the tool a tapped square.
   *
   * Returns `true` when the tool consumed the tap — only ever while placing a
   * ghost. Every other tap is passed back, so selecting and moving a piece
   * behaves exactly as it does with the tool switched off.
   */
  handleTilePress: (position: Position) => boolean;
}

export interface ReachToolOptions {
  /**
   * The side the person at the keyboard plays.
   *
   * Applied when the tool is switched on, so a Blue player opens it on their
   * own army rather than on the bot's. A board where one person plays both
   * sides has no answer to this and leaves it out.
   */
  viewerSide?: SideColor | null;
}

export const useReach = (
  position: PositionLike | null | undefined,
  { viewerSide = null }: ReachToolOptions = {},
): ReachToolResult => {
  const settings = useGameStore((state) => state.reach);
  const setSettings = useGameStore((state) => state.setReachSettings);
  const storeToggle = useGameStore((state) => state.toggleReach);
  const setFocus = useGameStore((state) => state.setReachFocus);
  const setGhost = useGameStore((state) => state.setReachGhost);

  const available = REACH_TOOL_ENABLED && supportsReachRace(position?.mode?.id);
  const active = available && settings.enabled;

  // The signature stands in for the position in the dependency list: it changes
  // exactly when the board does, it is cheaper to compare than a grid, and
  // `positionSignature` already caches one per position object.
  const signature = active && position ? positionSignature(position) : null;
  const result = useMemo(
    () => buildReachOverlay(active ? position : null, settings),
    [active, signature, settings],
  );

  const toggle = useCallback(() => {
    // Switching it on is the moment to point it at the right army; changing it
    // afterwards is the viewer's business and is left alone.
    if (!settings.enabled && viewerSide && viewerSide !== settings.side) {
      setSettings({ side: viewerSide, focus: null, ghost: null });
    }
    storeToggle();
  }, [settings.enabled, settings.side, viewerSide, setSettings, storeToggle]);

  const handleTilePress = useCallback(
    (square: Position) => {
      // Passed straight back when the tool is off, so a host can route every
      // tap through it without asking whether it is switched on.
      if (!active) return false;
      if (settings.placingGhost) {
        setGhost({ at: square, piece: settings.ghost?.piece ?? 'Rock', owner: settings.side });
        return true;
      }
      setFocus(square);
      return false;
    },
    [active, settings.placingGhost, settings.ghost?.piece, settings.side, setFocus, setGhost],
  );

  return {
    ...result,
    settings,
    available,
    active,
    setSettings,
    toggle,
    setGhost,
    handleTilePress,
  };
};
