import { useEffect, useState } from 'react';
import { Image, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as Clipboard from 'expo-clipboard';

import MiniBoard from '@/features/board/MiniBoard';
import { modeBackground, modeCover, modeLooks } from '@/features/board/modeArt';
import { pickImage } from '@/features/lab/pickImage';
import { gridFromRows } from '@/engine/analysisGame';
import { alphabetFor } from '@/engine/spec/interpret';
import { colors, radius, space, type } from '@/theme';
import { Banner, GhostButton, LabeledInput, OptionChips, PrimaryButton } from '@/ui/primitives';
import ModalCard from '@/ui/ModalCard';
import { useLabStore } from '@/store/labSession';

// Naming it, at the end.
//
// The old page asked for a slug in a panel that was on screen from the first
// second, before there was anything to name — which is backwards, and which is
// why a session used to end with a mode called "Untitled mode". A name is the
// last thing you know about a game, so it is asked for here, once, at the moment
// it becomes worth sharing.
//
// The name has to go *into the spec*, not just into the request: the server
// reads name, shortCode, description and objective out of the document it is
// handed, because that document is what a live game carries and what an archived
// one replays through. A title that lived only in the request would be a title
// that vanished the first time somebody forked it.

export interface ExportSheetProps {
  visible: boolean;
  onClose: () => void;
  onPublish: (input: { slug: string; visibility: 'public' | 'unlisted' }) => Promise<void>;
  onSaveDraft: (name: string) => Promise<void>;
  publishedModeId: string | null;
  publishedUrl: string | null;
  publishError: string | null;
  busy: boolean;
  /** Whether this browser may store a picture. See `LabController.canAddImage`. */
  canAddImage: boolean;
  /** Store a picture and answer with its reference. */
  onAddImage: (input: { role: 'cover'; data: string }) => Promise<string>;
}

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** 1–6 alphanumerics, which is what the validator will accept. */
const codeOf = (name: string) => {
  const letters = name.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return (letters.slice(0, 4) || 'MODE').slice(0, 6);
};

export default function ExportSheet({
  visible,
  onClose,
  onPublish,
  onSaveDraft,
  publishedModeId,
  publishedUrl,
  publishError,
  busy,
  canAddImage,
  onAddImage,
}: ExportSheetProps) {
  const draft = useLabStore((state) => state.draft);
  const report = useLabStore((state) => state.report);

  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [visibility, setVisibility] = useState<'public' | 'unlisted'>('public');
  const [copied, setCopied] = useState<string | null>(null);
  const [pickingCover, setPickingCover] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);
  const cover = modeCover({ spec: draft });

  // The human path and the agent path are the same path: this ends at
  // `patchDraft`, which is where `lab_patch_spec` ends too, so the agent sees
  // the choice in the draft it is already reading rather than being told.
  const chooseCover = async () => {
    setCoverError(null);
    const picked = await pickImage();
    if (!picked) return;
    setPickingCover(true);
    try {
      const artId = await onAddImage({ role: 'cover', data: picked.data });
      useLabStore.getState().patchDraft({ cover: artId });
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : 'That picture could not be added.');
    } finally {
      setPickingCover(false);
    }
  };

  // Re-read whatever the agent settled on each time the sheet opens, rather than
  // holding the name it had when the page loaded.
  useEffect(() => {
    if (!visible) return;
    setName(draft.name === 'Untitled mode' ? '' : draft.name);
    setDescription(draft.description);
    setCopied(null);
    // Only when it opens: typing here must not be overwritten by a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const finalName = name.trim() || 'Untitled mode';
  const slug = slugOf(finalName);
  const playable = report.errors.length === 0;
  const canPublish = playable && slug.length >= 2 && !busy;

  const commitName = () => {
    if (finalName === draft.name && description.trim() === draft.description) return;
    useLabStore.getState().patchDraft({
      name: finalName,
      shortCode: codeOf(finalName),
      description: description.trim() || draft.description,
    });
  };

  const publish = async () => {
    commitName();
    await onPublish({ slug, visibility });
  };

  const copy = async (label: string, value: string) => {
    await Clipboard.setStringAsync(value);
    setCopied(label);
  };

  const preview = gridFromRows(draft.startingPosition?.rows, alphabetFor(draft));

  return (
    <ModalCard
      eyebrow="EXPORT"
      onClose={onClose}
      title={publishedModeId ? 'It is in the library' : 'Name it, and share it'}
      subtitle={
        publishedModeId
          ? undefined
          : 'A published mode is permanent: an edit becomes a new version rather than changing what people are already playing.'
      }
      maxWidth={620}
      visible={visible}
      footer={
        publishedModeId ? (
          <GhostButton label="DONE" onPress={onClose} />
        ) : (
          <>
            <GhostButton
              label={busy ? 'SAVING…' : 'SAVE DRAFT'}
              onPress={() => {
                commitName();
                void onSaveDraft(finalName);
              }}
            />
            <PrimaryButton
              label={busy ? 'PUBLISHING…' : 'PUBLISH TO THE LIBRARY'}
              disabled={!canPublish}
              onPress={() => void publish()}
            />
          </>
        )
      }
    >
      {publishError ? <Banner message={publishError} tone="error" /> : null}

      {publishedModeId ? (
        <View style={styles.done}>
          <Banner
            message={`Published as ${publishedModeId}. Anyone can find and play it now.`}
            tone="notice"
          />
          {publishedUrl ? (
            <>
              <Text style={styles.url} selectable>
                {publishedUrl}
              </Text>
              <View style={styles.buttons}>
                <GhostButton
                  label={copied === 'link' ? 'COPIED' : 'COPY LINK'}
                  onPress={() => void copy('link', publishedUrl)}
                />
                <GhostButton
                  label={copied === 'json' ? 'COPIED' : 'COPY THE RULES'}
                  onPress={() => void copy('json', JSON.stringify(draft, null, 2))}
                />
              </View>
            </>
          ) : null}
        </View>
      ) : (
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          <View style={styles.summary}>
            <MiniBoard
              boardBackground={modeBackground({ spec: draft })}
              grid={preview}
              pieceLooks={modeLooks({ spec: draft })}
              size={124}
            />
            <View style={styles.summaryText}>
              <Text style={styles.shape}>
                {draft.board.width}×{draft.board.height} · {draft.pieces.length} piece
                {draft.pieces.length === 1 ? '' : 's'} · {draft.win.length} way
                {draft.win.length === 1 ? '' : 's'} to win
              </Text>
              <Text style={styles.objective}>{draft.objective}</Text>
              {!playable ? (
                <Text style={styles.blocked}>
                  {report.errors.length} problem{report.errors.length === 1 ? '' : 's'} to fix
                  before this can be published.
                </Text>
              ) : null}
            </View>
          </View>

          <LabeledInput
            label="NAME"
            accessibilityLabel="What this mode is called"
            onChangeText={setName}
            placeholder="Leapfrog"
            placeholderTextColor={colors.textFaint}
            value={name}
          />
          <Text style={styles.derived}>
            Its address will be <Text style={styles.mono}>custom:{slug || '…'}@1</Text>, and it will
            show as <Text style={styles.mono}>{codeOf(finalName)}</Text> on a board.
          </Text>

          <LabeledInput
            label="ONE LINE ABOUT IT"
            accessibilityLabel="A one-line description"
            onChangeText={setDescription}
            placeholder={draft.description}
            placeholderTextColor={colors.textFaint}
            value={description}
          />

          {Platform.OS === 'web' ? (
          <View style={styles.coverRow}>
            <Text style={styles.coverLabel}>COVER PICTURE</Text>
            <View style={styles.coverBody}>
              {cover ? (
                <Image
                  accessibilityIgnoresInvertColors
                  accessible={false}
                  resizeMode="cover"
                  source={{ uri: cover }}
                  style={styles.coverThumb}
                />
              ) : (
                <Text style={styles.coverEmpty}>
                  {canAddImage
                    ? 'None. The library card will show the opening board.'
                    : 'Sign in to add one. The card will show the opening board.'}
                </Text>
              )}
              <GhostButton
                disabled={!canAddImage || pickingCover}
                label={pickingCover ? 'ADDING…' : cover ? 'REPLACE…' : 'CHOOSE…'}
                onPress={() => void chooseCover()}
              />
            </View>
            {coverError ? <Text style={styles.coverError}>{coverError}</Text> : null}
          </View>
          ) : null}

          <OptionChips
            label="WHO CAN FIND IT"
            options={[
              { value: 'public' as const, label: 'ANYONE' },
              { value: 'unlisted' as const, label: 'ONLY WITH THE LINK' },
            ]}
            onChange={setVisibility}
            value={visibility}
          />

          <View style={styles.buttons}>
            <GhostButton
              label={copied === 'json' ? 'COPIED' : 'COPY THE RULES AS JSON'}
              onPress={() => void copy('json', JSON.stringify(draft, null, 2))}
            />
          </View>
        </ScrollView>
      )}
    </ModalCard>
  );
}

const styles = StyleSheet.create({
  coverRow: { gap: space.snug },
  coverLabel: { ...type.label, color: colors.textMuted },
  coverBody: { alignItems: 'center', flexDirection: 'row', gap: space.snug },
  coverThumb: { borderRadius: radius.medium, height: 54, width: 96 },
  coverEmpty: { ...type.meta, color: colors.textFaint, flex: 1, minWidth: 0 },
  coverError: { ...type.meta, color: colors.danger },
  body: { flexGrow: 0, maxHeight: 460 },
  bodyContent: { gap: space.medium },
  summary: { flexDirection: 'row', gap: space.medium, alignItems: 'center' },
  summaryText: { flex: 1, gap: space.tight, minWidth: 0 },
  shape: { ...type.bodyStrong, color: colors.text },
  objective: { ...type.meta, color: colors.textDim },
  blocked: { ...type.meta, color: colors.dangerSoft },
  derived: { ...type.meta, color: colors.textFaint, marginTop: -space.snug },
  mono: { fontFamily: 'monospace', color: colors.textMuted },
  done: { gap: space.small },
  url: {
    ...type.meta,
    backgroundColor: colors.surfaceWell,
    borderRadius: radius.small,
    color: colors.accentText,
    fontFamily: 'monospace',
    padding: space.small,
  },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.small },
});
