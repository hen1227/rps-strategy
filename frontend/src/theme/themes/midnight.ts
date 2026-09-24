import type { ThemeSpec } from '../spec';

// Cool and deep: blue-grey neutrals under a teal accent.
//
// The player blue is the one hue that had to move. Forest's is a muted slate
// that reads perfectly against warm brown and disappears into a page that is
// already blue, so this preset lifts it to something brighter and more
// saturated than any surface here — a side you cannot find on the board is a
// worse bug than a theme that looks slightly less calm.
export const midnight: ThemeSpec = {
  id: 'midnight',
  name: 'Midnight',
  blurb: 'Deep blue-grey with a teal accent.',
  scheme: 'dark',

  scrim: '#05070c',
  rim: '#ffffff',

  surface: {
    background: '#1b2030',
    surface: '#161b28',
    surfaceRaised: '#202636',
    surfaceSunken: '#12161f',
    surfaceMuted: '#2a3145',
    surfaceWell: '#10131c',
    surfaceDeep: '#090b12',
  },
  border: {
    border: '#343d54',
    borderStrong: '#424c66',
    borderSoft: '#2b3245',
    borderLight: '#5c6784',
    borderFaint: '#3e4659',
  },
  text: {
    text: '#f1f4fa',
    textStrong: '#ffffff',
    textSoft: '#d9dfee',
    textSubtle: '#c0c8dd',
    textMuted: '#a6afc7',
    textDim: '#8b94af',
    textFaint: '#737d97',
    textInverse: '#12161f',
  },
  accent: {
    accent: '#2fb3a6',
    accentBright: '#52d2c4',
    accentSoft: '#93ded6',
    accentText: '#86c7c0',
    accentTextStrong: '#d8f6f2',
    accentSurfaceQuiet: '#122528',
    accentSurface: '#163034',
    accentSurfaceRaised: '#1a3b40',
    accentSurfaceStrong: '#1f464b',
    accentBorder: '#2f6f6c',
  },
  gold: {
    gold: '#f0c964',
    goldBright: '#f2ddab',
    goldSoft: '#f4dda3',
    goldMuted: '#a89d7d',
    goldDot: '#d5ae4f',
    goldSurface: '#3f3a22',
    goldSurfaceDeep: '#201e16',
    goldBorder: '#6d5e33',
  },
  danger: {
    danger: '#e0574f',
    dangerStrong: '#a03830',
    dangerSurface: '#4a2a2c',
    dangerSurfaceQuiet: '#2a1d20',
    dangerBorder: '#6b3a3c',
    dangerText: '#ffd6d2',
    dangerSoft: '#e8817a',
  },
  live: {
    live: '#e07a5f',
    liveSoft: '#f0b8a5',
    liveSurface: '#3d2c2c',
    liveBorder: '#7a4b3c',
  },
  notice: { noticeSurface: '#1c3a34', noticeText: '#c9efe6' },
  discord: { discordBorder: '#5a8fd0', discordSurface: '#26334f' },
  title: { titleBackground: '#343d54', titleText: '#f1f4fa' },

  players: {
    Red: {
      strong: '#e0574f',
      soft: '#e8817a',
      pale: '#f0a9a3',
      contrast: '#ffdad6',
      surface: '#4a2a2c',
      border: '#b05a52',
    },
    Blue: {
      strong: '#4a9eff',
      soft: '#8fc4f5',
      pale: '#b3d8ff',
      contrast: '#e0f0ff',
      surface: '#1e3a5c',
      border: '#3f7ab5',
    },
  },
  medal: {
    firstSurface: '#3f3a22',
    bronzeText: '#c99160',
    bronzeSurface: '#251d17',
    bronzeBorder: '#5c3f28',
  },
  signals: {
    orange: '#f2921d',
    orangeDeep: '#6d3a00',
    orangeSoft: '#ffd6a3',
    purple: '#a98ff5',
    coral: '#ff7a5c',
    clockFace: '#e7ecf6',
    clockFaceText: '#12161f',
    clockFaceLow: '#f7dedb',
    clockFaceLowText: '#a03830',
    selection: '#f0c964',
    selectionMark: '#f4dda3',
    lastMove: '#52d2c4',
    lastMoveMark: '#d8f6f2',
  },

  monogram: ['#4f7f8f', '#7b6bab', '#a86f4f', '#4f8f73', '#93607f', '#6f7f4f'],
};
