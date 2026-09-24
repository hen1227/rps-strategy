import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import type { Appearance } from '@/appearance/preference';
import { PIECE_SETS } from '@/appearance/pieceSets';
import { SOUND_PACKS } from '@/appearance/soundPacks';
import { chooseAppearance, useAppearance } from '@/appearance/store';
import { setAccountAppearance } from '@/store/api/accounts';
import { useGameStore } from '@/store/gameStore';
import { BOARDS, THEMES, colors, space, themedSheet, type } from '@/theme';
import ScreenShell from '@/ui/ScreenShell';
import { Panel, SectionHeading } from '@/ui/primitives';

import AppearancePreview from './AppearancePreview';
import SoundSampler from './SoundSampler';
import SwatchChips from './SwatchChips';
import { BoardSwatch, PieceSwatch, SoundSwatch, ThemeSwatch } from './swatches';

// Choosing how the game looks and sounds.
//
// Independent axes rather than one combined "look", because the combinations
// are what make a small curated set feel large — five themes by five boards is
// twenty-five, all of them designed. Each axis is checked against every value of
// the others: the marks a board draws are alpha washes chosen to read on a light
// square and a dark one alike, so nothing here can be combined into something
// unreadable.
//
// The pieces axis has one entry today and so draws nothing; see below.
//
// Saving is immediate, with no confirm button. There is nothing to be sure
// about: the page in front of you *is* the preview, and changing your mind is
// one more tap on the thing you are already looking at.

export default function AppearanceScreen() {
  const appearance = useAppearance();
  const accountId = useGameStore((state) => state.account?.userId);
  const sessionToken = useGameStore((state) => state.sessionToken);
  // Bumped on every sound choice, so picking a pack answers in its own voice.
  const [sampleToken, setSampleToken] = useState(0);

  /**
   * Apply the choice here, then tell the account about it.
   *
   * In that order, and the second half deliberately unawaited: the look is a
   * local thing that happens to be remembered remotely, so it must not wait on
   * a round trip, and a failed save must not undo what the player just picked.
   * The worst case is that this device looks right and a phone is out of date
   * until the next change — which is what being signed out does anyway.
   */
  const choose = useCallback(
    (patch: Partial<Appearance>) => {
      // Synchronous, and before anything async: `chooseAppearance` mutates the
      // token objects outside React, and doing that anywhere but in the event
      // handler risks a half-rendered tree. See `appearance/store.ts`.
      chooseAppearance(patch);
      if (!accountId || !sessionToken) return;
      const next = { ...appearance, ...patch };
      void setAccountAppearance(accountId, sessionToken, JSON.stringify(next)).catch(() => {
        // Saved on this device regardless. Nothing on this page is worth an
        // error banner over a look that is already on screen.
      });
    },
    [accountId, appearance, sessionToken],
  );

  return (
    <ScreenShell>
      <View style={styles.page}>
        <View style={styles.intro}>
          <Text style={styles.title}>Appearance</Text>
        </View>

        <AppearancePreview />

        <Panel style={styles.panel}>
          <SectionHeading eyebrow="Colour" title="Theme" />
          <SwatchChips
            label="Theme"
            onChange={(theme) => choose({ theme })}
            options={THEMES.map((spec) => ({
              value: spec.id,
              label: spec.name,
              blurb: spec.blurb,
              preview: <ThemeSwatch spec={spec} />,
            }))}
            value={appearance.theme}
          />
        </Panel>

        <Panel style={styles.panel}>
          <SectionHeading eyebrow="Squares" title="Board" />
          <SwatchChips
            label="Board"
            onChange={(board) => choose({ board })}
            options={BOARDS.map((spec) => ({
              value: spec.id,
              label: spec.name,
              blurb: spec.blurb,
              preview: <BoardSwatch spec={spec} />,
            }))}
            value={appearance.board}
          />
        </Panel>

        {/*
          Hidden while there is one set, rather than drawn as a row of one.
          A picker whose only choice is already made is a control that does
          nothing, and it reads as a feature that is broken rather than as one
          that has not arrived. It comes back on its own the moment a second set
          is added to `PIECE_SETS` — there is nothing to remember to undo.
        */}
        {PIECE_SETS.length > 1 ? (
          <Panel style={styles.panel}>
            <SectionHeading eyebrow="Artwork" title="Pieces" />
            <SwatchChips
              label="Piece set"
              onChange={(pieces) => choose({ pieces })}
              options={PIECE_SETS.map((set) => ({
                value: set.id,
                label: set.name,
                blurb: set.blurb,
                preview: <PieceSwatch set={set} />,
              }))}
              value={appearance.pieces}
            />
          </Panel>
        ) : null}

        <Panel style={styles.panel}>
          <SectionHeading eyebrow="Audio" title="Sound" />
          <SwatchChips
            label="Sound pack"
            onChange={(sound) => {
              choose({ sound });
              setSampleToken((token) => token + 1);
            }}
            options={SOUND_PACKS.map((pack) => ({
              value: pack.id,
              label: pack.name,
              blurb: pack.blurb,
              preview: (
                <SoundSwatch
                  color={pack.id === appearance.sound ? colors.accent : colors.textDim}
                  packId={pack.id}
                />
              ),
            }))}
            value={appearance.sound}
          />
        </Panel>
      </View>
      <SoundSampler token={sampleToken} />
    </ScreenShell>
  );
}

const styles = themedSheet(() => ({
  page: { gap: space.large, paddingVertical: space.large },
  intro: { gap: space.tight },
  title: { ...type.screenTitle, color: colors.textStrong },
  lede: { ...type.body, color: colors.textMuted },
  panel: { gap: space.medium },
}));
