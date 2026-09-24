import { DEFAULT_THEME_ID, THEMES } from '@/theme';

// What runs before the page paints, in a browser.
//
// `app.json` sets `web.output: "static"`, so every page is a real HTML file
// rendered in Node at build time — in the default theme, because Node cannot
// know what this visitor chose. React then hydrates that HTML, and a first
// client render in a *different* theme differs on essentially every element:
// react-native-web turns each colour into an atomic class name, so React 19
// would throw the pre-rendered page away and render the whole thing again.
//
// So the app cannot open in the chosen theme. What it can do is not show the
// wrong one. This script runs in `<head>`, before anything is painted, and for
// a visitor who has chosen something other than the default it paints the page
// their background colour and holds the app itself hidden until
// `bootstrap.web.ts` has applied the theme — which is the first thing that
// happens after hydration.
//
// A visitor on the default theme pays nothing at all: the branch below returns
// before touching the document, and the pre-rendered HTML is already right.
//
// The delay is not a frame. The HTML paints as soon as it arrives and hydration
// waits for the bundle to load and run, which on a phone on a cold load is
// hundreds of milliseconds — long enough that a dark page under a light theme
// is not a flash but a different site.

const HIDE_ID = 'rps-prepaint';
const APPEARANCE_KEY = 'rps.appearance.v1';

/**
 * How long the app may stay hidden before it is shown regardless.
 *
 * A bundle that never loads must not leave a blank page: whatever is wrong at
 * that point, the wrong colours are better than nothing at all.
 */
const REVEAL_ANYWAY_MS = 4000;

/** Undo the hold. Removing the rule, not clearing an inline style — see below. */
export const revealPrepainted = () => {
  if (typeof document === 'undefined') return;
  // The hold is a stylesheet rule rather than an inline style, so clearing
  // `root.style.visibility` would leave the rule in force. It has to go.
  document.getElementById(HIDE_ID)?.remove();
};

/** The one thing the script needs that only the build knows: id → background. */
const backgroundsByTheme = () =>
  Object.fromEntries(THEMES.map((theme) => [theme.id, theme.surface.background]));

/**
 * The script itself, built at export time so the colours are inlined.
 *
 * Written as one string rather than a function that gets stringified, because a
 * bundler is free to rename anything inside a function it can see and this has
 * to survive minification exactly as written.
 */
export const prepaintScript = () => `(function(){try{
var backgrounds=${JSON.stringify(backgroundsByTheme())};
var fallback=${JSON.stringify(DEFAULT_THEME_ID)};
var raw=window.localStorage.getItem(${JSON.stringify(APPEARANCE_KEY)});
var id=raw?(JSON.parse(raw)||{}).theme:null;
if(!id||id===fallback||!backgrounds[id])return;
document.documentElement.style.backgroundColor=backgrounds[id];
document.documentElement.setAttribute('data-rps-theme',id);
var hold=document.createElement('style');
hold.id=${JSON.stringify(HIDE_ID)};
hold.textContent='#root{visibility:hidden}';
document.head.appendChild(hold);
setTimeout(function(){var n=document.getElementById(${JSON.stringify(HIDE_ID)});if(n)n.remove();},${REVEAL_ANYWAY_MS});
}catch(e){}})();`;
