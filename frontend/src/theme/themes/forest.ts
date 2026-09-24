import type { ThemeSpec } from '../spec';

// The look this app shipped with: warm neutrals, a green accent, and the two
// player hues. Every value here was lifted from the old `theme.ts` unchanged,
// which is what `theme/snapshot.test.mts` asserts — the day themes arrived is
// not a day anybody's board should have changed colour.
export const forest: ThemeSpec = {
  id: 'forest',
  name: 'Forest',
  blurb: 'Warm neutrals and a green accent. The original.',
  scheme: 'dark',

  scrim: '#171613',
  rim: '#ffffff',

  surface: {
    background: '#312e2b',
    surface: '#262522',
    surfaceRaised: '#302e2a',
    surfaceSunken: '#211f1d',
    surfaceMuted: '#3a3833',
    surfaceWell: '#1f1e1b',
    surfaceDeep: '#171613',
  },
  border: {
    border: '#45423e',
    borderStrong: '#514e49',
    borderSoft: '#3d3a36',
    borderLight: '#68645e',
    borderFaint: '#53514c',
  },
  text: {
    text: '#f5f5f5',
    textStrong: '#ffffff',
    textSoft: '#d9d6d0',
    textSubtle: '#c2bfb9',
    textMuted: '#aaa7a2',
    textDim: '#8f8c86',
    textFaint: '#77736d',
    textInverse: '#211f1d',
  },
  accent: {
    accent: '#81b64c',
    accentBright: '#a3d160',
    accentSoft: '#b8d993',
    accentText: '#a9c497',
    accentTextStrong: '#e5f4d9',
    accentSurfaceQuiet: '#2b3026',
    accentSurface: '#303a2b',
    accentSurfaceRaised: '#35462e',
    accentSurfaceStrong: '#3b4a30',
    accentBorder: '#5f7950',
  },
  gold: {
    gold: '#f0c964',
    goldBright: '#f0deb0',
    goldSoft: '#f4dda3',
    goldMuted: '#ad9d75',
    goldDot: '#d5ae4f',
    goldSurface: '#4a4027',
    goldSurfaceDeep: '#29251b',
    goldBorder: '#725f32',
  },
  danger: {
    danger: '#c84b44',
    dangerStrong: '#8f3a30',
    dangerSurface: '#5a302d',
    dangerSurfaceQuiet: '#3a2724',
    dangerBorder: '#6e3a35',
    dangerText: '#ffd2ce',
    dangerSoft: '#c85e58',
  },
  live: {
    live: '#e07a5f',
    liveSoft: '#f0b8a5',
    liveSurface: '#432f2a',
    liveBorder: '#7a4b3c',
  },
  notice: { noticeSurface: '#30462c', noticeText: '#d5efca' },
  discord: { discordBorder: '#3f77aa', discordSurface: '#2f3f52' },
  title: { titleBackground: '#45423e', titleText: '#f5f5f5' },

  players: {
    Red: {
      strong: '#c84b44',
      soft: '#c85e58',
      pale: '#dd8e85',
      contrast: '#ffd2ce',
      surface: '#5a302d',
      border: '#a85d52',
    },
    Blue: {
      strong: '#3f77aa',
      soft: '#8fb4d8',
      pale: '#a3c0e1',
      contrast: '#d8ecff',
      surface: '#2f3f52',
      border: '#527da1',
    },
  },
  medal: {
    // Lighter than the gold border and than either of the other two plinths,
    // which is what makes first place read as first at a glance rather than
    // after comparing three borders.
    firstSurface: '#3d3520',
    // Third place. The one hue the scheme had no answer for: the golds are all
    // yellow and the reds are all player red, and a bronze that is either does
    // not read as the third medal beside the other two.
    bronzeText: '#c99160',
    bronzeSurface: '#2b2118',
    bronzeBorder: '#5c3f28',
  },
  signals: {
    orange: '#f2811d',
    orangeDeep: '#6d2f00',
    orangeSoft: '#ffcc99',
    purple: '#9b6fe8',
    coral: '#f0643e',
    clockFace: '#e9e5dc',
    clockFaceText: '#211f1d',
    clockFaceLow: '#f3ded9',
    clockFaceLowText: '#8f3a30',
    selection: '#f0c964',
    selectionMark: '#f4dda3',
    lastMove: '#a3d160',
    lastMoveMark: '#e5f4d9',
  },

  monogram: ['#5b8266', '#7a5c9e', '#b5763f', '#3f7b91', '#9e5c6b', '#6b7a3f'],
};
