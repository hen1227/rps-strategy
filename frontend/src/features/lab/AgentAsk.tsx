import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import MiniBoard from '@/features/board/MiniBoard';
import { gridFromRows } from '@/engine/analysisGame';
import { alphabetFor } from '@/engine/spec/interpret';
import { modeBackground, modeLooks } from '@/features/board/modeArt';
import { colors, radius, space, type } from '@/theme';
import { GhostButton, PrimaryButton } from '@/ui/primitives';
import type { LabAnswer, LabProposal, LabPrompt } from '@/store/labSession';

// The agent, asking.
//
// Both of these are the same shape as the publish confirmation that was here
// before, and for the same reason: the tool call is still in flight while this
// is on screen, so the buttons are not a form being submitted — they are the
// return value of a function the agent is inside.
//
// They live *in the rail*, not in a modal over the board. A modal would be the
// right shape for "are you sure", which is a stop; these are a turn in the
// conversation, and the conversation is the rail. It also means the board stays
// visible, which matters most for the proposal — the whole point of offering a
// change rather than making it is that somebody can look at it first.

/* ---------------------------------------------------------------- question -- */

export interface AgentAskProps {
  prompt: LabPrompt;
  onAnswer: (answer: LabAnswer | null) => void;
}

export function AgentAsk({ prompt, onAnswer }: AgentAskProps) {
  const [text, setText] = useState('');
  useEffect(() => setText(''), [prompt]);

  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>THE AGENT IS ASKING</Text>
      <Text style={styles.question}>{prompt.question}</Text>

      <View style={styles.options}>
        {prompt.options.map((option) => (
          <Pressable
            accessibilityRole="button"
            key={option.id}
            onPress={() => onAnswer({ id: option.id, ...(text.trim() ? { text: text.trim() } : {}) })}
            style={({ pressed }) => [styles.option, pressed && styles.pressed]}
          >
            <Text style={styles.optionText}>{option.label}</Text>
          </Pressable>
        ))}
      </View>

      {prompt.allowText ? (
        <View style={styles.textRow}>
          <TextInput
            accessibilityLabel="Answer in your own words"
            onChangeText={setText}
            onSubmitEditing={() => text.trim() && onAnswer({ text: text.trim() })}
            placeholder="Or say something else…"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            value={text}
          />
          <GhostButton
            disabled={!text.trim()}
            label="SEND"
            onPress={() => onAnswer({ text: text.trim() })}
          />
        </View>
      ) : null}

      {/* Ignoring it is a real answer, and one the agent is told how to read.
          Without this the only way past a question is to answer it, which is
          not a thing a page should be able to insist on. */}
      <Pressable accessibilityRole="button" onPress={() => onAnswer(null)}>
        <Text style={styles.skip}>Skip this — you decide</Text>
      </Pressable>
    </View>
  );
}

/* ---------------------------------------------------------------- proposal -- */

export interface AgentProposalProps {
  proposal: LabProposal;
  onAnswer: (applied: boolean, text?: string) => void;
  size?: number;
}

export function AgentProposal({ proposal, onAnswer, size = 132 }: AgentProposalProps) {
  const grid = gridFromRows(
    proposal.spec.startingPosition?.rows,
    alphabetFor(proposal.spec),
  );

  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>THE AGENT SUGGESTS</Text>
      <Text style={styles.question}>{proposal.note}</Text>

      <View style={styles.previewRow}>
        {/* The board it would leave, at a size worth looking at. A list of
            changes says what would happen; this says what it would look like,
            which is the question somebody is actually deciding. */}
        <MiniBoard
          boardBackground={modeBackground({ spec: proposal.spec })}
          grid={grid}
          pieceLooks={modeLooks({ spec: proposal.spec })}
          size={size}
        />
        <View style={styles.changes}>
          {proposal.changes.length === 0 ? (
            <Text style={styles.change}>Nothing about the rules changes.</Text>
          ) : (
            proposal.changes.map((change) => (
              <Text
                key={change.label}
                style={[
                  styles.change,
                  change.kind === 'add' && styles.changeAdd,
                  change.kind === 'remove' && styles.changeRemove,
                ]}
              >
                {change.label}
              </Text>
            ))
          )}
        </View>
      </View>

      <View style={styles.actions}>
        <GhostButton label="NO THANKS" onPress={() => onAnswer(false)} />
        <PrimaryButton label="APPLY IT" onPress={() => onAnswer(true)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceSunken,
    borderColor: colors.accent,
    borderRadius: radius.medium,
    borderWidth: 1,
    gap: space.snug,
    padding: space.small,
  },
  eyebrow: { ...type.eyebrow, color: colors.accentText },
  question: { ...type.body, color: colors.text },

  options: { flexDirection: 'row', flexWrap: 'wrap', gap: space.snug },
  option: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderRadius: radius.small,
    borderWidth: 1,
    paddingHorizontal: space.small,
    paddingVertical: space.snug,
  },
  optionText: { ...type.label, color: colors.textSoft },
  pressed: { opacity: 0.7 },

  textRow: { alignItems: 'center', flexDirection: 'row', gap: space.snug },
  input: {
    ...type.meta,
    backgroundColor: colors.surfaceWell,
    borderRadius: radius.small,
    color: colors.text,
    flex: 1,
    minWidth: 0,
    paddingHorizontal: space.snug,
    paddingVertical: space.tight,
    ...Platform.select({ web: { outlineStyle: 'none' as never } }),
  },
  skip: { ...type.eyebrow, color: colors.textFaint, letterSpacing: 0 },

  previewRow: { alignItems: 'flex-start', flexDirection: 'row', gap: space.small },
  changes: { flex: 1, gap: 2, minWidth: 0 },
  change: { ...type.meta, color: colors.textDim },
  changeAdd: { color: colors.accentText },
  changeRemove: { color: colors.dangerSoft },

  actions: { flexDirection: 'row', gap: space.snug, justifyContent: 'flex-end' },
});
