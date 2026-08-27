import { useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, type } from '@/theme';
import { Checkbox, GhostButton, LabeledInput, PrimaryButton } from '@/ui/primitives';
import ModalCard from '@/ui/ModalCard';
import { DEFAULT_MODEL } from './agent/transport';

// Bringing your own key.
//
// Only ever shown when this server has none of its own, which is the ordinary
// state of a checkout. The key is sent to `api.openai.com` and to nothing else —
// in particular never to the server hosting this page, which is the whole reason
// this is offered instead of simply asking the operator to configure one.
//
// Remembering it is opt-in and off by default. Anything kept in a browser's
// storage is readable by any script that gets to run on this origin, and a
// session-only key is one page reload away from being gone.

export interface KeySheetProps {
  visible: boolean;
  onClose: () => void;
  onSave: (key: string, model: string, remember: boolean) => void;
  onForget?: () => void;
  hasKey: boolean;
}

export default function KeySheet({ visible, onClose, onSave, onForget, hasKey }: KeySheetProps) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [remember, setRemember] = useState(false);

  const save = () => {
    if (!key.trim()) return;
    onSave(key.trim(), model.trim() || DEFAULT_MODEL, remember);
    setKey('');
    onClose();
  };

  return (
    <ModalCard
      eyebrow="OPENAI"
      onClose={onClose}
      title="Use your own key"
      subtitle="This server has no OpenAI key of its own, so the agent runs on yours."
      maxWidth={520}
      visible={visible}
      footer={
        <>
          {hasKey && onForget ? (
            <GhostButton
              label="FORGET IT"
              onPress={() => {
                onForget();
                onClose();
              }}
            />
          ) : null}
          <PrimaryButton label="USE THIS KEY" disabled={key.trim() === ''} onPress={save} />
        </>
      }
    >
      <LabeledInput
        accessibilityLabel="Your OpenAI API key"
        autoCapitalize="none"
        autoCorrect={false}
        label="API KEY"
        onChangeText={setKey}
        placeholder="sk-…"
        placeholderTextColor={colors.textFaint}
        secureTextEntry
        value={key}
      />
      <LabeledInput
        accessibilityLabel="Which model to use"
        autoCapitalize="none"
        autoCorrect={false}
        hint="Any model that supports tool calling."
        label="MODEL"
        onChangeText={setModel}
        value={model}
      />

      <View style={styles.note}>
        <Text style={styles.noteText}>
          The key goes straight from this browser to <Text style={styles.mono}>api.openai.com</Text>
          . It is never sent to the server hosting this page.
        </Text>
      </View>

      <Checkbox
        checked={remember}
        label="Remember it on this device"
        onToggle={() => setRemember((was) => !was)}
      />
      <Text style={styles.warn}>
        Off by default: anything kept in browser storage can be read by any script that runs here.
        Left off, the key lasts until you reload.
      </Text>

      <GhostButton
        label="GET A KEY →"
        onPress={() => void Linking.openURL('https://platform.openai.com/api-keys')}
      />
    </ModalCard>
  );
}

const styles = StyleSheet.create({
  note: {
    backgroundColor: colors.surfaceWell,
    borderRadius: radius.small,
    padding: space.small,
  },
  noteText: { ...type.meta, color: colors.textMuted },
  mono: { fontFamily: 'monospace', color: colors.textSoft },
  warn: { ...type.meta, color: colors.textFaint },
});
