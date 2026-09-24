import type { ThemeSpec } from '../spec';

// Maximum separation: black surfaces, white text, and every accent pushed as
// far from its neighbours as it will go.
//
// For low vision and for playing outdoors, which are the same problem — a
// screen you cannot read — and the reason the borders here are far brighter
// than any other preset's. A border is what tells one panel from the next when
// the surfaces beneath them have nowhere left to differ.
export const contrast: ThemeSpec = {
  id: 'contrast',
  name: 'Contrast',
  blurb: "Black with bright accents.",
  scheme: 'dark',

  scrim: '#000000',
  rim: '#ffffff',

  surface: {
    background: '#0b0b0b',
    surface: '#141414',
    surfaceRaised: '#1c1c1c',
    surfaceSunken: '#060606',
    surfaceMuted: '#242424',
    surfaceWell: '#030303',
    surfaceDeep: '#000000',
  },
  border: {
    border: '#5a5a5a',
    borderStrong: '#7a7a7a',
    borderSoft: '#4a4a4a',
    borderLight: '#9a9a9a',
    borderFaint: '#6a6a6a',
  },
  text: {
    text: '#ffffff',
    textStrong: '#ffffff',
    textSoft: '#f0f0f0',
    textSubtle: '#e0e0e0',
    textMuted: '#cfcfcf',
    textDim: '#b8b8b8',
    textFaint: '#a0a0a0',
    textInverse: '#000000',
  },
  accent: {
    accent: '#5ee07a',
    accentBright: '#7ff593',
    accentSoft: '#a8ffb8',
    accentText: '#b6ffc4',
    accentTextStrong: '#e8ffed',
    accentSurfaceQuiet: '#06210c',
    accentSurface: '#0a2f12',
    accentSurfaceRaised: '#0f3d19',
    accentSurfaceStrong: '#144b20',
    accentBorder: '#2e8a46',
  },
  gold: {
    gold: '#ffd24d',
    goldBright: '#ffe9a8',
    goldSoft: '#ffe28f',
    goldMuted: '#c9b88a',
    goldDot: '#e6b93a',
    goldSurface: '#3d3212',
    goldSurfaceDeep: '#1a160a',
    goldBorder: '#8a6f22',
  },
  danger: {
    danger: '#ff5f52',
    dangerStrong: '#c62c1e',
    dangerSurface: '#4a1712',
    dangerSurfaceQuiet: '#2a0d0a',
    dangerBorder: '#8a2f24',
    dangerText: '#ffd9d4',
    dangerSoft: '#ff8377',
  },
  live: {
    live: '#ff8a5c',
    liveSoft: '#ffc4ab',
    liveSurface: '#3d2117',
    liveBorder: '#a85a38',
  },
  notice: { noticeSurface: '#0f3d19', noticeText: '#d9ffe0' },
  discord: { discordBorder: '#6a9fe0', discordSurface: '#14233d' },
  title: { titleBackground: '#5a5a5a', titleText: '#ffffff' },

  players: {
    Red: {
      strong: '#ff5f52',
      soft: '#ff8377',
      pale: '#ffb0a8',
      contrast: '#ffe6e3',
      surface: '#4a1712',
      border: '#c25348',
    },
    Blue: {
      strong: '#58a8ff',
      soft: '#8cc4ff',
      pale: '#b3daff',
      contrast: '#e6f4ff',
      surface: '#12304a',
      border: '#4a86c2',
    },
  },
  medal: {
    firstSurface: '#4a3d14',
    bronzeText: '#e0a86a',
    bronzeSurface: '#2e2118',
    bronzeBorder: '#7a5230',
  },
  signals: {
    orange: '#ff9a2e',
    orangeDeep: '#5a2400',
    orangeSoft: '#ffd9a8',
    purple: '#b98cff',
    coral: '#ff7a5c',
    clockFace: '#ffffff',
    clockFaceText: '#000000',
    clockFaceLow: '#ffd9d4',
    clockFaceLowText: '#8a1409',
    selection: '#ffd24d',
    selectionMark: '#ffe9a8',
    lastMove: '#7ff593',
    lastMoveMark: '#e8ffed',
  },

  monogram: ['#3fa06a', '#8a6ad0', '#c07a2a', '#2f8aa8', '#b05570', '#6a8a2a'],
};
