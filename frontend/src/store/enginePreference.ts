import { create } from 'zustand';

import { deviceStorage } from './deviceStorage';

// Whether a screen that studies a game asks RPSFish about it.
//
// Off by default, and that is a statement about the engine rather than about
// the feature. RPSFish is weaker than most of the bots people actually play on
// this site, so its verdict on one of their games is frequently wrong — and a
// wrong grade is worse than no grade, because it is printed in the same
// confident badge a right one would be. Until the engine is strong enough to
// be believed, a review opens as what a review was before engines: the game,
// replayed, with the reader doing the judging.
//
// Turning it on is a per-device choice that sticks, so somebody who wants the
// grades asks once rather than once per game. Shipping it off is what makes it
// a choice at all.
//
// Deliberately *not* part of the account's synced appearance: this is about
// how much you trust a build of the engine, which is a property of the engine
// in front of you.

const ENGINE_ANALYSIS_KEY = 'rps.engineAnalysis.v1';

/** What this device last chose, or off. */
const readStoredEngineAnalysis = (): boolean => {
  try {
    return deviceStorage()?.getItem(ENGINE_ANALYSIS_KEY) === 'on';
  } catch {
    // A device store that will not open, or private browsing. Neither is worth
    // a broken launch, and off is the safe answer in both.
    return false;
  }
};

const writeStoredEngineAnalysis = (enabled: boolean) => {
  try {
    deviceStorage()?.setItem(ENGINE_ANALYSIS_KEY, enabled ? 'on' : 'off');
  } catch {
    // The choice lasts as long as this session does.
  }
};

interface EngineAnalysisState {
  enabled: boolean;
}

// Read once, at module load, the way the appearance is: `deviceStorage`
// answers synchronously precisely so a preference can be known before the
// first frame rather than flipping under the reader a moment after it draws.
export const useEngineAnalysisStore = create<EngineAnalysisState>()(() => ({
  enabled: readStoredEngineAnalysis(),
}));

/** Whether this device wants RPSFish's opinion on a game it is looking at. */
export const useEngineAnalysis = () => useEngineAnalysisStore((state) => state.enabled);

/** Turn the engine on or off, and remember it. */
export const setEngineAnalysis = (enabled: boolean) => {
  writeStoredEngineAnalysis(enabled);
  useEngineAnalysisStore.setState({ enabled });
};

export const toggleEngineAnalysis = () => {
  setEngineAnalysis(!useEngineAnalysisStore.getState().enabled);
};
