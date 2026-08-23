import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Markdown from '../components/Markdown';
import { Badge, Banner, GhostButton, Panel, PrimaryButton, SectionHeading } from '../components/ui';
import { botClientScriptUrl, botGuide, exampleEngineUrl } from '../store/engineBotApi';
import { colors, radius } from '../theme';

// The bot guide, for people who want to connect an engine.
//
// The prose comes from the server: it is the same `docs/bots.md` the
// repository carries, rendered rather than retyped. A page that quietly
// disagreed with the README would be worse than no page, because somebody
// would follow it.
//
// The download links, though, are built from this app's own API base rather
// than from the server's `downloadUrl`. The server cannot always know its
// public address — behind a socket it has none — and a relative path here
// resolves against whatever origin the site is served from, which in
// development is the Expo dev server and gives you the lobby back.

const TABS = [
  { key: 'guide', label: 'GETTING STARTED' },
  { key: 'protocol', label: 'PROTOCOL REFERENCE' },
];

export default function BotGuideScreen({ navigation }) {
  const [guide, setGuide] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('guide');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    botGuide()
      .then((next) => {
        if (!cancelled) setGuide(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const copyDigest = async () => {
    if (!guide?.sha256) return;
    try {
      await globalThis.navigator?.clipboard?.writeText(guide.sha256);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is not always granted; the digest is selectable anyway.
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.topBar}>
          <Pressable
            accessibilityLabel="Back to the lobby"
            accessibilityRole="button"
            onPress={() => navigation.navigate('Lobby')}
          >
            <Text style={styles.back}>‹ LOBBY</Text>
          </Pressable>
          {guide ? <Badge label={`CLIENT v${guide.version}`} tone="accent" /> : null}
        </View>

        <View style={styles.hero}>
          <Text style={styles.eyebrow}>PLAYERS' ENGINES</Text>
          <Text style={styles.title}>Connect your bot</Text>
          <Text style={styles.subtitle}>
            Write a program that reads and writes lines. Run one short script next to it.
            Your bot never touches a network, an account, or a clock.
          </Text>
        </View>

        {error ? <Banner message={error} tone="alert" /> : null}

        <Panel tone="accent">
          <SectionHeading
            eyebrow="DOWNLOAD"
            title={guide ? `rpsbot.py — version ${guide.version}` : 'rpsbot.py'}
          />
          <Text style={styles.help}>
            The client reports its version when it connects. If a newer one exists it tells
            you; if yours is too old to talk to the server it stops before starting your
            engine. Check the file against this digest before running it.
          </Text>
          {guide ? (
            <>
              <View style={styles.digestRow}>
                <Text selectable style={styles.digest}>
                  {guide.sha256}
                </Text>
                <GhostButton
                  compact
                  label={copied ? 'COPIED' : 'COPY'}
                  onPress={copyDigest}
                />
              </View>
              <View style={styles.commands}>
                <Text selectable style={styles.command}>
                  {`curl -O ${botClientScriptUrl}\nshasum -a 256 rpsbot.py\npip install websockets\npython3 rpsbot.py -- ./your-engine`}
                </Text>
              </View>
              <View style={styles.actions}>
                <PrimaryButton
                  label={`DOWNLOAD rpsbot.py v${guide.version}`}
                  onPress={() => Linking.openURL(botClientScriptUrl)}
                />
                <GhostButton
                  label="EXAMPLE BOT"
                  onPress={() => Linking.openURL(exampleEngineUrl)}
                />
                <GhostButton
                  label="GET A BOT TOKEN"
                  onPress={() => navigation.navigate('Account')}
                />
              </View>
              <Text style={styles.help}>
                Minimum version this server accepts: {guide.minimumVersion}
              </Text>
            </>
          ) : (
            <Text style={styles.help}>Loading…</Text>
          )}
        </Panel>

        <View style={styles.tabs}>
          {TABS.map((entry) => (
            <GhostButton
              key={entry.key}
              label={entry.key === tab ? `▸ ${entry.label}` : entry.label}
              onPress={() => setTab(entry.key)}
            />
          ))}
        </View>

        <Panel>
          {guide ? (
            <Markdown source={tab === 'guide' ? guide.guide : guide.protocol} />
          ) : (
            <Text style={styles.help}>Loading the guide…</Text>
          )}
        </Panel>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 12, maxWidth: 900, width: '100%', alignSelf: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { color: colors.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  hero: { gap: 4 },
  eyebrow: { color: colors.accentText, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  title: { color: colors.textStrong, fontSize: 26, fontWeight: '800' },
  subtitle: { color: colors.textFaint, fontSize: 13, lineHeight: 19 },
  help: { color: colors.textFaint, fontSize: 11, lineHeight: 17, marginTop: 8 },
  digestRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  digest: { flex: 1, color: colors.textSoft, fontFamily: 'monospace', fontSize: 10 },
  commands: {
    marginTop: 10,
    padding: 10,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceWell,
  },
  command: { color: colors.textSoft, fontFamily: 'monospace', fontSize: 11, lineHeight: 18 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
