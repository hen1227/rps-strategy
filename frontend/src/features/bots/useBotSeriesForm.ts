import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { canStartSeries, sameBotOwner } from './pitSelection';
import { rankedBlocker, rankedLine, rankedPress, type RankedPress } from './rankedMatch';
import { track } from '@/analytics/track';
import { failureMessage } from '@/errors';
import { useAdminToken, type AdminToken } from '@/hooks/useAdminToken';
import { useRequestIdentity } from '@/hooks/useRequestIdentity';
import { links } from '@/navigation/links';
import {
  abortAdminBotSeries,
  abortBotSeries,
  setAdminBotSeriesRanked,
  startAdminBotSeries,
  startBotSeries,
  startRankedMatch,
  type BotSeries,
} from '@/store/api/bots';
import { useGameStore } from '@/store/gameStore';
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
  /** How many games the request will ask for: two a pair. */
  games: number;
  /** Both engines belong to one person, so the ladder will not rate the run. */
  sameOwner: boolean;
  /**
   * RANKED or CASUAL, as chosen — the one decision on the form, offered to
   * everybody. Casual until somebody picks ranked: the choice is theirs to
   * make, not the form's.
   */
  ranked: boolean;
  setRanked: (ranked: boolean) => void;
  /** What RANKED does with the pit as it stands. See rankedMatch.ts. */
  press: RankedPress;
  /**
   * RANKED is chosen and the match is the server's format — one pair at a
   * drawn clock — so the four options do not apply. False for a host's run,
   * which is played at the host's settings.
   */
  serverFormat: boolean;
  /** Why RANKED cannot be pressed with the pit as it stands, for the hint. */
  rankedBlocker: string | null;
  /** The ranked press in one line, or empty when there is none to describe. */
  rankedLine: string;
  canStart: boolean;
  busy: boolean;
  error: string | null;
  dismissError: () => void;
  /** What a press did that is worth saying, like a challenge being sent. */
  notice: string | null;
  dismissNotice: () => void;
  start: () => Promise<void>;
  stop: (run: BotSeries) => Promise<void>;
  /**
   * Move a finished run, and every game it filed, to the other side of ranked
   * and casual. A host's action; the server recomputes the ratings as it does it.
   */
  reclassify: (run: BotSeries) => Promise<void>;
  /** The run being moved right now, so its button can wait for the answer. */
  moving: string | null;
  /** Bumped by a start or a stop. The history feed's refreshKey. */
  changed: number;
  /** A run this browser asked for, which is the one it may stop. */
  mine: (run: BotSeries) => boolean;
}

export const useBotSeriesForm = ({
  available = 2,
  first,
  mode,
  second,
}: {
  /**
   * How many engines could be entered right now, the one in the pit included.
   * A random ranked pair needs somebody else free to draw, so under two it is
   * refused here rather than by the server a press later.
   */
  available?: number;
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
  const [ranked, setRanked] = useState(false);

  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped after starting or stopping a run, which is how the feed is told to
  // refetch now rather than on its own timer.
  const [changed, setChanged] = useState(0);

  const asHost = admin.unlocked;
  const sameOwner = sameBotOwner(first, second);
  const maxPairs = asHost ? HOST_MAX_PAIRS : PUBLIC_MAX_PAIRS;
  const maxPlies = asHost ? HOST_MAX_PLIES : PUBLIC_MAX_PLIES;
  const maxMinutes = asHost ? 60 : PUBLIC_MAX_MINUTES;

  // Who is looking is the store's to say, and the page already hands this
  // hook the two engines, so the press is read here rather than threaded
  // through as more props.
  const router = useRouter();
  const sessionToken = useGameStore((state) => state.sessionToken);
  const terms = useGameStore((state) => state.rankedTerms);
  const modes = useGameStore((state) => state.modes);
  const press = rankedPress({ asHost, first, second, signedIn: Boolean(sessionToken) });
  const blocker = ranked
    ? rankedBlocker({ available, modeId: mode?.id ?? 'V6', modes, press, terms })
    : null;
  const serverFormat = ranked && press.kind !== 'host';
  const games = clamp(numeric(pairs, 2), 1, maxPairs) * 2;

  // A sentence about the last press is about those two engines, and stops
  // being true the moment the pit holds different ones.
  useEffect(() => {
    setNotice(null);
  }, [first?.botId, second?.botId]);

  const refresh = useCallback(() => setChanged((count) => count + 1), []);
  const dismissError = useCallback(() => setError(null), []);
  const dismissNotice = useCallback(() => setNotice(null), []);

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

  // A ranked match in the server's format. Neither kind is a series this form
  // configures: the server draws the clock, and with the other side empty the
  // opponent too. The four numbers above do not apply.
  const startRanked = async () => {
    if (!sessionToken || blocker || (press.kind !== 'random' && press.kind !== 'chosen')) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const series =
        press.kind === 'random'
          ? await startRankedMatch(sessionToken, press.engine.botId)
          : await startRankedMatch(sessionToken, press.first.botId, press.second.botId);
      track('bot_match_start', { mode: series.modeId, where: 'server', ranked: 'ranked' });
      refresh();
      // Press, then go and watch it — the rounds page's PLAY NOW does the
      // same, and the run's own page is where its two games are drawn.
      router.push(links.series(series.seriesId));
    } catch (caught) {
      setError(failureMessage(caught, 'The ranked match could not be started.'));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (serverFormat) return startRanked();
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
        // Only a host's run gets here ranked; everybody else's ranked press
        // is the server's format, above.
        ranked: ranked && press.kind === 'host',
      };
      if (asHost) await startAdminBotSeries(admin.token, options);
      else await startBotSeries(identity, options);
      track('bot_match_start', {
        mode: mode.id,
        where: 'server',
        ranked: options.ranked ? 'ranked' : 'casual',
      });
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

  const reclassify = async (run: BotSeries) => {
    if (!asHost) return;
    setError(null);
    setMoving(run.seriesId);
    try {
      // `casual` is what the card shows, so the button moves the run to the
      // other side of what the host is looking at.
      await setAdminBotSeriesRanked(admin.token, run.seriesId, run.casual);
      refresh();
    } catch (caught) {
      setError(failureMessage(caught, 'The series could not be changed.'));
    } finally {
      setMoving(null);
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
    games,
    sameOwner,
    ranked,
    setRanked,
    press,
    serverFormat,
    rankedBlocker: blocker,
    rankedLine: rankedLine(press, terms),
    // A ranked press needs one engine of yours rather than two engines, so it
    // answers a different question from the series' own.
    canStart: serverFormat
      ? !busy && !blocker && Boolean(mode) && Boolean(sessionToken)
      : ranked
        ? press.kind === 'host' && canStartSeries({ busy, first, mode, second })
        : canStartSeries({ busy, first, mode, second }),
    busy,
    error,
    dismissError,
    notice,
    dismissNotice,
    start,
    stop,
    reclassify,
    moving,
    changed,
    mine: (run: BotSeries) =>
      Boolean(run.requestedByUserId) && run.requestedByUserId === identity.userId,
  };
};
