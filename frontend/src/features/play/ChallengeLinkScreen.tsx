import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View, type LayoutChangeEvent } from 'react-native';

import { AwaitedLinkActions, OwnLinkActions } from './ChallengeLinkActions';
import SetupPreview, { SETUP_CARD_WIDTH } from '@/features/game/SetupPreview';
import { useWideScreen } from '@/hooks/useBoardLayout';
import { useNow } from '@/hooks/useNow';
import { links } from '@/navigation/links';
import { useGoTo } from '@/navigation/stack';
import { useHere } from '@/navigation/useHere';
import { isSignedIn } from '@/store/accountSession';
import {
  asSentence,
  challengeLinkRole,
  linkStatusLine,
  linkTitle,
} from '@/store/challengeLinkSelectors';
import { useGameStore } from '@/store/gameStore';
import { isGameLive } from '@/store/spectateSelectors';
import { colors, contentWidth, space, themedSheet, type } from '@/theme';
import ScreenShell from '@/ui/ScreenShell';
import { Badge, GhostLink, Panel, PrimaryButton, SectionHeading } from '@/ui/primitives';
import type { ChallengeLink } from '@/types/protocol';

// Where a challenge link lands.
//
// Opening it is the whole of accepting it: the server takes the link for
// whoever follows it first, and either opens the game on the spot — the author
// is here — or keeps them waiting in the lobby until the author is. Everybody
// who opens it after that is somebody it was sent to, and is shown the game.
//
// So this page is mostly a waiting room. Its author sees their own link with
// the ways to send it; whoever took it sees whom they are waiting for and
// whether that person was told; anybody else sees who is playing, and is taken
// to watch the moment it starts.

/** The narrowest the words column reads, as on the challenge form. */
const COPY_FLOOR = 280;
const TWO_COLUMNS = COPY_FLOOR + space.large + SETUP_CARD_WIDTH;

export default function ChallengeLinkScreen({ code, settled }: { code: string; settled: boolean }) {
  const go = useGoTo();
  const router = useRouter();
  const here = useHere();
  const pathname = usePathname();
  const connected = useGameStore((state) => state.connectionStatus === 'connected');
  const viewed = useGameStore((state) => state.viewedLink);
  const accountId = useGameStore((state) => state.accountId);
  const sessionToken = useGameStore((state) => state.sessionToken);
  const account = useGameStore((state) => state.account);
  const liveGames = useGameStore((state) => state.liveGames);
  const ownGameId = useGameStore((state) =>
    !state.isSpectating && state.gameState?.status === 'InProgress' ? state.gameState.gameId : null,
  );
  const openChallengeLink = useGameStore((state) => state.openChallengeLink);
  const watchChallengeLink = useGameStore((state) => state.watchChallengeLink);
  const forgetViewedLink = useGameStore((state) => state.forgetViewedLink);
  const mode = useGameStore(
    (state) =>
      state.modes.find((candidate) => candidate.id === state.viewedLink?.link?.setup?.modeId) ??
      null,
  );
  const defaultTimeControl = useGameStore((state) => state.defaultTimeControl);
  const now = useNow(30_000);
  const wide = useWideScreen();
  const [width, setWidth] = useState(0);
  const measure = (event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.width);
    setWidth((current) => (current === measured ? current : measured));
  };
  const twoColumns = wide && width >= TWO_COLUMNS;

  // Followed once per visit, and only re-watched after that. A reconnection
  // costs the old socket its place among the people told about this link, so
  // it asks again — but a reconnection is not a press, so it never asks to
  // take it. A reload follows it afresh; the server remembers who left it and
  // only shows it to them, and PLAY is what takes it back.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!code || !connected || pathname !== '/challenge') return;
    if (opened.current === code) {
      watchChallengeLink(code);
      return;
    }
    opened.current = code;
    openChallengeLink(code);
  }, [code, connected, openChallengeLink, pathname, watchChallengeLink]);
  useEffect(() => () => forgetViewedLink(), [forgetViewedLink]);

  const link = viewed?.code === code ? viewed.link : null;
  const role = link ? challengeLinkRole(link, accountId) : 'viewer';

  // A link that has become a game is a way in to watch it. Its two players are
  // taken to their board by the rule in `SessionBridge`, which already holds
  // anybody with a live game of their own; once it is over, they get its record.
  useEffect(() => {
    if (pathname !== '/challenge' || link?.state !== 'started' || !link.gameId) return;
    if (role === 'viewer') {
      go(links.watch(link.gameId));
      return;
    }
    if (ownGameId !== link.gameId && !isGameLive(liveGames, link.gameId)) {
      go(links.review(link.gameId));
    }
  }, [go, link, liveGames, ownGameId, pathname, role]);

  return (
    <ScreenShell width={contentWidth.standard}>
      <SectionHeading title="Challenge" />
      <Panel>
        <View
          // Keyed by shape, for the reason the challenge form keys its own: iOS
          // keeps the stacked column's width as a starting basis when the row
          // arrives, and the preview runs off the side.
          key={twoColumns ? 'columns' : 'stacked'}
          onLayout={measure}
          style={[styles.body, twoColumns && styles.bodyWide]}
        >
          {link?.setup ? (
            <SetupPreview
              // Only the author's own view: a signed-out author's link is casual
              // because they are, which is not a change worth counting. Anybody
              // else is shown the stakes the game is actually played at.
              casualOnly={role === 'author' && !isSignedIn(sessionToken ?? null, account)}
              defaultTimeControl={defaultTimeControl}
              mode={mode}
              setup={link.setup}
              size="feature"
              stretch={!twoColumns}
            />
          ) : null}
          <View style={[styles.copy, twoColumns && styles.copyWide]}>
            <LinkState
              link={link}
              message={viewed?.code === code ? viewed.message : null}
              asking={viewed?.code === code ? viewed.asking : false}
              now={now}
              onRetry={() => openChallengeLink(code, true)}
              onSignIn={() => router.push(links.signIn(here))}
              role={role}
              signedIn={isSignedIn(sessionToken ?? null, account)}
              waitingForAnswer={!code || !connected || viewed?.code !== code || !link}
              missingCode={settled && !code}
            />
          </View>
        </View>
      </Panel>
    </ScreenShell>
  );
}

