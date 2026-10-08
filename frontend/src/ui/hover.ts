import { Platform } from 'react-native';

import { DEFAULT_THEME_ID, THEMES, type ThemeSpec } from '@/theme';

// Hover, which React Native has no way to say.
//
// `StyleSheet.create` has no pseudo-classes, and the usual workaround —
// `Pressable`'s `onHoverIn` — is no help here twice over: it re-renders on
// every mouse crossing, and it only exists on a component that draws its own
// box. Nearly every name on this site is a `Text`, frequently inside another
// `Text`, and neither of those can carry a hover handler at all.
//
// So the hover rules this app needs are real CSS. A name's underline reaches
// the element through expo-router's `className`, which the web build resolves
// into a DOM class and native ignores entirely; a control's wash reaches it
// through react-native-web's `dataSet`, which becomes a `data-*` attribute.
// The rules themselves are served from the HTML shell in `src/app/+html.tsx`,
// which is the only place a stylesheet can live. Both halves are here so that
// neither can be edited without the other in view — a class with no rule
// behind it fails silently, and looks exactly like a control with no hover.

/** Worn by anything that should underline while the pointer is over it. */
export const HOVER_UNDERLINE_CLASS = 'rps-hover-underline';

/**
 * The washes a control can take under the pointer.
 *
 * `row` is a navigation row lifting to the raised surface; `primary` and
 * `secondary` are the two filled buttons stepping one shade brighter; `text`
 * is a text button's words going to the strongest ink.
 */
export type HoverKind = 'row' | 'primary' | 'secondary' | 'text';

/**
 * What a pressable wears to take a hover wash on the web.
 *
 * Only on the web, where there is a pointer to hover with; a native view is
 * handed nothing at all rather than a prop it has no use for.
 */
export const hoverProps = (kind: HoverKind): object =>
  Platform.OS === 'web' ? { dataSet: { rpsHover: kind } } : {};

/**
 * One theme's washes.
 *
 * A colour per theme rather than a filter or a translucent white, because the
 * direction is the theme's to decide: a raised surface is lighter than a card
 * on a dark theme and darker on the light one. The page carries the theme's id
 * on `<html>` — the pre-paint script writes it, and so does every runtime
 * switch — so a rule scoped to it follows the theme without a line of script.
 *
 * `!important` on the two buttons only: a link-button's style is one resolved
 * object and reaches the DOM inline, which a stylesheet cannot otherwise beat.
 * A disabled control keeps its own look.
 */
const washes = (theme: ThemeSpec, scoped: boolean) => {
  const scope = scoped ? `html[data-rps-theme="${theme.id}"] ` : '';
  const live = ':not([aria-disabled="true"]):hover';
  return (
    `${scope}[data-rps-hover="row"]:hover{background-color:${theme.surface.surfaceRaised}}` +
    `${scope}[data-rps-hover="secondary"]${live}{background-color:${theme.surface.surfaceMuted}!important}` +
    `${scope}[data-rps-hover="primary"]${live}{background-color:${theme.accent.accentBright}!important;border-color:${theme.accent.accentBright}!important}` +
    `${scope}[data-rps-hover="text"]${live}>*{color:${theme.text.textStrong}}`
  );
};

const defaultTheme = THEMES.find((theme) => theme.id === DEFAULT_THEME_ID) ?? THEMES[0]!;

/**
 * The rules themselves, for `+html.tsx` to serve.
 *
 * A class or an attribute plus `:hover` outranks the single-class rules React
 * Native Web compiles its own styles into, which is what lets these win
 * against them — and against the `text-decoration: none` every `Text` is reset
 * with — so the two stylesheets can be inserted in either order.
 *
 * The cursor is stated rather than left to the browser. An anchor gets one for
 * free, but a name is only an anchor when it has somewhere to go, and this is
 * also worn by rows that navigate through `onPress`.
 *
 * The unscoped washes are the default theme's, for a page that has not been
 * told its theme, which is the pre-rendered one; every theme then has its own,
 * scoped to its id and so the more specific of the two.
 */
export const HOVER_STYLESHEET =
  `.${HOVER_UNDERLINE_CLASS}{cursor:pointer}` +
  `.${HOVER_UNDERLINE_CLASS}:hover{text-decoration:underline}` +
  washes(defaultTheme, false) +
  THEMES.map((theme) => washes(theme, true)).join('');
