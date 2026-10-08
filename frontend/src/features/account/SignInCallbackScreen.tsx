import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import SignInButtons from './SignInButtons';
import { failureMessage } from '@/errors';
import { links } from '@/navigation/links';
import { useSettledSearchParams } from '@/navigation/useSettledSearchParams';
import { signInRefusalMessage } from '@/store/signInReturn';
import { useGameStore } from '@/store/gameStore';
import { colors, contentWidth, themedSheet } from '@/theme';
import ScreenShell from '@/ui/ScreenShell';
import { Banner, Panel, SectionHeading } from '@/ui/primitives';

// Where a sign-in through the browser lands on the web: Discord's, and Apple's
// on the website. Both come back with a ticket, and the ticket is redeemed the
// same way whichever provider issued it.
//
// Split into two components rather than branching inside one, and the split is
// the whole point. This page is pre-rendered in Node at build time with no
// query string at all, so the first render in a browser has to produce exactly
// what the build produced — anything derived from `?ticket=` would be a
// hydration mismatch, and the pre-rendered page would be thrown away.
//
// So the outer component calls exactly one hook, always, and shows a neutral
// card until the address bar has settled. The inner one mounts a render later
// and is where the work happens.

export default function SignInCallbackScreen() {
  const { params, settled } = useSettledSearchParams<{ ticket?: string; error?: string }>();

  if (!settled) return <CallbackCard title="Signing you in…" />;
  return <TicketExchange error={params.error ?? null} ticket={params.ticket ?? null} />;
}

function TicketExchange({ error, ticket }: { error: string | null; ticket: string | null }) {
  const router = useRouter();
  const redeemSignInTicket = useGameStore((state) => state.redeemSignInTicket);
  const [failure, setFailure] = useState<string | null>(
    error ? signInRefusalMessage(error) : null,
  );
  // A ticket is spent the first time it is redeemed. Without this latch the
  // development double-invoke would fire a second exchange, fail, and paint an
  // error over a sign-in that had already worked.
  const started = useRef(false);

  useEffect(() => {
    if (!ticket || error || started.current) return;
    started.current = true;
    redeemSignInTicket(ticket)
      .then((outcome) => {
        if (outcome.kind === 'failed') {
          setFailure(outcome.message);
          return;
        }
        // Either signed in, or signed in and still needing a name — the account
        // page shows whichever, and `replace` drops the spent ticket out of
        // history on the way.
        router.replace(links.account());
      })
      .catch((caught: unknown) => setFailure(failureMessage(caught, 'That sign-in did not work.')));
  }, [error, redeemSignInTicket, router, ticket]);

  if (failure || !ticket) {
    return (
      <CallbackCard title="Sign-in">
        <Banner message={failure ?? 'That sign-in did not finish.'} tone="error" />
        <Text style={styles.help}>Nothing was changed. You can try again.</Text>
        <SignInButtons />
      </CallbackCard>
    );
  }
  return <CallbackCard title="Signing you in…" />;
}

function CallbackCard({ children, title }: { children?: React.ReactNode; title: string }) {
  return (
    <ScreenShell width={contentWidth.reading}>
      <View style={styles.screen}>
        <Panel tone="accent">
          <SectionHeading eyebrow="ACCOUNT" title={title} />
          {children}
        </Panel>
      </View>
    </ScreenShell>
  );
}

const styles = themedSheet(() => ({
  screen: { gap: 12 },
  help: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8, marginBottom: 6 },
}));
