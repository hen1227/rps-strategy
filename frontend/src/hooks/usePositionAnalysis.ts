import { useEffect, useMemo, useRef, useState } from 'react';

import { positionSignature } from '@/engine/gameAnalysis';
import { enginePosition, type PositionLike } from '@/engine/analysisGame';
import { analyzePosition, type RequestOptions } from '@/engine/rpsfish/client';
import type { Analysis, SearchLimits } from '@/engine/rpsfish/protocol';

// What the engine thinks of the position on screen *right now*.
//
// Distinct from `useGameAnalysis`, and the distinction is the whole point. This
// is the interactive search: it drives the arrows, the eval bar and the ranked
// lines, it is redone from scratch whenever the position changes, and it grades
// nothing. Grades come from the review walk, which measures a played move
// against the best move of the *same* search — see `engine/gameAnalysis.ts`.
//
// The analysis board, the review's off-record branches, and the hint button all
// want exactly this, and each used to carry its own copy: the same abort
// controller, the same sequence guard, the same rule about keeping the deeper
// of two results. One copy had the sequence guard and no abort, another had the
// abort and no guard.

export type SearchStatus = 'idle' | 'thinking' | 'ready' | 'error';

export interface PositionAnalysisOptions {
  /** The position to search, or `null` for nothing to search. */
  position: PositionLike | null | undefined;
  /** The line that led here, so repetition is scored correctly. */
  history?: PositionLike[];
  limits: Partial<SearchLimits>;
  enabled?: boolean;
}

export interface PositionAnalysisResult {
  analysis: Analysis | null;
  status: SearchStatus;
  error: string | null;
}

/**
 * Keep the deeper of two results.
 *
 * Iterations arrive in order, but a late update from a search that has already
 * returned its final answer would otherwise overwrite it with a shallower one.
 */
const deeper = (current: Analysis | null, next: Analysis) =>
  current && current.depth > next.depth ? current : next;

export const usePositionAnalysis = ({
  position,
  history = [],
  limits,
  enabled = true,
}: PositionAnalysisOptions): PositionAnalysisResult => {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Callers rebuild `history` every render, so the effect keys off what the
  // engine would actually be asked rather than off array identity. Position
  // signatures are cached per position object, so this is a few map lookups.
  const lineKey = useMemo(
    () =>
      position
        ? [...history, position].map(positionSignature).join('/')
        : null,
    [history, position],
  );
  const limitsKey = JSON.stringify(limits);

  // Read inside the effect so a new array or object identity cannot restart a
  // search that is already asking the right question.
  const latest = useRef({ position, history, limits });
  latest.current = { position, history, limits };

  useEffect(() => {
    if (!enabled || !lineKey) {
      setAnalysis(null);
      setStatus('idle');
      setError(null);
      return undefined;
    }

    const { position: target, history: line, limits: budget } = latest.current;
    if (!target) return undefined;

    const controller = new AbortController();
    setAnalysis(null);
    setStatus('thinking');
    setError(null);

    const options: RequestOptions = { ...budget, signal: controller.signal };
    analyzePosition(
      { ...enginePosition(target), history: line.map(enginePosition) },
      options,
      (update) => setAnalysis((current) => deeper(current, update)),
    )
      .then((result) => {
        setAnalysis((current) => deeper(current, result));
        setStatus('ready');
      })
      .catch((failure: unknown) => {
        const named = failure as { name?: string; message?: string } | null;
        // A search abandoned because the position changed is not a failure.
        if (named?.name === 'AbortError') return;
        setStatus('error');
        setError(named?.message ?? 'RPSFish could not analyse this position.');
      });

    return () => controller.abort();
  }, [enabled, limitsKey, lineKey]);

  return { analysis, status, error };
};