interface LinkStateProps {
  link: ChallengeLink | null;
  role: ReturnType<typeof challengeLinkRole>;
  message: string | null;
  asking: boolean;
  now: number | null;
  signedIn: boolean;
  waitingForAnswer: boolean;
  missingCode: boolean;
  onRetry: () => void;
  onSignIn: () => void;
}

/** The words and the buttons, for whichever of its states the link is in. */
function LinkState({
  link,
  role,
  message,
  asking,
  now,
  signedIn,
  waitingForAnswer,
  missingCode,
  onRetry,
  onSignIn,
}: LinkStateProps) {
  if (missingCode || link?.state === 'closed') {
    return (
      <>
        <Text style={styles.title}>{missingCode ? 'No challenge here' : 'This link has ended'}</Text>
        <Text style={styles.detail}>
          {missingCode
            ? 'This address is missing its code.'
            : asSentence(message ?? '') || 'It expired, or was cancelled.'}
        </Text>
        <View style={styles.actions}>
          <GhostLink href={links.lobby()} label="TO THE LOBBY" />
        </View>
      </>
    );
  }
  if (waitingForAnswer || !link) {
    return (
      <View style={styles.pending}>
        <ActivityIndicator color={colors.textMuted} size="small" />
        <Text style={styles.detail}>Opening the challenge…</Text>
      </View>
    );
  }

  const status = now ? linkStatusLine(link, role, now) : '';
  const head = (
    <View style={styles.head}>
      <Text numberOfLines={2} style={styles.title}>
        {linkTitle(link, role)}
      </Text>
      {link.state === 'waiting' ? <Badge label="WAITING" tone="live" /> : null}
    </View>
  );

  if (role === 'author') {
    return (
      <>
        {head}
        <Text style={styles.detail}>
          {link.state === 'waiting' ? 'Your game starts in a moment.' : status}
        </Text>
        <OwnLinkActions link={link} />
      </>
    );
  }
  if (role === 'taker') {
    const author = link.challenger?.username || 'them';
    return (
      <>
        {head}
        <Text style={styles.detail}>{status}</Text>
        <Text style={styles.note}>
          {`The game starts when ${author} is back. Wait here or anywhere in the lobby.`}
        </Text>
        <AwaitedLinkActions link={link} />
      </>
    );
  }

  // Somebody else's link: taken already, about to be taken by this visit, or
  // refused to this account — and then the reason, and the way past it.
  if (link.state === 'waiting' || link.state === 'started') {
    const taker = link.taker?.username || 'Someone';
    const author = link.challenger?.username || 'them';
    return (
      <>
        {head}
        <Text style={styles.detail}>
          {link.state === 'started'
            ? 'Opening the game…'
            : `${taker} took it. You can watch once ${author} is back.`}
        </Text>
      </>
    );
  }
  if (asking) {
    return (
      <>
        {head}
        <View style={styles.pending}>
          <ActivityIndicator color={colors.textMuted} size="small" />
          <Text style={styles.detail}>Joining…</Text>
        </View>
      </>
    );
  }
  // Refused, and a rated game that this account is not signed in to play: the
  // way past it is signing in, which brings them back here to take it.
  const needsAccount = !signedIn && link.setup && !link.setup.casual;
  return (
    <>
      {head}
      <Text style={styles.detail}>{status}</Text>
      {message ? <Text style={styles.refusal}>{asSentence(message)}</Text> : null}
      <View style={styles.actions}>
        {needsAccount ? (
          <PrimaryButton
            accessibilityLabel="Sign in to play this rated game"
            label="SIGN IN TO PLAY"
            onPress={onSignIn}
          />
        ) : (
          <PrimaryButton
            accessibilityLabel={`Play ${link.challenger?.username || 'this challenge'}`}
            label="PLAY ▶"
            onPress={onRetry}
          />
        )}
      </View>
    </>
  );
}

const styles = themedSheet(() => ({
  body: { gap: space.large },
  bodyWide: { flexDirection: 'row', alignItems: 'stretch' },
  copy: { flex: 1, gap: space.medium, justifyContent: 'center' },
  copyWide: { minWidth: COPY_FLOOR },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.small, flexWrap: 'wrap' },
  title: { ...type.sectionTitle, color: colors.textStrong, flexShrink: 1 },
  detail: { ...type.bodyStrong, color: colors.textSoft },
  note: { ...type.body, color: colors.textMuted },
  refusal: { ...type.body, color: colors.textMuted },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.small },
  pending: { flexDirection: 'row', alignItems: 'center', gap: space.small, minHeight: 42 },
}));
