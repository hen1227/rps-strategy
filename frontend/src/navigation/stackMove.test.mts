// What the moves in `stackMove.ts` do to the stack, run through the router's
// own reducer.
//
// The rule's answers are easy to read and easy to get wrong in a way no
// screenshot shows: every page here fills the screen, so a pile of screens
// under the one showing looks exactly like no pile. What gives it away is the
// route's *key*. A real pop lands on the same key it left; a pop that found
// nothing to land on builds the page again under a new one, which a phone
// animates as a push. So these tests replay each move the app makes — a row of
// the navigation, a link on a page, the `‹` back link — through expo-router's
// `StackRouter` and divergence logic, and compare keys.
//
// `expo-router` itself cannot be imported under Node, but its reducer is plain
// JavaScript, and it is the reducer that decides.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import { navRowMove, stackMove, type StackMove } from './stackMove.ts';
import { sectionsInGroup, type NavContext } from '@/features/shell/sections';

const requireCjs = createRequire(import.meta.url);
const { StackRouter } = requireCjs('expo-router/build/react-navigation/routers/StackRouter.js');
const { findDivergentState, getPayloadFromStateRoute } = requireCjs(
  'expo-router/build/global-state/stateUtils.js',
);

// The root stack's routes, read off `src/app` the way the router reads them: the
// shell's group, and each full-screen page beside it.
const APP = new URL('../app/', import.meta.url);
const ROOT_ROUTES = readdirSync(APP, { withFileTypes: true })
  .map((entry) =>
    entry.isDirectory() ? entry.name : entry.name.replace(/\.tsx$/, ''),
  )
  .filter((name) => !name.startsWith('_') && !name.startsWith('+'));
const SHELL = '(shell)';
const FULL_SCREEN = ROOT_ROUTES.filter((name) => name !== SHELL);

// A few of the shell's pages, by path and by the route name the group gives them.
const SHELL_PAGES: Record<string, string> = {
  '/': 'index',
  '/tournaments': 'tournaments',
  '/account': 'account/index',
  '/openings': 'openings',
  '/player': 'player',
};

interface Route {
  name: string;
  key: string;
  params?: Record<string, unknown>;
  state?: Stack;
}
interface Stack {
  type: 'stack';
  key: string;
  index: number;
  routes: Route[];
  routeNames: string[];
  preloadedRoutes: Route[];
  stale: false;
}

const rootRouter = StackRouter({});
const shellRouter = StackRouter({});
const options = (routeNames: string[]) => ({ routeNames, routeParamList: {}, routeGetIdList: {} });

let counter = 0;
const shellStack = (page: string): Stack => ({
  type: 'stack',
  key: `slot-${++counter}`,
  index: 0,
  routes: [{ name: page, key: `${page}-${++counter}` }],
  routeNames: Object.values(SHELL_PAGES),
  preloadedRoutes: [],
  stale: false,
});
const lobby = (): Stack => ({
  type: 'stack',
  key: 'root',
  index: 0,
  routes: [{ name: SHELL, key: `${SHELL}-${++counter}`, state: shellStack('index') }],
  routeNames: ROOT_ROUTES,
  preloadedRoutes: [],
  stale: false,
});

const isShellPath = (path: string) => path in SHELL_PAGES;
const focused = (root: Stack) => root.routes[root.index]!;
/** The path showing, as `usePathname` would give it. */
const pathOf = (root: Stack): string => {
  const route = focused(root);
  if (route.name !== SHELL) return `/${route.name}`;
  const page = route.state!.routes[route.state!.index]!.name;
  return Object.keys(SHELL_PAGES).find((path) => SHELL_PAGES[path] === page)!;
};

/** What `getStateFromPath` makes of a path: the state the router aims for. */
const actionState = (path: string) =>
  isShellPath(path)
    ? { routes: [{ name: SHELL, state: { routes: [{ name: SHELL_PAGES[path] }] } }] }
    : { routes: [{ name: path.slice(1) }] };

const EVENT: Record<StackMove, string> = {
  navigate: 'NAVIGATE',
  replace: 'REPLACE',
  dismissTo: 'POP_TO',
};

/**
 * Dispatch a move the way `getNavigateAction` does: aimed at the deepest
 * navigator where the current state and the destination part ways.
 */
const go = (root: Stack, path: string, move: StackMove): Stack => {
  const { actionStateRoute, navigationState } = findDivergentState(actionState(path), root);
  const payload = getPayloadFromStateRoute(actionStateRoute ?? {});
  const action = {
    type: EVENT[move],
    target: navigationState.key,
    payload: { name: payload.screen, params: payload.params },
  };

  if (navigationState.key !== root.key) {
    // Inside the shell: the group's own navigator takes it.
    const shell = focused(root);
    const next = shellRouter.getStateForAction(shell.state, action, options(shell.state!.routeNames));
    return {
      ...root,
      routes: root.routes.map((route) => (route === shell ? { ...route, state: next } : route)),
    };
  }

  const next: Stack = rootRouter.getStateForAction(root, action, options(ROOT_ROUTES));
  // A move onto the shell carries the page as `{screen}`; the group's navigator
  // turns that into a navigation of its own, or starts on it if it is new.
  const landed = focused(next);
  if (landed.name === SHELL) {
    const page = SHELL_PAGES[path]!;
    const state = landed.state
      ? shellRouter.getStateForAction(
          landed.state,
          { type: 'NAVIGATE', payload: { name: page } },
          options(landed.state.routeNames),
        )
      : shellStack(page);
    next.routes = next.routes.map((route) => (route === landed ? { ...route, state } : route));
  }
  return next;
};

