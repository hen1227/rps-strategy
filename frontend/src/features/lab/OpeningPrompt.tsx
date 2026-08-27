import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, type } from '@/theme';
import ChatComposer from './ChatComposer';
import { ToolsPill } from './ChatRail';

// The first thing you see.
//
// Not a modal. A modal implies something behind it worth dismissing to, and
// there is nothing behind this yet — the board it would sit over is a board of a
// game nobody has described. So it is the page's own empty state, centred, and
// when the first message goes it becomes the rail rather than closing.
//
// The examples are load-bearing. "Describe a game" is a blank page, and a blank
// page is where a demo stalls; three concrete openings that show different parts
// of the rule format are what turn it into a choice.

const EXAMPLES = [
  'A game on 7×7 where pieces leap over each other, and landing on someone takes them',
  'Add a Lizard that beats Paper and Scissors but loses to Rock',
  'Territory: you win by holding the middle three rows for three turns in a row',
];

export interface OpeningPromptProps {
  onSend: (text: string) => void;
  toolCount: number;
  toolDetail: string;
  /** Shown when neither this server nor the visitor has a key. */
  needsKey?: boolean;
  onConnectKey?: () => void;
}

export default function OpeningPrompt({
  onSend,
  toolCount,
  toolDetail,
  needsKey = false,
  onConnectKey,
}: OpeningPromptProps) {
  return (
    <ScrollView contentContainerStyle={styles.stage}>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>RPS LAB</Text>
        <Text style={styles.hero}>What should your game do?</Text>
        <Text style={styles.blurb}>
          Describe it in a sentence. The agent writes the rules, and the board plays them straight
          away — on a real board, with the real rules.
        </Text>

        <ChatComposer
          autoFocus
          onSend={onSend}
          placeholder="A game where pieces leap over each other…"
          size="stage"
          footer={
            needsKey ? (
              <Pressable accessibilityRole="button" onPress={onConnectKey} style={styles.keyPrompt}>
                <Text style={styles.keyPromptText}>Connect an OpenAI key to begin →</Text>
              </Pressable>
            ) : (
              <ToolsPill count={toolCount} detail={toolDetail} />
            )
          }
        />

        <View style={styles.examples}>
          {EXAMPLES.map((example) => (
            <Pressable
              accessibilityRole="button"
              key={example}
              onPress={() => onSend(example)}
              style={({ pressed }) => [styles.example, pressed && styles.pressed]}
            >
              <Text style={styles.exampleText}>{example}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.footnote}>
          This page publishes its tools on <Text style={styles.mono}>document.modelContext</Text>.
          This chat is one client; your browser’s agent is another.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  stage: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.large,
  },
  card: { gap: space.small, maxWidth: 620, width: '100%' },
  eyebrow: { ...type.eyebrow, color: colors.accentText },
  hero: { ...type.hero, color: colors.textStrong },
  blurb: { ...type.body, color: colors.textDim, marginBottom: space.small },
  examples: { gap: space.snug, marginTop: space.small },
  example: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.medium,
    borderWidth: 1,
    paddingHorizontal: space.small,
    paddingVertical: space.snug,
  },
  exampleText: { ...type.meta, color: colors.textMuted },
  pressed: { opacity: 0.7 },
  footnote: { ...type.eyebrow, color: colors.textFaint, letterSpacing: 0, marginTop: space.small },
  mono: { fontFamily: 'monospace', color: colors.textDim },
  keyPrompt: { minWidth: 0 },
  keyPromptText: { ...type.eyebrow, color: colors.accentText, letterSpacing: 0 },
});
