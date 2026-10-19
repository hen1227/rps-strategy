import { useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import AccountSignInPanel from './AccountSignInPanel';
import NewAccountStep from './NewAccountStep';
import SignInMethodsPanel from './SignInMethodsPanel';
import { useSignInMethods } from './useSignInMethods';
import { links } from '@/navigation/links';
import { useSettledSearchParams } from '@/navigation/useSettledSearchParams';
import {
  isSignedIn,
  receiptWorthShowing,
  type SignInOutcome,
  type SignInReceipt,
} from '@/store/accountSession';
import type { SignInProvider } from '@/store/api/bots';
import { useGameStore } from '@/store/gameStore';
import { colors, contentWidth, space, themedSheet } from '@/theme';
import type { Account } from '@/types/protocol';
import PageHeading from '@/ui/PageHeading';
import ScreenShell from '@/ui/ScreenShell';
import { Banner, PrimaryButton } from '@/ui/primitives';

// Signing in, and making an account, on one page of its own.
//
// It used to be a panel half way down the Account screen, with the naming step
// stacked above the profile of the guest it was about to replace. Three steps
// now, each the whole page:
//
// 1. Choose a provider. The same buttons sign somebody in and start an account,
//    because which it is depends on whether the server has seen the identity.
// 2. Only for an identity it has not seen: "First time here?" — make an account
//    under a new name, or join it to the account they already have. See
//    `NewAccountStep`, which is the reason this page exists.
// 3. What happened: a new account, or a second way in linked, with the list of
//    ways in as it now stands and the other provider's button if it is not on
//    it. A plain returning sign-in skips this and goes straight back.
//
// "Back" is the page whose sign-in button sent them here, carried in `next`
// and kept through a web redirect by the store. Without one, it is Account.
//
// The query string is unknown when this page is pre-rendered, so the steps wait
// one render for it, like every other page that reads one. The steps also read
// the stored flow, which the build cannot have either.

export default function SignInScreen() {
  const { params, settled } = useSettledSearchParams<{ next?: string }>();
  return (
    <ScreenShell width={contentWidth.reading}>
      {settled ? <SignInSteps next={params.next ?? null} /> : <ChooseHeading />}
    </ScreenShell>
  );
}

function SignInSteps({ next }: { next: string | null }) {
  const router = useRouter();
  const pending = useGameStore((state) => state.pendingSignup);
  const sessionToken = useGameStore((state) => state.sessionToken);
  const account = useGameStore((state) => state.account);
  const receipt = useGameStore((state) => state.signInReceipt);
  const returnTo = useGameStore((state) => state.signInReturnTo);
  const setSignInReturnTo = useGameStore((state) => state.setSignInReturnTo);
  const clearSignInReceipt = useGameStore((state) => state.clearSignInReceipt);
  // Set as the page is left, so the render between pressing and arriving does
  // not flash the last step at somebody who is going straight back.
  const [leaving, setLeaving] = useState(false);
  // On Android the browser's return address also opens the callback page,
  // which redeems the same ticket and moves on by itself. By the time the
  // button here hears the answer this page has gone, and moving on a second
  // time would undo where the callback went.
  const mounted = useRef(true);
  useEffect(() => {
    // Set again on mount, not only initialised: development mounts twice.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Where to go when this is over. Arriving with no `next` and nothing under
  // way is a fresh start, which forgets any place an abandoned sign-in meant to
  // return to; arriving mid-flow — back from Discord, or from the Account
  // screen's buttons — keeps it.
  useEffect(() => {
    if (next) setSignInReturnTo(next);
    else if (!pending && !receipt) setSignInReturnTo(null);
    // Once, on arrival: the flow changing under this page is not a new arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = useCallback(() => {
    setLeaving(true);
    const target = (useGameStore.getState().signInReturnTo ?? links.account()) as Href;
    setSignInReturnTo(null);
    clearSignInReceipt();
    // Replace, so Back from wherever they land does not reopen a finished
    // sign-in.
    router.replace(target);
  }, [clearSignInReceipt, router, setSignInReturnTo]);

  const onOutcome = useCallback(
    (outcome: SignInOutcome) => {
      if (!mounted.current) return;
      if (outcome.kind === 'named' && !receiptWorthShowing(outcome.receipt)) finish();
    },
    [finish],
  );

  if (leaving) return <ChooseHeading />;
  if (pending) return <NewAccountStep key={pending.ticket} onOutcome={onOutcome} pending={pending} />;
  // A session whose account the lobby has not delivered yet is somebody signed
  // in. Offering them the sign-in buttons for that moment would be wrong.
  if (sessionToken && !account) {
    return (
      <>
        <ChooseHeading />
        <ActivityIndicator color={colors.accent} style={styles.waiting} />
      </>
    );
  }
  if (account && isSignedIn(sessionToken, account)) {
    return <DoneStep account={account} onContinue={finish} receipt={receipt} returnTo={returnTo} />;
  }
  return (
    <>
      <ChooseHeading />
      <AccountSignInPanel heading={false} onOutcome={onOutcome} />
    </>
  );
}

function ChooseHeading() {
  return (
    <PageHeading
      detail="New here? You choose a name next."
      eyebrow="ACCOUNT"
      title="Sign in or sign up"
    />
  );
}

const providerName = (provider: SignInProvider) => (provider === 'apple' ? 'Apple' : 'Discord');

/**
 * The last step: who they are now, and every way in.
 *
 * The list is the point. Linking is invisible otherwise — nothing on any other
 * screen changes when Apple joins a Discord account — so this is where somebody
 * sees that the next sign-in on their phone will land here, and where the one
 * still missing is a button away.
 */
function DoneStep({
  account,
  receipt,
  returnTo,
  onContinue,
}: {
  account: Account;
  receipt: SignInReceipt | null;
  returnTo: string | null;
  onContinue: () => void;
}) {
  // Asked again after every link, but only the first answer is waited for: the
  // list and the button under it arrive together, so the button is never
  // pushed down from under a thumb.
  const { methods, loaded } = useSignInMethods();
  const [shown, setShown] = useState(false);
  if (loaded && !shown) setShown(true);
  const created = receipt?.kind === 'created';
  const linked = receipt?.linked ?? [];

  return (
    <>
      <PageHeading
        detail={
          linked.length
            ? `${linked.map(providerName).join(' and ')} linked. Sign in with either.`
            : undefined
        }
        eyebrow={created ? 'ACCOUNT CREATED' : 'SIGNED IN'}
        title={
          created
            ? `Welcome, ${account.username}`
            : receipt?.kind === 'signedIn'
              ? `Welcome back, ${account.username}`
              : `Signed in as ${account.username}`
        }
      />
      {receipt?.linkFailure ? (
        <Banner
          message={`${providerName(receipt.linkFailure.provider)} was not linked: ${receipt.linkFailure.message.replace(/\.+$/, '')}.`}
          tone="error"
        />
      ) : null}
      {shown ? (
        <>
          <SignInMethodsPanel always methods={methods} />
          <View style={styles.continue}>
            <PrimaryButton
              fullWidth
              label={returnTo ? 'CONTINUE' : 'GO TO YOUR ACCOUNT'}
              onPress={onContinue}
            />
          </View>
        </>
      ) : (
        <ActivityIndicator color={colors.accent} style={styles.waiting} />
      )}
    </>
  );
}

const styles = themedSheet(() => ({
  continue: { marginTop: space.small },
  waiting: { alignSelf: 'flex-start', marginTop: space.medium },
}));
