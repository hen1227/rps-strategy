import type { ThemeSpec } from '../spec';

// The light one, and the reason the spec authors roles rather than a ramp.
//
// Nothing here is Forest inverted. `surfaceRaised` is *lighter* than the page
// where Forest's is darker, because that is which way elevation goes on paper;
// every text role climbs the other way; and the accent had to be deepened to a
// green that carries small letters on a pale card rather than the bright one
// that carries them on a dark one. The two things that did not flip are the
// scrim — a shadow is dark on a light page too — and the clock, whose lit face
// is dark here precisely because the page around it is not.
export const parchment: ThemeSpec = {
  id: 'parchment',
  name: 'Parchment',
  blurb: 'Warm paper and ink. The light theme.',
  scheme: 'light',

  scrim: '#171613',
  // Dark, because on a pale row a title pill is already the darkest thing on
  // it: the rim's job here is to draw its edge, not to lift it.
  rim: '#171613',

  surface: {
    background: '#ece6d9',
    surface: '#f7f3ea',
    surfaceRaised: '#fffdf8',
    surfaceSunken: '#e2dbcb',
    surfaceMuted: '#ded6c4',
    surfaceWell: '#d8cfbc',
    surfaceDeep: '#cec4ae',
  },
  border: {
    border: '#c8bda6',
    borderStrong: '#a89a7e',
    borderSoft: '#d6cdb9',
    borderLight: '#8d8168',
    borderFaint: '#b8ac93',
  },
  text: {
    text: '#211f1a',
    textStrong: '#000000',
    textSoft: '#37332b',
    textSubtle: '#4b4539',
    textMuted: '#625b4c',
    textDim: '#7b7362',
    textFaint: '#948b78',
    textInverse: '#f7f3ea',
  },
  accent: {
    accent: '#4f8f3a',
    accentBright: '#63a84b',
    accentSoft: '#3f7a2d',
    accentText: '#3a6f29',
    accentTextStrong: '#24491a',
    accentSurfaceQuiet: '#eef5e8',
    accentSurface: '#e2eeda',
    accentSurfaceRaised: '#d4e5c9',
    accentSurfaceStrong: '#c3d9b5',
    accentBorder: '#7fae68',
  },
  gold: {
    gold: '#a8801c',
    goldBright: '#856313',
    goldSoft: '#6b4f0e',
    goldMuted: '#9c8a5e',
    goldDot: '#c19a30',
    goldSurface: '#f6ecd2',
    goldSurfaceDeep: '#fbf5e5',
    goldBorder: '#d9c188',
  },
  danger: {
    danger: '#b8342c',
    dangerStrong: '#8a231c',
    dangerSurface: '#f7dcd9',
    dangerSurfaceQuiet: '#fcecea',
    dangerBorder: '#e0a8a2',
    dangerText: '#6e1a14',
    dangerSoft: '#cc4f46',
  },
  live: {
    live: '#c2502e',
    liveSoft: '#8a3a20',
    liveSurface: '#fae2d8',
    liveBorder: '#e0a98f',
  },
  notice: { noticeSurface: '#e4f0dc', noticeText: '#2c4a22' },
  discord: { discordBorder: '#4a7fc1', discordSurface: '#dce7f5' },
  // The tag stays a dark pill with light letters, like every other title tag —
  // those are fixed across themes, and the unknown one has to match them.
  title: { titleBackground: '#6f6553', titleText: '#f7f3ea' },

  players: {
    Red: {
      strong: '#b8342c',
      soft: '#cc4f46',
      pale: '#e08a82',
      contrast: '#ffe0dc',
      surface: '#f2d6d2',
      border: '#a8544c',
    },
    Blue: {
      strong: '#2f6fa8',
      soft: '#4d8cc4',
      pale: '#8fb8dc',
      contrast: '#dff0ff',
      surface: '#d6e6f4',
      border: '#4d7ea8',
    },
  },
  medal: {
    firstSurface: '#f3e6c2',
    bronzeText: '#7a4a1e',
    bronzeSurface: '#f2e2d2',
    bronzeBorder: '#c99160',
  },
  signals: {
    orange: '#d9660a',
    orangeDeep: '#6d2f00',
    orangeSoft: '#ffcc99',
    purple: '#7b4fd0',
    coral: '#e04a20',
    // Dark on purpose: on a pale page the running clock is the thing that has
    // to be found at a glance, and a pale panel on pale paper is not it.
    clockFace: '#2c2823',
    clockFaceText: '#f7f3ea',
    clockFaceLow: '#4a2320',
    clockFaceLowText: '#ffd2ce',
    // Unchanged from Forest: these are drawn on the board, which this theme
    // does not touch. See `SignalSeed`.
    selection: '#f0c964',
    selectionMark: '#f4dda3',
    lastMove: '#a3d160',
    lastMoveMark: '#e5f4d9',
  },

  monogram: ['#4a7a5e', '#6b5091', '#a05f2f', '#356a80', '#8a4f5e', '#5c6a3a'],
};
