// The greedy racer, wearing the `Bot` interface.
//
// `engine/racer.ts` is the player; this is the twelve lines of plumbing that let
// it sit where a searching bot sits, so the arena can measure it against the
// ladder without knowing that one side never calls RPSFish. It is deliberately
// not in `BOT_PROFILES`: the ladder is the shipped lobby, and a bot that only
// understands one mode does not belong in a list the lobby renders for both.

import { createAnalysisGameFrom, type AnalysisGame } from '../analysisGame';
import { raceAnalysis, rankRaceMoves, RACER_DEFAULTS, type RacerOptions } from '../racer';
import { supportsReachRace } from '../reach';
import type { Bot, BotDecision } from './engine';
import type { BotProfile } from './profiles';

/**
 * A profile for something that has no search to describe.
 *
 * Every knob is at the setting that means "do not interfere": depth 1 because
 * that is the literal truth, no random moves, no temperature, no resignation.
 * The rating is a placeholder until a measurement replaces it.
 */
export const RACER_PROFILE: BotProfile = Object.freeze({
  id: 'racer',
  name: 'Racer',
  rating: 0,
  blurb: 'Runs for the far rank and stands in front of anything that runs at yours.',
  search: Object.freeze({ maxDepth: 1, maxTimeMs: 0 }),
  choice: Object.freeze({
    candidateLines: 1,
    randomMoveChance: 0,
    temperatureUnits: 0,
    maxLossUnits: 0,
  }),
  tempo: Object.freeze({ minThinkMs: 0, maxThinkMs: 0 }),
  manners: Object.freeze({
    resignBelowArmies: null,
    resignAfterMove: 0,
    acceptDrawWithinArmies: 0,
    acceptDrawAfterMove: Number.MAX_SAFE_INTEGER,
  }),
});

export interface CreateRacerOptions {
  now?: () => number;
  racer?: RacerOptions;
}

const unsupported = (modeId: string | undefined) =>
  new Error(
    `The racer only plays Infiltration; ${modeId ?? 'this mode'} has no goal row to race to.`,
  );

export const createRacerBot = ({
  now = () => Date.now(),
  racer = RACER_DEFAULTS,
}: CreateRacerOptions = {}): Bot => {
  const chooseMove = async (game: AnalysisGame): Promise<BotDecision | null> => {
    if (!supportsReachRace(game.mode?.id)) throw unsupported(game.mode?.id);
    if (game.status !== 'InProgress') return null;
    const startedAt = now();
    const ranked = rankRaceMoves(game, racer);
    const best = ranked[0];
    if (!best) return null;
    return {
      // The chart wants an analysis and the racer has one to give, but building
      // it means ranking the position a second time. It ranks once and dresses
      // the result instead.
      analysis: {
        confidence: 1,
        depth: 1,
        elapsedMs: now() - startedAt,
        lines: ranked.slice(0, 8).map((move) => ({
          from: move.from,
          to: move.to,
          score: move.score,
          rank: move.rank,
          principalVariation: [{ from: move.from, to: move.to }],
        })),
        nodes: ranked.length,
        nodesPerSecond: 0,
        redScore: game.currentTurn === 'Blue' ? -best.score : best.score,
        score: best.score,
        selectiveDepth: racer.answerCaptures ? 2 : 1,
        stopReason: 'depth',
      },
      from: best.from,
      to: best.to,
      rank: 1,
      reason: 'best',
      score: best.score,
      elapsedMs: now() - startedAt,
      // A racer never resigns: its own reading is exactly the thing that would
      // be judging the position, and it is a bound rather than a verdict.
      resigns: false,
    };
  };

  return {
    acceptsDraw: () => false,
    blurb: RACER_PROFILE.blurb,
    chooseMove,
    id: RACER_PROFILE.id,
    name: RACER_PROFILE.name,
    profile: RACER_PROFILE,
    rating: RACER_PROFILE.rating,
    search: async (position) => {
      if (!supportsReachRace(position.mode?.id)) throw unsupported(position.mode?.id);
      return raceAnalysis(
        createAnalysisGameFrom(position.mode, position.grid, position.currentTurn),
        racer,
        8,
      );
    },
  };
};
