import { useCallback, useMemo, useState } from 'react';

import { canStartSeries, sameBotOwner } from './pitSelection';
import { failureMessage } from '@/errors';
import { useAdminToken, type AdminToken } from '@/hooks/useAdminToken';
import { useRequestIdentity } from '@/hooks/useRequestIdentity';
import {
  abortAdminBotSeries,
  abortBotSeries,
  startAdminBotSeries,
  startBotSeries,
  type BotSeries,
} from '@/store/api/bots';
import type { ModeDefinition, TimeControl } from '@/types/game';
import type { BotPresence } from '@/types/protocol';

// The run being set up, in one place.
//
// This state used to live inside the panel that drew it, which was right while
// the panel also carried the button. It does not any more: the two engines are
// picked on the cards at the top of the page and the run is started from a bar
// pinned to the foot of it, so the numbers, the credential and the request are
// wanted in two components at once.
//
// A hook rather than a store, deliberately. Nothing here should survive
// navigating away from a page whose whole subject is what is true now — see the
// `Slot`-rather-than-Tabs note in ShellLayout. And a hook rather than fifteen
// props, following useOpeningCurator: one named interface threaded down as a
// single `form`.
//
// The one thing that must not be duplicated is `useAdminToken`. It holds its
// own state and fires its own verification request, so a second call would mean
// two round-trips and two independent `unlocked` flags — pressing CLOSE in the
// panel would lower the panel's host limits and leave the bar's raised.

/** What the public form may ask for. The server enforces the same numbers. */
const PUBLIC_MAX_PAIRS = 3;
const PUBLIC_MAX_MINUTES = 10;
/**
 * An opening is a handful of moves off the book, not a position somebody else
 * played into. The server allows up to botSeriesMaxOpeningPlies, which is what
 * the host form still offers.
 */
const PUBLIC_MAX_PLIES = 6;
/** What the host may ask for, matching the server's own ceilings. */
const HOST_MAX_PAIRS = 100;
const HOST_MAX_PLIES = 20;

/**
 * The shortest clock the form will send: 0.1+1, six seconds each with a second
 * back every move.
 *
 * A bullet clock is not the degenerate setting between two engines that it is
 * between two people. Neither of them is going to fumble a mouse, the increment
 * is what carries a game this short, and six of them are over in less time than
 * one game at the default clock takes — which is the difference between
 * watching a run settle a question and starting one and coming back later.
 *
 * Exported because the field's hint names it.
 */
export const MIN_MINUTES = 0.1;

const numeric = (value: string, fallback: number) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Minutes alone may be fractional — see MIN_MINUTES — so they are not rounded. */
const decimal = (value: string, fallback: number) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high);

/** The run being set up, and what may be done to it. */
export interface BotSeriesForm {
  /** The credential, whichever door it came through. The only copy. */
  admin: AdminToken;
  /** True while the host's ceilings apply rather than the public ones. */
  asHost: boolean;
  maxPairs: number;
  maxPlies: number;
  maxMinutes: number;
  pairs: string;
  setPairs: (value: string) => void;
  plies: string;
  setPlies: (value: string) => void;
  seed: string;
  setSeed: (value: string) => void;
  minutes: string;
  setMinutes: (value: string) => void;
  /** The clock as the request will carry it, not as it is half-typed. */
  clock: TimeControl;
  /** Both engines belong to one person, so the ladder will not rate the run. */
  sameOwner: boolean;
  canStart: boolean;
  busy: boolean;
  error: string | null;
  dismissError: () => void;
  start: () => Promise<void>;
  stop: (run: BotSeries) => Promise<void>;
  /** Bumped by a start or a stop. The history feed's refreshKey. */
  changed: number;
  /** A run this browser asked for, which is the one it may stop. */
  mine: (run: BotSeries) => boolean;
}

export const useBotSeriesForm = ({
  first,
  mode,
  second,
}: {
  /** The engine on the first side, which opens game one of every pair. */
  first: BotPresence | null;
  second: BotPresence | null;
  /**
   * Null while the page has resolved no mode. A hook cannot be conditional on
   * that, so `start` refuses and `canStart` stays false instead.
   */
  mode: ModeDefinition | null;
}): BotSeriesForm => {
  const identity = useRequestIdentity();
  const admin = useAdminToken();

  const [pairs, setPairs] = useState('2');
  const [plies, setPlies] = useState('3');
  const [seed, setSeed] = useState('');
  const [minutes, setMinutes] = useState('1');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after starting or stopping a run, which is how the feed is told to
  // refetch now rather than on its own timer.
  const [changed, setChanged] = useState(0);

  const asHost = admin.unlocked;
  const maxPairs = asHost ? HOST_MAX_PAIRS : PUBLIC_MAX_PAIRS;
  const maxPlies = asHost ? HOST_MAX_PLIES : PUBLIC_MAX_PLIES;
  const maxMinutes = asHost ? 60 : PUBLIC_MAX_MINUTES;

  const refresh = useCallback(() => setChanged((count) => count + 1), []);
  const dismissError = useCallback(() => setError(null), []);

  // The clock as the request will carry it, so the bar underneath reports the
  // number that will be sent rather than whatever is half-typed in the field.
  // The increment is fixed at a second: it is what makes the shortest clock on
  // offer playable at all, and nobody came here to choose it.
  const clock = useMemo<TimeControl>(
    () => ({
      initialTimeMs: Math.round(
        clamp(decimal(minutes, 1), MIN_MINUTES, maxMinutes) * 60_000,
      ),
      incrementMs: 1000,
    }),
    [minutes, maxMinutes],
  );

  const start = async () => {
    if (!first || !second || !mode) return;
    setBusy(true);
    setError(null);
    try {
      const options = {
        firstBotId: first.botId,
        secondBotId: second.botId,
        modeId: mode.id,
        pairs: clamp(numeric(pairs, 2), 1, maxPairs),
        openingPlies: clamp(numeric(plies, 3), 0, maxPlies),
        // Passed through as text rather than parsed: the value a person pastes
        // here is one they copied off a finished run, and `Number.parseInt`
        // would round it before it ever left the browser.
        seed: seed.trim().replace(/\D/g, ''),
        timeControl: clock,
      };
      if (asHost) await startAdminBotSeries(admin.token, options);
      else await startBotSeries(identity, options);
      refresh();
    } catch (caught) {
      setError(failureMessage(caught, 'The series could not be started.'));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (run: BotSeries) => {
    setError(null);
    try {
      if (asHost) await abortAdminBotSeries(admin.token, run.seriesId);
      else await abortBotSeries(identity, run.seriesId);
      refresh();
    } catch (caught) {
      setError(failureMessage(caught, 'The series could not be stopped.'));
    }
  };

  return {
    admin,
    asHost,
    maxPairs,
    maxPlies,
    maxMinutes,
    pairs,
    setPairs,
    plies,
    setPlies,
    seed,
    setSeed,
    minutes,
    setMinutes,
    clock,
    sameOwner: sameBotOwner(first, second),
    canStart: canStartSeries({ busy, first, mode, second }),
    busy,
    error,
    dismissError,
    start,
    stop,
    changed,
    mine: (run: BotSeries) =>
      Boolean(run.requestedByUserId) && run.requestedByUserId === identity.userId,
  };
};
