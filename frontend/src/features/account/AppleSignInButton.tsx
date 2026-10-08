import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Banner } from '@/ui/primitives';
import { useAppleOffered } from '@/hooks/useSignInProviders';
import { useGameStore } from '@/store/gameStore';
import { activeScheme, radius, themedSheet } from '@/theme';

// Apple's button, on the phone.
//
// Apple's own, drawn by the system — `ASAuthorizationAppleIDButton`, through
// `expo-apple-authentication`. Apple's guidelines allow a custom button only if
// it copies theirs exactly, and the system one is already exactly theirs:
// localised, accessible, and the button App Review expects. What the app picks
// is the size, the corner and which of Apple's colour styles to use — white on
// a dark theme, black on a light one, so it reads as a button on every theme.
//
// The package is loaded only once the store says this binary has it, for the
// reason `appleAuth.ts` gives: importing it in a build without the module
// throws. And nothing shows until the server has said it can finish an Apple
// sign-in, with the button's place held meanwhile so the panel does not jump
// when it appears. See `AppleSignInButton.web.tsx` for the browser.

type AppleModule = typeof import('expo-apple-authentication');

export default function AppleSignInButton() {
  const available = useGameStore((state) => state.appleSignInAvailable);
  const signInWithApple = useGameStore((state) => state.signInWithApple);
  const offered = useAppleOffered();
  const [apple, setApple] = useState<AppleModule | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    import('expo-apple-authentication').then(
      (module) => {
        if (!cancelled) setApple(module);
      },
      () => {
        // A binary that claimed the module and could not load it: offer
        // nothing rather than a button that does nothing.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [available]);

  if (offered === false) return null;
  if (offered === null || !apple) return <View style={styles.slot} />;

  const press = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const outcome = await signInWithApple();
    setBusy(false);
    if (outcome.kind === 'failed') setError(outcome.message);
  };

  return (
    <View style={styles.wrapper}>
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
      {/* Dimmed and deaf while a sign-in is out: Apple's button has no busy
          state of its own, and a second press would start a second sign-in. */}
      <View style={busy ? styles.busy : undefined}>
        <apple.AppleAuthenticationButton
          buttonStyle={
            activeScheme() === 'light'
              ? apple.AppleAuthenticationButtonStyle.BLACK
              : apple.AppleAuthenticationButtonStyle.WHITE
          }
          buttonType={apple.AppleAuthenticationButtonType.CONTINUE}
          cornerRadius={radius.medium}
          onPress={press}
          style={styles.button}
        />
      </View>
    </View>
  );
}

const styles = themedSheet(() => ({
  // The same width and height as Discord's button beside it, so neither reads
  // as the lesser way in.
  wrapper: { width: '100%', gap: 8 },
  slot: { width: '100%', height: 42 },
  button: { width: '100%', height: 42 },
  busy: { opacity: 0.6, pointerEvents: 'none' },
}));
