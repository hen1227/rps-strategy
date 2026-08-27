import { ScrollView, StyleSheet, View } from 'react-native';

import GameSetupEditor from './GameSetupEditor';
import SetupPreview from '@/features/game/SetupPreview';
import { useWideScreen } from '@/hooks/useBoardLayout';
import { space } from '@/theme';
import ModalCard from '@/ui/ModalCard';
import { GhostButton, PrimaryButton } from '@/ui/primitives';
import type { GameSetup, ModeDefinition, TimeControl } from '@/types/game';

export interface GameSettingsModalProps {
  defaultTimeControl?: TimeControl | null;
  disabled?: boolean;
  mode: ModeDefinition | null | undefined;
  modes: ModeDefinition[];
  onChange: (setup: GameSetup) => void;
  onClose: () => void;
  onEditPosition: () => void;
  onReset: () => void;
  onResetPosition: () => void;
  positionIsCustom: boolean;
  /** Passed through to the stakes chip. See GameSetupEditor. */
  rankedLocked?: boolean;
  setup: GameSetup;
  visible: boolean;
}

/** All of the uncommon game knobs, kept out of the challenge's primary path. */
export default function GameSettingsModal({
  defaultTimeControl,
  disabled,
  mode,
  modes,
  onChange,
  onClose,
  onEditPosition,
  onReset,
  onResetPosition,
  positionIsCustom,
  rankedLocked,
  setup,
  visible,
}: GameSettingsModalProps) {
  const wide = useWideScreen();
  const editor = (
    <GameSetupEditor
      defaultTimeControl={defaultTimeControl}
      disabled={disabled}
      modes={modes}
      onChange={onChange}
      onEditPosition={onEditPosition}
      onResetPosition={onResetPosition}
      positionIsCustom={positionIsCustom}
      rankedLocked={rankedLocked}
      setup={setup}
    />
  );
  return (
    <ModalCard
      closeLabel="Close game settings"
      eyebrow="CUSTOM GAME"
      footer={
        <>
          <GhostButton
            accessibilityLabel="Reset all game settings"
            disabled={disabled}
            label="RESET"
            onPress={onReset}
          />
          <PrimaryButton label="DONE" onPress={onClose} />
        </>
      }
      // Wide enough that the preview gets a full column without squeezing the
      // clock and stakes chips onto separate rows, which would make the panel
      // taller for the sake of making the thing beside it smaller.
      maxWidth={820}
      onClose={onClose}
      subtitle="Adjust only what you want to change. Everything starts at the standard rated game."
      title="Game settings"
      visible={visible}
    >
      {/*
        The editor is the same on both, and only ever appears once — but where
        the preview goes is not a variation on one layout, it is two.
      */}
      {wide ? (
        <ScrollView
          contentContainerStyle={[styles.content, styles.contentWide]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={styles.scroll}
        >
          {/*
            Two columns of equal height, not a panel with a thumbnail pinned
            beside it. The knobs and the game they add up to are the two halves
            of this dialog, and the preview reading as the smaller one made the
            answer look like a footnote to the question.
          */}
          <View style={[styles.editor, styles.editorWide]}>{editor}</View>
          <SetupPreview
            caption="What the other player sees before deciding to take it."
            defaultTimeControl={defaultTimeControl}
            mode={mode}
            setup={setup}
            size="feature"
          />
        </ScrollView>
      ) : (
        <>
          {/*
            Above the scroller rather than inside it. A phone's dialog is
            shorter than these knobs are tall, so a preview that scrolls is a
            preview you never see while turning the knob it describes — it was
            stranded past the last checkbox, half of it behind the footer. Held
            here it answers every change on the spot, which is the whole reason
            it exists.
          */}
          <View style={styles.banner}>
            <SetupPreview
              defaultTimeControl={defaultTimeControl}
              mode={mode}
              setup={setup}
              size="banner"
            />
          </View>
          {/*
            The one scrollbar in this dialog worth drawing: the knobs are cut
            off mid-row by the footer on a short phone, and nothing else on the
            card says that the cut is a scroll rather than the end.
          */}
          <ScrollView
            contentContainerStyle={styles.contentNarrow}
            keyboardShouldPersistTaps="handled"
            style={styles.scroll}
          >
            {editor}
          </ScrollView>
        </>
      )}
    </ModalCard>
  );
}

const styles = StyleSheet.create({
  scroll: { flexShrink: 1 },
  content: { gap: space.large, paddingTop: space.small, paddingBottom: space.hair },
  contentWide: { flexDirection: 'row', alignItems: 'stretch' },
  contentNarrow: { paddingBottom: space.hair },
  editor: { alignSelf: 'stretch', minWidth: 280 },
  editorWide: { flex: 1 },
  banner: { marginTop: space.medium },
});
