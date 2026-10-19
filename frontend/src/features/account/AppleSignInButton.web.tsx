import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import AppleMark from '@/ui/AppleMark';
import { Banner } from '@/ui/primitives';
import { useAppleOffered } from '@/hooks/useSignInProviders';
import type { SignInOutcome } from '@/store/accountSession';
import { useGameStore } from '@/store/gameStore';
import { activeScheme, radius, themedSheet } from '@/theme';

// Apple's button, on the website.
//
// Drawn here, because a browser has no system button to borrow. Apple's
// guidelines allow that when the button copies theirs: Apple's logo and one of
// Apple's titles, in black on white or white on black and in nothing else, at
// least as large as every other way in. So the colours below are Apple's and
// not the theme's — pure white on a dark theme, pure black on a light one — and
// the title is written as Apple writes it rather than in this app's capitals.
//
// Pressing it navigates the page away to Apple; see `appleAuth.web.ts`. It
// shows nothing until the server has said it can finish the website's flow,
// holding its place meanwhile — which is also what keeps the pre-rendered page
// and the first render in the browser the same.

const APPLE_WHITE = '#ffffff';
const APPLE_BLACK = '#000000';

interface AppleSignInButtonProps {
  /** How the press ended, for a screen that moves on when it does. */
  onOutcome?: (outcome: SignInOutcome) => void;
  /** Start it another way: the naming step carries its own identity along. */
  start?: () => Promise<SignInOutcome>;
}

export default function AppleSignInButton({ onOutcome, start }: AppleSignInButtonProps) {
  const signInWithApple = useGameStore((state) => state.signInWithApple);
  const offered = useAppleOffered();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (offered === false) return null;
  if (offered === null) return <View style={styles.slot} />;

  const press = async () => {
    setBusy(true);
    setError(null);
    const outcome = await (start ?? signInWithApple)();
    // 'pending' is the redirect already under way, so the button stays busy:
    // this page is going away.
    if (outcome.kind !== 'pending') setBusy(false);
    if (outcome.kind === 'failed') setError(outcome.message);
    onOutcome?.(outcome);
  };

  const dark = activeScheme() !== 'light';
  const ink = dark ? APPLE_BLACK : APPLE_WHITE;
  return (
    <View style={styles.wrapper}>
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
      <Pressable
        accessibilityLabel="Continue with Apple"
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={press}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: dark ? APPLE_WHITE : APPLE_BLACK },
          (pressed || busy) && styles.pressed,
        ]}
      >
        {busy ? (
          <ActivityIndicator color={ink} size="small" />
        ) : (
          <View style={styles.content}>
            <AppleMark color={ink} size={17} />
            <Text style={[styles.title, { color: ink }]}>Continue with Apple</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

const styles = themedSheet(() => ({
  wrapper: { width: '100%', gap: 8 },
  slot: { width: '100%', height: 42 },
  // Discord's height and corner, so the two ways in are drawn as equals.
  button: {
    width: '100%',
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.medium,
  },
  pressed: { opacity: 0.8 },
  content: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // The system font, at Apple's weight: the title is Apple's, so it is not set
  // in this app's label face.
  title: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif',
    fontSize: 16,
    fontWeight: '500',
    letterSpacing: -0.2,
  },
}));