/** A press of a row of the shell's navigation. */
const pressRow = (root: Stack, path: string, row: { external?: boolean }) =>
  go(root, path, navRowMove(row));
/** A link or a button on a page: `useGoTo` and `useStackProps`. */
const follow = (root: Stack, path: string) =>
  go(root, path, stackMove(pathOf(root), path as never, focused(root).name === SHELL));
/** `BackLink`, which is a `dismissTo` wherever it is drawn. */
const back = (root: Stack, path: string) => go(root, path, 'dismissTo');

const keys = (root: Stack) => root.routes.map((route) => route.key);
const GUEST: NavContext = { account: null, now: null };

test('the analysis board is the one row that leaves the shell', () => {
  const study = sectionsInGroup('study', GUEST);
  const analysis = study.find((section) => section.id === 'analysis');
  assert.equal(analysis?.external, true, 'listed, and marked as outside the shell');
  assert.equal(navRowMove(analysis!), 'navigate');
  for (const section of study.filter((row) => !row.external)) {
    assert.equal(navRowMove(section), 'replace', section.id);
  }
});

test('the analysis board opened from the sidebar is laid over the shell, and back pops to it', () => {
  const start = lobby();
  const shellKey = start.routes[0]!.key;

  const board = pressRow(start, '/analysis', { external: true });
  assert.deepEqual(
    board.routes.map((route) => route.name),
    [SHELL, 'analysis'],
    'the lobby stays underneath the board',
  );
  const home = back(board, '/');
  assert.deepEqual(keys(home), [shellKey], 'the same lobby, popped back to, and nothing else');
  assert.equal(pathOf(home), '/');
});

// The harness has to be able to tell the two apart, or the test above proves
// nothing: this is the move the sidebar used to make.
test('a replace onto the board throws the shell away, and back builds a new one', () => {
  const start = lobby();
  const shellKey = start.routes[0]!.key;
  const board = go(start, '/analysis', 'replace');
  assert.deepEqual(board.routes.map((route) => route.name), ['analysis']);
  const home = back(board, '/');
  assert.equal(home.routes.length, 1);
  assert.notEqual(home.routes[0]!.key, shellKey, 'a fresh lobby, slid in on top');
});

test('moving between sections keeps one shell, one page deep', () => {
  let state = lobby();
  const shellKey = state.routes[0]!.key;
  for (const path of ['/tournaments', '/account', '/openings', '/', '/tournaments']) {
    state = pressRow(state, path, {});
    assert.equal(pathOf(state), path);
  }
  assert.deepEqual(keys(state), [shellKey]);
  assert.equal(focused(state).state!.routes.length, 1, 'each row replaced the last');
});

test('a game started from the analysis board goes over it, and its back returns to it', () => {
  const board = pressRow(lobby(), '/analysis', { external: true });
  const boardKey = board.routes[1]!.key;
  const game = follow(board, '/play');
  assert.deepEqual(game.routes.map((route) => route.name), [SHELL, 'analysis', 'play']);
  const again = back(game, '/analysis');
  assert.deepEqual(keys(again), [board.routes[0]!.key, boardKey]);
});

test('a link from a full-screen page into the shell pops back to the shell underneath', () => {
  const watching = follow(lobby(), '/watch');
  const shellKey = watching.routes[0]!.key;
  const profile = follow(watching, '/player');
  assert.deepEqual(keys(profile), [shellKey]);
  assert.equal(pathOf(profile), '/player');
});

// The whole rule at once: whatever somebody presses, in whatever order, the
// lobby they started on stays at the bottom of the stack — never thrown away,
// never built again — and nothing piles up on it beyond the one game that can
// sit over an analysis board.
test('no sequence of moves builds a pile', () => {
  let seed = 7;
  const random = (count: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % count;
  };
  const pick = <T,>(items: T[]) => items[random(items.length)]!;
  const fullScreenPaths = FULL_SCREEN.map((name) => `/${name}`);
  const shellPaths = Object.keys(SHELL_PAGES);

  let state = lobby();
  const shellKey = state.routes[0]!.key;
  for (let step = 0; step < 500; step += 1) {
    const here = pathOf(state);
    const inShell = focused(state).name === SHELL;
    let destination: string;
    if (inShell) {
      const choice = random(3);
      destination = pick(choice === 0 ? shellPaths : fullScreenPaths);
      state =
        choice === 2
          ? pressRow(state, '/analysis', { external: true })
          : choice === 0
            ? pressRow(state, destination, {})
            : follow(state, destination);
      if (choice === 2) destination = '/analysis';
    } else {
      destination = pick([...shellPaths, ...fullScreenPaths]);
      state = random(2) === 0 && isShellPath(destination) ? back(state, destination) : follow(state, destination);
    }

    const context = `step ${step}: ${here} → ${destination}`;
    const pile = state.routes.map((route) => route.name).join(' > ');
    assert.equal(pathOf(state), destination, context);
    assert.equal(state.routes[0]!.key, shellKey, `${context}: the lobby was rebuilt (${pile})`);
    assert.equal(
      state.routes.filter((route) => route.name === SHELL).length,
      1,
      `${context}: ${pile}`,
    );
    assert.ok(state.routes.length <= 3, `${context}: ${pile}`);
  }
});
