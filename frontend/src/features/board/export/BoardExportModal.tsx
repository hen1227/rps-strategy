import { useEffect, useMemo, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from 'react-native';

import { encodePosition, encodePositionPGN } from '@/engine/pgn';
import { failureMessage } from '@/errors';
import { colors, radius, space, themedSheet, type } from '@/theme';
import { SITE_URL } from '@/store/serverConfig';
import ModalCard from '@/ui/ModalCard';
import { Checkbox, GhostButton, PrimaryButton } from '@/ui/primitives';
import { modeHasFeature } from '@/types/game';

import {
  DEFAULT_SHARE_OPTIONS,
  buildShareCard,
  trayCount,
  type ShareCardInput,
  type ShareCardOptions,
} from './shareCard';
import {
  PNG_SUPPORTED,
  copyShareCard,
  downloadShareCard,
  shareCardDataURL,
} from './shareImage';

// One dialog for every way of taking a board away with you.
//
// It exists because the three ways are one decision, not three buttons: a
// person who wants this position somewhere else does not know yet whether they
// want text they can paste back or a picture they can post, and offering both
// from the same place is what lets them find out. The alternative was four
// buttons in a row under every board, three of which are wrong at any moment.
//
// The switches all belong to the picture, and the picture is redrawn as they
// move, because the only honest preview of an export is the export.

/** What each switch is called, and what it adds. */
const SWITCHES: { key: keyof ShareCardOptions; label: string }[] = [
  { key: 'names', label: 'Players' },
  { key: 'clocks', label: 'Clocks' },
  { key: 'captures', label: 'Captured pieces' },
  { key: 'coordinates', label: 'Coordinates' },
  { key: 'lastMove', label: 'Last move' },
  { key: 'labels', label: 'Mode and caption' },
];

/** How tall the preview is drawn. The width follows the card's own shape. */
const PREVIEW_HEIGHT = 256;

/** The bare host to sign a picture with — `rps.henhen1227.com`. */
const hostOfSite = () => {
  try {
    return new URL(SITE_URL).host;
  } catch {
    return null;
  }
};

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'position';

export interface BoardExportModalProps {
  visible: boolean;
  onClose: () => void;
  /** The board, and everything the picture may say about it. */
  board: ShareCardInput;
}

export default function BoardExportModal({ visible, onClose, board }: BoardExportModalProps) {
  const { grid, currentTurn, mode, era, flipped, lastMove, detail } = board;
  const [options, setOptions] = useState<ShareCardOptions>(DEFAULT_SHARE_OPTIONS);
  const [status, setStatus] = useState<{ text: string; bad: boolean } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const fen = useMemo(
    () =>
      encodePosition(grid, currentTurn, { territory: modeHasFeature(mode, 'territory') }),
    [currentTurn, grid, mode],
  );
  const record = useMemo(
    () => encodePositionPGN({ currentTurn, grid, mode }),
    [currentTurn, grid, mode],
  );

  // Only offer a switch for something this board actually has. An analysis
  // board has no players and no clock, and three dead checkboxes would be three
  // promises the picture cannot keep.
  const offered = useMemo(() => {
    const has: Record<keyof ShareCardOptions, boolean> = {
      names: Boolean(detail?.players),
      clocks: Boolean(detail?.clock),
      captures:
        trayCount(detail?.captured?.Red) + trayCount(detail?.captured?.Blue) > 0,
      coordinates: true,
      lastMove: Boolean(lastMove),
      labels: true,
    };
    return SWITCHES.filter((entry) => has[entry.key]);
  }, [detail, lastMove]);

  const plan = useMemo(
    () =>
      buildShareCard({
        grid,
        currentTurn,
        mode,
        era,
        flipped,
        lastMove,
        // Signed here rather than by each of the six screens that open this
        // dialog. `SITE_URL` is deliberately not something to render — it
        // answers differently in the build and in the browser — and this is not
        // rendering it: the plan becomes pixels on a canvas, in an effect, on a
        // dialog that only exists after somebody pressed a button.
        detail: { site: hostOfSite(), ...detail },
        options,
      }),
    [currentTurn, detail, era, flipped, grid, lastMove, mode, options],
  );

  useEffect(() => {
    if (!visible) return;
    setStatus(null);
    setOptions(DEFAULT_SHARE_OPTIONS);
  }, [visible]);

  // The preview is the export, drawn small. Re-run on every change to the plan,
  // and thrown away when the dialog closes so a stale board is never the first
  // thing the next one shows.
  useEffect(() => {
    if (!visible || !PNG_SUPPORTED) return undefined;
    let current = true;
    setPreviewError(null);
    shareCardDataURL(plan, { scale: 1 })
      .then((url) => {
        if (current) setPreview(url);
      })
      .catch((error) => {
        if (current) setPreviewError(failureMessage(error, 'The preview could not be drawn.'));
      });
    return () => {
      current = false;
    };
  }, [plan, visible]);

  useEffect(() => {
    if (!visible) setPreview(null);
  }, [visible]);

  const copyText = async (text: string, what: string) => {
    try {
      const ok = await Clipboard.setStringAsync(text);
      setStatus(
        ok
          ? { text: `${what} copied to your clipboard.`, bad: false }
          : { text: "Could not copy. Select the text and copy it manually.", bad: true },
      );
    } catch (error) {
      setStatus({ text: failureMessage(error, 'The clipboard could not be written.'), bad: true });
    }
  };

  const filename = `${slug(
    detail?.players
      ? `${detail.players.Blue.name} vs ${detail.players.Red.name}`
      : `${mode.shortCode || mode.id} position`,
  )}.png`;

  const previewWidth = PREVIEW_HEIGHT * (plan.width / Math.max(plan.height, 1));

  return (
    <ModalCard
      closeLabel="Close the export dialog"
      eyebrow="EXPORT"
      maxWidth={560}
      onClose={onClose}
      subtitle="Copy the position or save a picture."
      title="Share this board"
      visible={visible}
    >
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.eyebrow}>POSITION</Text>
        {/*
          `minWidth: 0` is what lets the line wrap rather than push the card
          wide: a position is one unbroken token, and a flexed child measures at
          its content width without it. See the same note in the score sheet.
        */}
        <View style={styles.codeBox}>
          <Text selectable style={styles.code}>
            {fen}
          </Text>
        </View>
        <Text style={styles.hint}>
          {modeHasFeature(mode, 'territory')
            ? 'Pieces, the side to move, then who owns each tile.'
            : "Pieces and side to move. This mode does not use territory."}
        </Text>
        <View style={styles.actions}>
          <PrimaryButton label="COPY FEN" onPress={() => copyText(fen, 'Position')} />
          <GhostButton
            accessibilityLabel="Copy this position as a PGN record"
            compact={false}
            label="COPY AS PGN"
            onPress={() => copyText(record, 'Record')}
          />
        </View>
        <Text style={styles.hint}>
          PGN includes the position and game mode.
        </Text>

        {PNG_SUPPORTED ? (
          <>
            <View style={styles.rule} />
            <Text style={styles.eyebrow}>PICTURE</Text>
            <View style={[styles.preview, { height: PREVIEW_HEIGHT + space.snug * 2 }]}>
              {previewError ? (
                <Text style={styles.previewError}>{previewError}</Text>
              ) : preview ? (
                <Image
                  accessibilityLabel="Preview of the picture that will be saved"
                  resizeMode="contain"
                  source={{ uri: preview }}
                  style={{ height: PREVIEW_HEIGHT, width: previewWidth }}
                />
              ) : (
                <ActivityIndicator color={colors.accent} />
              )}
            </View>
            <View style={styles.switches}>
              {offered.map((entry) => (
                <View key={entry.key} style={styles.switch}>
                  <Checkbox
                    checked={options[entry.key]}
                    label={entry.label}
                    onToggle={() =>
                      setOptions((current) => ({ ...current, [entry.key]: !current[entry.key] }))
                    }
                  />
                </View>
              ))}
            </View>
            <View style={styles.actions}>
              <PrimaryButton
                label="SAVE PNG"
                onPress={async () => {
                  try {
                    await downloadShareCard(plan, filename);
                    setStatus({ text: `Saved as ${filename}.`, bad: false });
                  } catch (error) {
                    setStatus({
                      text: failureMessage(error, 'The picture could not be saved.'),
                      bad: true,
                    });
                  }
                }}
              />
              <GhostButton
                accessibilityLabel="Copy the picture to the clipboard"
                compact={false}
                label="COPY IMAGE"
                onPress={async () => {
                  try {
                    await copyShareCard(plan);
                    setStatus({ text: 'The picture is on your clipboard.', bad: false });
                  } catch (error) {
                    setStatus({
                      text: failureMessage(error, 'The picture could not be copied.'),
                      bad: true,
                    });
                  }
                }}
              />
            </View>
          </>
        ) : null}

        {status ? (
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.status, status.bad && styles.statusBad]}
          >
            {status.text}
          </Text>
        ) : null}
      </ScrollView>
    </ModalCard>
  );
}

const styles = themedSheet(() => ({
  body: { paddingTop: space.medium, gap: space.small },
  eyebrow: { ...type.eyebrow, color: colors.textFaint },
  codeBox: {
    minWidth: 0,
    padding: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSunken,
  },
  code: {
    color: colors.textSoft,
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 17,
  },
  hint: { ...type.meta, color: colors.textFaint },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.small, marginTop: space.tight },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginTop: space.medium,
    marginBottom: space.tight,
  },
  // Sized to the picture rather than to the card. The frame is there to show
  // where the image ends — its own background is the app's, so without one a
  // dark card floats on a dark dialog — and a full-width frame around a
  // portrait board is mostly frame.
  preview: {
    alignSelf: 'center',
    maxWidth: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.snug,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSunken,
  },
  previewError: { ...type.meta, color: colors.dangerText, textAlign: 'center' },
  // Two columns on anything but the narrowest phone, which is what six
  // switches want: a single column of six is a scroll, and three columns puts
  // "Captured pieces" on two lines.
  switches: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space.tight },
  switch: { width: '50%', minWidth: 150 },
  status: { ...type.meta, color: colors.accentSoft, marginTop: space.tight },
  statusBad: { color: colors.dangerText },
}));
