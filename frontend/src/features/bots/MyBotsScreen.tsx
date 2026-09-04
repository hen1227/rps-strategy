import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import BotManagerPanel from './BotManagerPanel';
import { failureMessage } from '@/errors';
import { links } from '@/navigation/links';
import {
  botClientScriptUrl,
  botGuide,
  exampleEngineUrl,
  type BotGuide,
} from '@/store/api/bots';
import { useGameStore } from '@/store/gameStore';
import { colors, contentWidth, radius, space, type } from '@/theme';
import LinkRow from '@/ui/LinkRow';
import Markdown from '@/ui/Markdown';
import PageHeading from '@/ui/PageHeading';
import ScreenShell from '@/ui/ScreenShell';
import { docSections, findSection } from '@/ui/markdownSections';
import { Badge, Banner, GhostButton, Panel, PrimaryButton, SectionHeading } from '@/ui/primitives';

// The engines you own.
//
// This was the fourth tab of the Bots page, and under it sat both of the
// documents the server ships — some six hundred lines of Markdown, unrolled,
// below a registry with five rows in it. Whatever the guide is worth, that is
// not the shape of it: the page you open to make a token should be about tokens.
//
// So what is left here is your bots, the three commands that get one running,
// and the one table that says what an engine has to answer. The rest is two
// pages of their own, one link away — which is also why they are not behind a
// collapsible. A disclosure triangle that unfolds three hundred lines is the
// same page with a delay on it.

export default function MyBotsScreen() {
  const router = useRouter();
  const sessionToken = useGameStore((state) => state.sessionToken);
  const [guide, setGuide] = useState<BotGuide | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    botGuide()
      .then((next) => {
        if (!cancelled) setGuide(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(failureMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The commands table out of the guide, rather than a second copy of it here.
  // A renamed section costs this card and nothing else.
  const answers = findSection(docSections(guide?.guide, 3), /what your bot has to do/i);

  return (
    <ScreenShell width={contentWidth.standard}>
      <PageHeading
        back={{ href: links.account(), label: 'Account' }}
        detail="A bot is a program on your machine that plays through a small client. It gets its own name, its own rating, and its own place on the ladder."
        eyebrow="YOUR ENGINES"
        title="Your bots"
        trailing={
          guide ? <Badge label={`rpsbot.py v${guide.version}`} tone="accent" /> : undefined
        }
      />

      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}

      {sessionToken ? (
        <BotManagerPanel />
      ) : (
        // The registry needs an account to hang bots off. On the account page
        // that was self-evident because the sign-in form was next to it; here it
        // has to say so.
        <Panel>
          <SectionHeading eyebrow="YOUR BOTS" title="Sign in first" />
          <Text style={styles.help}>
            A bot belongs to an account, so a token cannot be minted for a browser that has not
            signed in. Everything you have played so far comes with it.
          </Text>
          <View style={styles.actions}>
            <PrimaryButton
              label="SIGN IN WITH DISCORD"
              onPress={() => router.push(links.account())}
            />
          </View>
        </Panel>
      )}

      <Panel tone="accent">
        <SectionHeading eyebrow="GET STARTED" title="Three commands" />
        <Text style={styles.help}>
          Your engine reads and writes lines; the client does the network, the account and
          the clock. Paste a bot&apos;s token when it asks.
        </Text>
        <Text selectable style={styles.commands}>
          {`curl -O ${botClientScriptUrl}\npip install websockets\npython3 rpsbot.py -- ./your-engine`}
        </Text>
        <View style={styles.actions}>
          <GhostButton
            label="DOWNLOAD rpsbot.py"
            onPress={() => Linking.openURL(botClientScriptUrl)}
          />
          <GhostButton
            label="EXAMPLE ENGINE"
            onPress={() => Linking.openURL(exampleEngineUrl)}
          />
          {guide ? (
            <Text selectable style={styles.digest}>
              sha256 {guide.sha256}
            </Text>
          ) : null}
        </View>
      </Panel>

      <Panel>
        <SectionHeading eyebrow="THE SHORT VERSION" title="What an engine answers" />
        {answers ? (
          <View style={styles.answers}>
            <Markdown source={answers.body} />
          </View>
        ) : (
          <Text style={styles.help}>
            {error ? 'The handout could not be loaded.' : 'Loading…'}
          </Text>
        )}
        <View style={styles.reading}>
          <LinkRow
            detail="The walkthrough: a working bot in twenty lines, then how to connect it."
            href={links.botGuide()}
            title="Connect your bot"
          />
          <LinkRow
            detail="RPSI in full — every command, every reply, and the three easy mistakes."
            href={links.botProtocol()}
            title="The engine protocol"
          />
          <LinkRow
            detail="How a stored game is written down: the PGN record, and the FEN inside it."
            href={links.botNotation()}
            title="Records and notation"
          />
        </View>
      </Panel>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  help: { ...type.body, color: colors.textMuted, marginTop: space.small },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.small,
    marginTop: space.medium,
  },
  commands: {
    marginTop: space.medium,
    padding: space.small,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceWell,
    color: colors.textSoft,
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 18,
  },
  // `flexShrink` cannot do this on its own: a flex item will not shrink below
  // its longest unbreakable word, and the digest is one 64-character word, so
  // it ran off the side of a phone. With a floor of zero it wraps instead.
  digest: {
    ...type.meta,
    color: colors.textFaint,
    fontFamily: 'monospace',
    flexShrink: 1,
    minWidth: 0,
  },
  answers: { marginTop: space.medium },
  reading: { marginTop: space.medium },
});
