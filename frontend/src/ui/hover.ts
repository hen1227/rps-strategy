// Hover, which React Native has no way to say.
//
// `StyleSheet.create` has no pseudo-classes, and the usual workaround —
// `Pressable`'s `onHoverIn` — is no help here twice over: it re-renders on
// every mouse crossing, and it only exists on a component that draws its own
// box. Nearly every name on this site is a `Text`, frequently inside another
// `Text`, and neither of those can carry a hover handler at all.
//
// So the one hover rule this app needs is real CSS. The class reaches the
// element through expo-router's `className`, which the web build resolves into
// a DOM class and native ignores entirely; the rule is served from the HTML
// shell in `src/app/+html.tsx`, which is the only place a stylesheet can live.
// Both halves are here so that neither can be edited without the other in
// view — a class with no rule behind it fails silently, and looks exactly like
// a link that simply is not a link.

/** Worn by anything that should underline while the pointer is over it. */
export const HOVER_UNDERLINE_CLASS = 'rps-hover-underline';

/**
 * The rule itself, for `+html.tsx` to serve.
 *
 * A class plus `:hover` outranks the single-class rules React Native Web
 * compiles its own styles into, which is what lets this win against the
 * `text-decoration: none` every `Text` is reset with — so the two stylesheets
 * can be inserted in either order without the underline coming and going.
 *
 * The cursor is stated rather than left to the browser. An anchor gets one for
 * free, but a name is only an anchor when it has somewhere to go, and this is
 * also worn by rows that navigate through `onPress`.
 */
export const HOVER_STYLESHEET =
  `.${HOVER_UNDERLINE_CLASS}{cursor:pointer}` +
  `.${HOVER_UNDERLINE_CLASS}:hover{text-decoration:underline}`;
