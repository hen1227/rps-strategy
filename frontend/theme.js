// One palette for the whole app. Screens and components import these tokens
// instead of repeating hex values, so the board, lobby, and tournament views
// stay visually consistent.
export const colors = {
  background: '#312e2b',
  surface: '#262522',
  surfaceRaised: '#302e2a',
  surfaceSunken: '#211f1d',
  surfaceMuted: '#3a3833',

  border: '#45423e',
  borderStrong: '#514e49',

  accent: '#81b64c',
  accentBright: '#a3d160',
  accentSoft: '#b8d993',
  accentSurface: '#303a2b',
  accentBorder: '#5f7950',

  text: '#f5f5f5',
  textStrong: '#ffffff',
  textMuted: '#aaa7a2',
  textFaint: '#77736d',

  live: '#e07a5f',
  liveSurface: '#432f2a',
  gold: '#f0c964',
  goldSurface: '#4a4027',

  dangerSurface: '#5a302d',
  dangerText: '#ffd2ce',
  noticeSurface: '#30462c',
  noticeText: '#d5efca',
};

export const radius = { small: 6, medium: 9, large: 13 };

// Layout breakpoint where the lobby splits into two columns.
export const WIDE_LAYOUT_WIDTH = 900;
