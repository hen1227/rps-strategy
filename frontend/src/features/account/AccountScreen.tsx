import { useRouter } from 'expo-router';
import { failureMessage } from '@/errors';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import ScreenShell from '@/ui/ScreenShell';
import {
  Badge,
  Banner,
  GhostButton,
  LabeledInput,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';
import {
  RATING_START,
  RATING_UNRATED_LABEL,
  ratingIsRankable,
  ratingLabel,
} from '@/features/ratings/scale';
import AccountSignInPanel from '@/features/account/AccountSignInPanel';
import DeleteAccountPanel from '@/features/account/DeleteAccountPanel';
import BlockedPlayersPanel from '@/features/moderation/BlockedPlayersPanel';
import LinkSignInPrompt from '@/features/account/LinkSignInPrompt';
import SignInMethodsPanel from '@/features/account/SignInMethodsPanel';
import { useSignInMethods } from '@/features/account/useSignInMethods';
import TitlesPanel from '@/features/account/TitlesPanel';
import UsageStatsPanel from '@/features/account/UsageStatsPanel';
import GameHistoryPanel from '@/features/game/GameHistoryPanel';
import MatchAlertsPanel from '@/features/queue/MatchAlertsPanel';
import { getAccount, updateAccount } from '@/store/api/accounts';
import { isSignedIn, receiptWorthShowing, type SignInOutcome } from '@/store/accountSession';
import { useGameStore } from '@/store/gameStore';
import { isReservedIn, useIdentityPolicy } from '@/hooks/useIdentityPolicy';
import { useSettled } from '@/hooks/useSettled';
import { links } from '@/navigation/links';
import { useGoTo } from '@/navigation/stack';
import type { ModeDefinition, ModeID } from '@/types/game';
import type { Account, RatingState } from '@/types/protocol';
import TitleTag from '@/ui/TitleTag';
import { colors, contentWidth, radius, themedSheet } from '@/theme';

// The account screen, which is now first and foremost where you get an
// account. Everyone plays under a name the server gave them until they claim
// one, so the sign-up panel stands where the name field used to.
//
// Only its first step, though. A press that turns out to be somebody new goes
// on to the sign-in screen, which asks whether they already play here before
// anything is made; see `SignInScreen`.

const MINIMUM_DISCORD_LENGTH = 2;
const MAXIMUM_DISCORD_LENGTH = 64;

const visibleName = (account: Account | null | undefined) =>
  account?.username && account.username.toLowerCase() !== 'guest' ? account.username : '';

// Every mode rates separately. A mode the player has not played yet starts at
// RATING_START and is unrated, so it prints as a dash, the way the leaderboard
// prints it.
/** One mode's rating, as the table shows it. */
interface ModeRatingRow {
  id: ModeID;
  name: string;
  shortCode: string;
  elo: number;
  ratingState?: RatingState;
  wins: number;
  draws: number;
  losses: number;
  gamesPlayed: number;
}

const modeRatingRows = (
  account: Account | null | undefined,
  modes: ModeDefinition[],
): ModeRatingRow[] => {
  const ratings = account?.modeRatings ?? {};
  return modes
    .filter((mode) => mode.playable !== false || ratings[mode.id])
    .map((mode) => {
      const rating = ratings[mode.id];
      return {
        id: mode.id,
        name: mode.name,
        shortCode: mode.shortCode,
        elo: rating?.elo ?? RATING_START,
        // No row at all is a mode never played, whatever the server's age; a
        // row without a state is an older server, which ratingIsRankable reads
        // as a real rating.
        ratingState: rating ? rating.ratingState : 'unrated',
        wins: rating?.wins ?? 0,
        draws: rating?.draws ?? 0,
        losses: rating?.losses ?? 0,
        gamesPlayed: rating?.gamesPlayed ?? 0,
      };
    });
};

export default function AccountScreen() {
  const router = useRouter();
  const policy = useIdentityPolicy();
  const accountId = useGameStore((state) => state.accountId);
  const sessionToken = useGameStore((state) => state.sessionToken);
  const storedAccount = useGameStore((state) => state.account);
  const modes = useGameStore((state) => state.modes);
  const applyAccountUpdate = useGameStore((state) => state.applyAccountUpdate);
  const signOut = useGameStore((state) => state.signOut);
  const pendingSignup = useGameStore((state) => state.pendingSignup);
  const clearSignInReceipt = useGameStore((state) => state.clearSignInReceipt);
  const goTo = useGoTo();
  // The stored sign-in flow is something the pre-rendered page cannot know.
  const settled = useSettled();

  const [account, setAccount] = useState(storedAccount);
  // Null until something is typed, so the fields follow the account until the
  // player takes them over.
  const [edits, setEdits] = useState<{ username: string; discord: string } | null>(null);
  const [reservationToken, setReservationToken] = useState('');
  const [loading, setLoading] = useState(!storedAccount);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!storedAccount) return;
    setAccount(storedAccount);
    setLoading(false);
  }, [storedAccount?.updatedAtUnixMs]);

  // Only a fallback: the lobby socket normally delivers the account before
  // this screen opens. It matters when the socket has not come up yet.
  useEffect(() => {
    if (storedAccount) return;
    let cancelled = false;
    getAccount(accountId)
      .then((nextAccount) => {
        if (!cancelled) setAccount(nextAccount);
      })
      .catch((requestError) => {
        if (!cancelled) setError(failureMessage(requestError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, storedAccount]);

  const signedIn = isSignedIn(sessionToken, account);
  // A verified handle is Discord's answer, not the player's, so it is shown
  // rather than edited. Only a legacy account that has not linked yet still
  // types one.
  const discordVerified = Boolean(account?.discordVerified);

  // Whether to ask a password account to link Discord or Apple, and what the
  // sign-in methods panel lists. See `useSignInMethods`.
  const { awaitingLink, methods: signInMethods } = useSignInMethods();

  // A new identity goes on to the sign-in screen's "first time here?" step, and
  // so does anything worth confirming. A returning player is already home.
  // Not once this screen has gone: on Android the callback page answers the
  // same sign-in, and has already moved on.
  const mounted = useRef(true);
  useEffect(() => {
    // Set again on mount, not only initialised: development mounts twice.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onSignInOutcome = (outcome: SignInOutcome) => {
    if (!mounted.current) return;
    if (
      outcome.kind === 'unnamed' ||
      (outcome.kind === 'named' && receiptWorthShowing(outcome.receipt))
    ) {
      goTo(links.signIn());
    } else if (outcome.kind === 'named') {
      clearSignInReceipt();
    }
  };

  const username = edits?.username ?? account?.username ?? '';
  const discord = edits?.discord ?? account?.discord ?? '';
  const setField = (field: 'username' | 'discord', value: string) => {
    setEdits({ username, discord, [field]: value });
    setSaved(false);
  };

  const trimmedUsername = username.trim();
  const trimmedDiscord = discord.trim();
  // Usernames only. A verified handle is Discord's own answer and cannot be
  // forged, so reserving it would prevent no impersonation — while a real
  // Discord user whose name happened to match a reserved one would be
  // permanently unable to save any change to their profile.
  const needsReservationToken = isReservedIn(policy, trimmedUsername);
  const discordChanged = !discordVerified && trimmedDiscord !== (account?.discord ?? '');
  const changed = trimmedUsername !== (account?.username ?? '') || discordChanged;
  const canSave =
    !saving &&
    changed &&
    trimmedUsername.length >= policy.minLength &&
    trimmedUsername.length <= policy.maxLength &&
    (discordVerified ||
      trimmedDiscord === '' ||
      (trimmedDiscord.length >= MINIMUM_DISCORD_LENGTH &&
        trimmedDiscord.length <= MAXIMUM_DISCORD_LENGTH &&
        !/\s/.test(trimmedDiscord))) &&
    (!needsReservationToken || Boolean(reservationToken.trim()));

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      if (!account || !sessionToken) return;
      const updated = await updateAccount(
        account.userId,
        sessionToken,
        trimmedUsername,
        trimmedDiscord,
        reservationToken.trim(),
      );
      setAccount(updated);
      setEdits(null);
      setReservationToken('');
      setSaved(true);
      // Reconnects the lobby socket, so opponents see the new name at once.
      applyAccountUpdate(updated);
    } catch (requestError) {
      setError(failureMessage(requestError));
    } finally {
      setSaving(false);
    }
  };

  const ratingRows = modeRatingRows(account, modes);
  // The badge follows the mode the player actually plays rather than averaging
  // ratings that are deliberately independent.
  const featuredRating = ratingRows.reduce<ModeRatingRow | null>(
    (best, rating) => (best && best.gamesPlayed >= rating.gamesPlayed ? best : rating),
    null,
  );
  // It is the number a player reads as their rating, so a mode with no ranked
  // game prints as a dash rather than as the number everybody starts on.
  const featuredState: RatingState | undefined = featuredRating
    ? featuredRating.ratingState
    : 'unrated';

  return (
    // No back button: inside the app shell the sidebar or the tab bar is the
    // way out, and a third answer to "how do I leave" is not an improvement.
    <ScreenShell width={contentWidth.reading}>
      <>
          <View style={styles.hero}>
            <Text style={styles.eyebrow}>PLAYER PROFILE</Text>
            <Text style={styles.title}>Your account</Text>
            {/* Signed in, the identity panel says who sees what; a line here
                saying it as well was the same sentence twice. */}
            {account?.registered ? null : (
              <Text style={styles.subtitle}>Sign in to keep your games and rating.</Text>
            )}
          </View>

          {signedIn && account && !discordVerified && awaitingLink ? <LinkSignInPrompt /> : null}

          {loading ? (
            <View style={styles.loadingCard}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.helper}>Loading your account…</Text>
            </View>
          ) : (
            <View style={styles.stack}>
              <Panel style={styles.profilePanel} tone="accent">
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {(visibleName(account) || 'G').slice(0, 1).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.profileIdentity}>
                  <View style={styles.profileNameRow}>
                    <TitleTag size="large" title={account?.title} />
                    <Text numberOfLines={1} style={styles.profileName}>
                      {visibleName(account) || 'Guest player'}
                    </Text>
                  </View>
                  <Text style={styles.profileDiscord}>
                    {signedIn
                      ? trimmedDiscord
                        ? `Discord: ${trimmedDiscord}`
                        : 'No Discord handle yet'
                      : 'Not signed in'}
                  </Text>
                </View>
                <View style={styles.eloBadge}>
                  <Text style={styles.eloLabel}>
                    {/* The mode by name, as every other page calls it; "V3" is the
                        server's word for it. */}
                    {featuredRating?.gamesPlayed ? featuredRating.name.toUpperCase() : 'RATING'}
                  </Text>
                  <Text
                    accessibilityLabel={
                      ratingIsRankable(featuredState) ? undefined : RATING_UNRATED_LABEL
                    }
                    style={styles.eloValue}
                  >
                    {ratingLabel(featuredRating?.elo ?? RATING_START, featuredState)}
                  </Text>
                </View>
              </Panel>

              {/*
                Straight under the profile, above the form for editing it: how
                this account is reached matters more than its spelling, and the
                button for the missing provider is the one that stops a second
                account being made on the next device.
              */}
              {signedIn ? <SignInMethodsPanel methods={signInMethods} /> : null}

              {signedIn ? (
                <Panel>
                  <SectionHeading
                    eyebrow="PUBLIC DETAILS"
                    title="Online identity"
                    trailing={<GhostButton compact label="SIGN OUT" onPress={signOut} />}
                  />
                  <Text style={styles.helper}>
                    Players see this name and use it to challenge you.
                  </Text>

                  <LabeledInput
                    autoCapitalize="none"
                    autoCorrect={false}
                    hint={`${policy.minLength}-${policy.maxLength} characters: letters, digits, and _ . -`}
                    label="USERNAME"
                    maxLength={policy.maxLength}
                    onChangeText={(value) => setField('username', value)}
                    placeholder="Your username"
                    value={username}
                  />
                  <Text style={styles.characterCount}>
                    {username.length}/{policy.maxLength}
                  </Text>

                  {discordVerified ? (
                    <View style={styles.verifiedRow}>
                      <Text style={styles.fieldLabel}>DISCORD</Text>
                      <View style={styles.verifiedValue}>
                        <Text style={styles.verifiedHandle}>{discord}</Text>
                        <Badge label="VERIFIED" tone="accent" />
                      </View>
                    </View>
                  ) : (
                    <>
                      <LabeledInput
                        autoCapitalize="none"
                        autoCorrect={false}
                        label="DISCORD HANDLE"
                        maxLength={MAXIMUM_DISCORD_LENGTH}
                        onChangeText={(value) => setField('discord', value)}
                        placeholder="username (optional)"
                        value={discord}
                      />
                      <Text style={styles.characterCount}>
                        {discord.length}/{MAXIMUM_DISCORD_LENGTH}
                      </Text>
                    </>
                  )}

                  {needsReservationToken && (
                    <LabeledInput
                      autoCapitalize="none"
                      autoCorrect={false}
                      label="SPECIAL TOKEN"
                      onChangeText={setReservationToken}
                      placeholder="Paste special token"
                      secureTextEntry
                      value={reservationToken}
                    />
                  )}

                  {Boolean(error || saved) && (
                    <View style={styles.banners}>
                      <Banner message={error} onDismiss={() => setError(null)} tone="error" />
                      {saved && <Banner message="Profile saved. Online play is reconnecting." />}
                    </View>
                  )}

                  <View style={styles.saveAction}>
                    <PrimaryButton
                      accessibilityLabel="Save profile"
                      disabled={!canSave}
                      label="SAVE PROFILE"
                      loading={saving}
                      onPress={save}
                    />
                  </View>
                </Panel>
              ) : settled && pendingSignup ? (
                // Left part way through: the ticket is still good for a few
                // minutes, so the step is offered back rather than thrown away.
                <Panel tone="accent">
                  <SectionHeading eyebrow="ACCOUNT" title="Finish signing in" />
                  <Text style={styles.helper}>
                    {pendingSignup.provider === 'apple' ? 'Apple' : 'Discord'} is verified. Choose a
                    name, or link it to your account.
                  </Text>
                  <View style={styles.saveAction}>
                    <PrimaryButton fullWidth label="CONTINUE" onPress={() => goTo(links.signIn())} />
                  </View>
                </Panel>
              ) : (
                <AccountSignInPanel onOutcome={onSignInOutcome} />
              )}

              {/*
                Under the identity form, because a title is part of the name
                rather than a statistic: it is chosen next to the field it will
                sit in front of, not down beside the ratings that earned it.
              */}
              <TitlesPanel account={account} sessionToken={sessionToken} />

              {/*
                Always here, whatever state alerts are in — including the states
                nothing can be done about. This is the page somebody opens when
                notifications are not working and they want to know why, and it
                cannot answer that by rendering nothing.
              */}
              <MatchAlertsPanel variant="settings" />
              <UsageStatsPanel />

              <Panel>
                <SectionHeading eyebrow="RANKED" title="Mode ratings" />
                <View style={styles.ratingList}>
                  {ratingRows.map((rating) => (
                    <View key={rating.id} style={styles.ratingRow}>
                      <View style={styles.ratingIdentity}>
                        <Text style={styles.ratingName}>{rating.name}</Text>
                        <Text style={styles.ratingRecord}>
                          {rating.gamesPlayed > 0
                            ? `${rating.wins}W · ${rating.draws}D · ${rating.losses}L`
                            : RATING_UNRATED_LABEL}
                        </Text>
                      </View>
                      <Text
                        style={[
                          styles.ratingElo,
                          rating.gamesPlayed === 0 && styles.ratingEloUnplayed,
                        ]}
                      >
                        {ratingLabel(rating.elo, rating.ratingState)}
                      </Text>
                    </View>
                  ))}
                </View>
              </Panel>

              <Panel>
                <SectionHeading eyebrow="LIFETIME" title="Your record" />
                <View style={styles.recordRow}>
                  <View style={styles.recordStat}>
                    <Text style={styles.recordValue}>{account?.wins ?? 0}</Text>
                    <Text style={styles.recordLabel}>WINS</Text>
                  </View>
                  <View style={styles.recordDivider} />
                  <View style={styles.recordStat}>
                    <Text style={styles.recordValue}>{account?.draws ?? 0}</Text>
                    <Text style={styles.recordLabel}>DRAWS</Text>
                  </View>
                  <View style={styles.recordDivider} />
                  <View style={styles.recordStat}>
                    <Text style={styles.recordValue}>{account?.losses ?? 0}</Text>
                    <Text style={styles.recordLabel}>LOSSES</Text>
                  </View>
                </View>
              </Panel>

              {/*
                The detail behind the totals above it: the same games those
                wins and losses were counted from, each one openable as a
                review and copyable as a link. It sits under the record rather
                than above the ratings because it is that record, itemised.
              */}
              <GameHistoryPanel title="Your games" userId={account?.userId ?? accountId} />

              {/*
                Two panels about other people and about leaving, at the bottom
                of the screen rather than beside the identity form. Both are
                things somebody comes here on purpose to do; neither is a
                setting to be scrolled past on the way to something else.
              */}
              <BlockedPlayersPanel />

              <Panel style={styles.keyPanel}>
                <View style={styles.keyIcon}>
                  <Text style={styles.keyIconText}>◆</Text>
                </View>
                <View style={styles.keyCopy}>
                  <Text style={styles.accountId} selectable>
                    Account ID: {accountId}
                  </Text>
                </View>
              </Panel>

              <Pressable
                accessibilityLabel="Read the privacy policy and online play agreement"
                accessibilityRole="button"
                onPress={() => router.push(links.policy())}
                style={({ pressed }) => [styles.policyLink, pressed && styles.pressed]}
              >
                <Text style={styles.policyLinkText}>
                  Privacy and online play rules ›
                </Text>
              </Pressable>

              {/*
                Last, and after the policy link on purpose: the page that says
                what deletion actually keeps should be the thing somebody passes
                on their way to the button.

                `signOut` before navigating, because the credential this screen
                holds now opens nothing — leaving it in place would leave the
                app signed in to an account the server has forgotten.
              */}
              <DeleteAccountPanel
                account={account}
                onDeleted={() => {
                  signOut();
                  router.replace(links.lobby());
                }}
              />

            </View>
          )}
      </>
    </ScreenShell>
  );
}

const styles = themedSheet(() => ({

  hero: { paddingTop: 24, paddingBottom: 22 },
  // Neutral, as an eyebrow is everywhere else: green is for the button to press.
  eyebrow: { color: colors.textFaint, fontSize: 10, fontWeight: '900', letterSpacing: 2.1 },
  title: {
    color: colors.textStrong,
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -1,
    marginTop: 5,
  },
  subtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 20, marginTop: 6 },

  stack: { gap: 12 },
  loadingCard: { alignItems: 'center', gap: 10, paddingVertical: 40 },
  helper: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },

  profilePanel: { flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: 47,
    height: 47,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurface,
  },
  avatarText: { color: colors.accentSoft, fontSize: 19, fontWeight: '900' },
  profileIdentity: { flex: 1, minWidth: 0, paddingHorizontal: 12 },
  profileNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  profileName: { color: colors.textStrong, fontSize: 16, fontWeight: '900', flexShrink: 1 },
  profileDiscord: { color: colors.textMuted, fontSize: 10, marginTop: 3 },
  eloBadge: { alignItems: 'flex-end', paddingLeft: 8 },
  eloLabel: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  eloValue: { color: colors.accentBright, fontSize: 21, fontWeight: '900', marginTop: 1 },

  ratingList: { gap: 8, marginTop: 14 },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 9,
    paddingHorizontal: 11,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceMuted,
  },
  ratingIdentity: { flex: 1, minWidth: 0, paddingRight: 10 },
  ratingName: { color: colors.text, fontSize: 13, fontWeight: '900' },
  ratingRecord: { color: colors.textFaint, fontSize: 9, marginTop: 2 },
  ratingElo: { color: colors.accentBright, fontSize: 17, fontWeight: '900' },
  ratingEloUnplayed: { color: colors.textMuted },

  characterCount: { alignSelf: 'flex-end', color: colors.textFaint, fontSize: 9, marginTop: 4 },
  verifiedRow: { marginTop: 14 },
  fieldLabel: {
    color: colors.textFaint,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.2,
  },
  verifiedValue: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  verifiedHandle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  banners: { gap: 8, marginTop: 14 },
  saveAction: { marginTop: 15 },

  recordRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  recordStat: { flex: 1, alignItems: 'center' },
  recordValue: { color: colors.textStrong, fontSize: 20, fontWeight: '900' },
  recordLabel: {
    color: colors.textFaint,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
    marginTop: 3,
  },
  recordDivider: { width: 1, height: 31, backgroundColor: colors.border },

  keyPanel: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  keyIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceMuted,
  },
  keyIconText: { color: colors.accentBright, fontSize: 13 },
  keyCopy: { flex: 1 },
  accountId: { color: colors.textFaint, fontSize: 9, marginTop: 8 },

  policyLink: { alignItems: 'center', paddingVertical: 10 },
  policyLinkText: { color: colors.textMuted, fontSize: 10, fontWeight: '900', lineHeight: 16 },

  pressed: { opacity: 0.7 },
}));
