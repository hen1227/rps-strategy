import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Panel, SectionHeading } from '../components/ui';
import { colors, radius } from '../theme';

export const LAST_UPDATED = 'August 21, 2026';
export const CONTACT_DISCORD = '@henhen1227';

// The policy text lives here as data rather than JSX so the screen body stays a
// single map and editing the wording never means touching layout. Mirrors
// PRIVACY.md at the repository root — change both together.
const sections = [
  {
    eyebrow: 'THE SHORT VERSION',
    title: 'Every game is recorded',
    tone: 'accent',
    paragraphs: [
      'RPS Strategy is a small game run by one person on his own hardware. Every online game you play is recorded and kept, tied to your account. Play nice, play your own games, and do not cheat.',
    ],
  },
  {
    eyebrow: 'KEPT INDEFINITELY',
    title: 'What I store',
    paragraphs: [
      'Your account: a random account ID your browser generates, your display name, your Discord handle, and a SHA-256 hash of your local account key — never the key itself.',
      'Every finished online game, kept indefinitely and linked to both players: who played, the game mode, who won, how it ended, whether it was ranked, both ratings before and after, the number of moves, the time control, and when it started and finished.',
      'Your totals: wins, losses, draws, games played, and a separate Elo rating per game mode.',
      'Tournaments: your entry name, Discord handle, your matches, and their results.',
    ],
  },
  {
    eyebrow: 'PUBLIC BY DEFAULT',
    title: 'What other players see',
    paragraphs: [
      'Your display name, Discord handle, rating, and record are shown to your opponent and in the lobby live-game list. Any player can spectate a live game, including yours.',
      'In-game chat is not filtered or moderated. Your opponent and every spectator can read it. Chat lives in server memory for the length of the game and is never written to the database — but assume anyone in the room can screenshot it.',
    ],
  },
  {
    eyebrow: 'NOT COLLECTED',
    title: 'What I do not do',
    paragraphs: [
      'No ads, no analytics SDKs, no trackers, and none of this is sold or shared. I am the only person with access to the database. Ordinary web-server logs record IP addresses so the server can be run and debugged; they are not part of your game record.',
    ],
  },
  {
    eyebrow: 'YOUR CALL',
    title: 'Deleting your data',
    paragraphs: [
      `Message me on Discord (${CONTACT_DISCORD}) and I will delete your account and profile. Finished games involve another player, so I may keep the bare result with your name removed — otherwise your opponents' histories and ratings would break.`,
      "Clearing this site's browser data also throws away your local account key, which means a new account and no way back to the old one.",
    ],
  },
  {
    eyebrow: 'ONLINE PLAY AGREEMENT',
    title: 'By playing online, you agree to',
    bullets: [
      'Be nice. No harassment, slurs, threats, or bigotry — in chat, display names, or Discord handles.',
      'Play your own games. No engines, bots, or outside help during a live game. The analysis board is for before and after, not during.',
      'Do not rig results. No throwing games to farm ratings, no sandbagging, no alt accounts to dodge opponents or inflate your Elo.',
      'Do not stall. No sitting on the clock to burn your opponent out, and no disappearing mid-game to avoid a loss.',
      'Do not attack the server. No exploiting bugs for advantage, scraping, or flooding. Find a bug and I would rather hear it from you.',
      'Accept the consequences. I may void a game, reset a rating, or remove an account over any of the above. No formal appeals — just message me and we will sort it out like people.',
    ],
  },
  {
    eyebrow: 'CHANGES',
    title: 'When this page changes',
    paragraphs: [
      'I will edit this page when something changes and bump the date. If you keep playing, that is your agreement to the current version.',
      `Questions, deletion requests, or bug reports: Discord ${CONTACT_DISCORD}.`,
    ],
  },
];

export default function PolicyScreen({ navigation }) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.screen}>
          <View style={styles.topBar}>
            <Pressable
              accessibilityLabel="Back to game modes"
              accessibilityRole="button"
              onPress={() => navigation.goBack()}
              style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
            >
              <Text style={styles.backText}>‹ LOBBY</Text>
            </Pressable>
          </View>

          <View style={styles.hero}>
            <Text style={styles.eyebrow}>THE HOUSE RULES</Text>
            <Text style={styles.title}>Privacy & play</Text>
            <Text style={styles.subtitle}>Last updated {LAST_UPDATED}</Text>
          </View>

          <View style={styles.stack}>
            {sections.map((section) => (
              <Panel key={section.title} tone={section.tone ?? 'default'}>
                <SectionHeading eyebrow={section.eyebrow} title={section.title} />
                {section.paragraphs?.map((paragraph) => (
                  <Text key={paragraph} style={styles.body}>
                    {paragraph}
                  </Text>
                ))}
                {section.bullets && (
                  <View style={styles.bulletList}>
                    {section.bullets.map((bullet) => (
                      <View key={bullet} style={styles.bulletRow}>
                        <Text style={styles.bulletMark}>◆</Text>
                        <Text style={styles.bulletText}>{bullet}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </Panel>
            ))}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  scrollContent: { flexGrow: 1 },
  screen: {
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 96,
  },
  topBar: { flexDirection: 'row', alignItems: 'center' },
  backButton: { paddingVertical: 8, paddingRight: 12 },
  backText: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 0.9 },

  hero: { paddingTop: 24, paddingBottom: 22 },
  eyebrow: { color: colors.accent, fontSize: 10, fontWeight: '900', letterSpacing: 2.1 },
  title: {
    color: colors.textStrong,
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -1,
    marginTop: 5,
  },
  subtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 20, marginTop: 6 },

  stack: { gap: 12 },
  body: { color: colors.textMuted, fontSize: 12, lineHeight: 19, marginTop: 10 },

  bulletList: { gap: 9, marginTop: 13 },
  bulletRow: {
    flexDirection: 'row',
    gap: 9,
    paddingVertical: 9,
    paddingHorizontal: 11,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceMuted,
  },
  bulletMark: { color: colors.accentBright, fontSize: 9, lineHeight: 19 },
  bulletText: { flex: 1, color: colors.text, fontSize: 12, lineHeight: 19 },

  pressed: { opacity: 0.7 },
});
