// The colours this app shipped with, frozen.
//
// Not documentation and not a default: this is the fixture
// `snapshot.test.mts` holds `buildTheme(forest, forest)` against. Turning one
// palette into a theme system is a refactor nobody should be able to see, and
// this file is what proves it — every value below was read out of the old
// `theme.ts` the hour before it was replaced.
//
// A change here is a change to how the original theme looks. If you meant that,
// say so in the changelog; if you did not, the test has just caught something.

export const FOREST_SNAPSHOT = {
  "colors": {
    "background": "#312e2b",
    "surface": "#262522",
    "surfaceRaised": "#302e2a",
    "surfaceSunken": "#211f1d",
    "surfaceMuted": "#3a3833",
    "surfaceWell": "#1f1e1b",
    "surfaceDeep": "#171613",
    "border": "#45423e",
    "borderStrong": "#514e49",
    "borderSoft": "#3d3a36",
    "borderLight": "#68645e",
    "borderFaint": "#53514c",
    "accent": "#81b64c",
    "accentBright": "#a3d160",
    "accentSoft": "#b8d993",
    "accentText": "#a9c497",
    "accentTextStrong": "#e5f4d9",
    "accentSurfaceQuiet": "#2b3026",
    "accentSurface": "#303a2b",
    "accentSurfaceRaised": "#35462e",
    "accentSurfaceStrong": "#3b4a30",
    "accentBorder": "#5f7950",
    "text": "#f5f5f5",
    "textStrong": "#ffffff",
    "textSoft": "#d9d6d0",
    "textSubtle": "#c2bfb9",
    "textMuted": "#aaa7a2",
    "textDim": "#8f8c86",
    "textFaint": "#77736d",
    "textInverse": "#211f1d",
    "discordBorder": "#3f77aa",
    "discordSurface": "#2f3f52",
    "discordBrand": "#5865f2",
    "discordBrandPressed": "#4752c4",
    "titleBackground": "#45423e",
    "titleText": "#f5f5f5",
    "titleBorder": "rgba(255, 255, 255, 0.22)",
    "live": "#e07a5f",
    "liveSoft": "#f0b8a5",
    "liveSurface": "#432f2a",
    "liveBorder": "#7a4b3c",
    "gold": "#f0c964",
    "goldBright": "#f0deb0",
    "goldSoft": "#f4dda3",
    "goldMuted": "#ad9d75",
    "goldDot": "#d5ae4f",
    "goldSurface": "#4a4027",
    "goldSurfaceDeep": "#29251b",
    "goldBorder": "#725f32",
    "danger": "#c84b44",
    "dangerStrong": "#8f3a30",
    "dangerSurface": "#5a302d",
    "dangerSurfaceQuiet": "#3a2724",
    "dangerBorder": "#6e3a35",
    "dangerText": "#ffd2ce",
    "dangerSoft": "#c85e58",
    "noticeSurface": "#30462c",
    "noticeText": "#d5efca",
    "overlay": "rgba(23, 22, 19, 0.78)",
    "overlayQuiet": "rgba(23, 22, 19, 0.38)"
  },
  "players": {
    "Red": {
      "strong": "#c84b44",
      "soft": "#c85e58",
      "contrast": "#ffd2ce",
      "surface": "#5a302d",
      "border": "#a85d52",
      "territory": "#a85d52",
      "tint": "rgba(200, 75, 68, 0.42)",
      "tintBorder": "rgba(221, 142, 133, 0.68)",
      "territoryMark": "rgba(255, 210, 206, 0.62)",
      "reachOnLight": [
        "rgba(200, 75, 68, 0.44)",
        "rgba(200, 75, 68, 0.39125)",
        "rgba(200, 75, 68, 0.3425)",
        "rgba(200, 75, 68, 0.29375)",
        "rgba(200, 75, 68, 0.245)",
        "rgba(200, 75, 68, 0.19624999999999998)",
        "rgba(200, 75, 68, 0.14750000000000002)",
        "rgba(200, 75, 68, 0.09875)",
        "rgba(200, 75, 68, 0.04999999999999999)"
      ],
      "reachOnDark": [
        "rgba(221, 142, 133, 0.4)",
        "rgba(221, 142, 133, 0.35500000000000004)",
        "rgba(221, 142, 133, 0.31)",
        "rgba(221, 142, 133, 0.265)",
        "rgba(221, 142, 133, 0.22)",
        "rgba(221, 142, 133, 0.175)",
        "rgba(221, 142, 133, 0.13)",
        "rgba(221, 142, 133, 0.08499999999999996)",
        "rgba(221, 142, 133, 0.03999999999999998)"
      ]
    },
    "Blue": {
      "strong": "#3f77aa",
      "soft": "#8fb4d8",
      "contrast": "#d8ecff",
      "surface": "#2f3f52",
      "border": "#527da1",
      "territory": "#527da1",
      "tint": "rgba(63, 119, 170, 0.42)",
      "tintBorder": "rgba(163, 192, 225, 0.68)",
      "territoryMark": "rgba(216, 236, 255, 0.62)",
      "reachOnLight": [
        "rgba(63, 119, 170, 0.44)",
        "rgba(63, 119, 170, 0.39125)",
        "rgba(63, 119, 170, 0.3425)",
        "rgba(63, 119, 170, 0.29375)",
        "rgba(63, 119, 170, 0.245)",
        "rgba(63, 119, 170, 0.19624999999999998)",
        "rgba(63, 119, 170, 0.14750000000000002)",
        "rgba(63, 119, 170, 0.09875)",
        "rgba(63, 119, 170, 0.04999999999999999)"
      ],
      "reachOnDark": [
        "rgba(163, 192, 225, 0.4)",
        "rgba(163, 192, 225, 0.35500000000000004)",
        "rgba(163, 192, 225, 0.31)",
        "rgba(163, 192, 225, 0.265)",
        "rgba(163, 192, 225, 0.22)",
        "rgba(163, 192, 225, 0.175)",
        "rgba(163, 192, 225, 0.13)",
        "rgba(163, 192, 225, 0.08499999999999996)",
        "rgba(163, 192, 225, 0.03999999999999998)"
      ]
    }
  },
  "board": {
    "frame": "#171613",
    "lightTile": "#d7c5a3",
    "darkTile": "#337533",
    "lightTileOverArt": "rgba(215, 197, 163, 0.62)",
    "darkTileOverArt": "rgba(51, 117, 51, 0.62)",
    "labelOnLight": "rgba(138, 101, 18, 0.85)",
    "labelOnDark": "rgba(215, 197, 163, 0.9)",
    "goalOutline": "rgba(255, 255, 255, 0.28)",
    "selectionTint": "rgba(240, 201, 100, 0.5)",
    "selectionMark": "rgba(244, 221, 163, 0.9)",
    "lastMoveFrom": "rgba(163, 209, 96, 0.5)",
    "lastMoveTo": "rgba(163, 209, 96, 0.7)",
    "lastMoveMark": "rgba(229, 244, 217, 0.72)",
    "moveHint": "rgba(23, 22, 19, 0.42)",
    "arrowOutline": "rgba(23, 22, 19, 0.5)",
    "annotation": "#f2811d",
    "annotationTint": "rgba(242, 129, 29, 0.78)",
    "annotationMark": "rgba(255, 255, 255, 0.76)",
    "analysisArrows": [
      "#a3d160",
      "#8fb4d8",
      "#f0c964",
      "#9b6fe8",
      "#f0643e"
    ]
  },
  "reach": {
    "danger": "rgba(242, 129, 29, 0.44)",
    "dangerRing": "rgba(242, 129, 29, 0.92)",
    "hunterOnLight": "rgba(109, 47, 0, 0.95)",
    "hunterOnDark": "#ffcc99",
    "path": "rgba(155, 111, 232, 0.5)",
    "pathRing": "rgba(155, 111, 232, 0.95)",
    "contestedTie": "rgba(255, 255, 255, 0.3)",
    "frontierRing": "rgba(255, 255, 255, 0.72)",
    "ghostRing": "rgba(240, 201, 100, 0.9)",
    "ghostFill": "rgba(240, 201, 100, 0.22)",
    "numberOnLight": "rgba(23, 22, 19, 0.88)",
    "numberOnDark": "rgba(255, 255, 255, 0.92)"
  },
  "podium": [
    {
      "text": "#f0deb0",
      "surface": "#3d3520",
      "border": "#725f32"
    },
    {
      "text": "#d9d6d0",
      "surface": "#302e2a",
      "border": "#514e49"
    },
    {
      "text": "#c99160",
      "surface": "#2b2118",
      "border": "#5c3f28"
    }
  ],
  "record": {
    "win": "#81b64c",
    "draw": "#53514c",
    "loss": "#a85d52"
  },
  "moveQuality": {
    "best": "#a3d160",
    "great": "#9b6fe8",
    "excellent": "#8fb4d8",
    "good": "#b8d993",
    "inaccuracy": "#f0c964",
    "mistake": "#f2811d",
    "blunder": "#f0643e"
  },
  "evaluationChart": {
    "background": "#171613",
    "blueArea": "#2f3f52",
    "blueHighlight": "#3f77aa",
    "redArea": "#5a302d",
    "redHighlight": "#c84b44",
    "line": "#f5f5f5",
    "lineGlow": "rgba(23, 22, 19, 0.55)",
    "selection": "#a3d160",
    "selectionWash": "rgba(163, 209, 96, 0.16)"
  },
  "evalBar": {
    "divider": "#f5f5f5",
    "badgeOnRed": "rgba(255, 255, 255, 0.9)",
    "badgeOnRedText": "#8f3a30",
    "badgeOnBlue": "rgba(23, 22, 19, 0.86)",
    "badgeOnBlueText": "#d8ecff"
  },
  "clock": {
    "idleSurface": "#3a3833",
    "idleText": "#c2bfb9",
    "idlePulse": "#68645e",
    "activeSurface": "#e9e5dc",
    "activeText": "#211f1d",
    "activePulse": "#81b64c",
    "lowSurface": "#f3ded9",
    "lowText": "#8f3a30",
    "lowPulse": "#c84b44",
    "bonusWash": "rgba(59, 74, 48, 0.9)",
    "bonusWashLit": "rgba(163, 209, 96, 0.62)",
    "bonusChip": "#35462e",
    "bonusChipBorder": "#5f7950",
    "bonusChipText": "#e5f4d9"
  },
  "shadows": {
    "board": [
      {
        "offsetX": 0,
        "offsetY": 10,
        "blurRadius": 16,
        "color": "rgba(23, 22, 19, 0.38)"
      }
    ],
    "piece": [
      {
        "offsetX": 0,
        "offsetY": 6,
        "blurRadius": 4,
        "color": "rgba(23, 22, 19, 0.58)"
      }
    ],
    "banner": [
      {
        "offsetX": 0,
        "offsetY": 5,
        "blurRadius": 8,
        "color": "rgba(23, 22, 19, 0.36)"
      }
    ],
    "modal": [
      {
        "offsetX": 0,
        "offsetY": 12,
        "blurRadius": 22,
        "color": "rgba(23, 22, 19, 0.55)"
      }
    ],
    "rail": [
      {
        "offsetX": 0,
        "offsetY": 6,
        "blurRadius": 14,
        "color": "rgba(23, 22, 19, 0.34)"
      }
    ]
  }
} as const;
