import { useRouter } from 'expo-router';
import { failureMessage } from '@/errors';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import LinkRow from '@/ui/LinkRow';
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
import AccountSignInPanel from '@/features/account/AccountSignInPanel';
import DiscordLinkPrompt from '@/features/account/DiscordLinkPrompt';
import UsernameSetupPanel from '@/features/account/UsernameSetupPanel';
import TitlesPanel from '@/features/account/TitlesPanel';
import GameHistoryPanel from '@/features/game/GameHistoryPanel';
import MatchAlertsPanel from '@/features/queue/MatchAlertsPanel';
import { getAccount, updateAccount } from '@/store/api/accounts';
import { isSignedIn } from '@/store/accountSession';
import { useGameStore } from '@/store/gameStore';
import { isReservedIn, useIdentityPolicy } from '@/hooks/useIdentityPolicy';
import { links } from '@/navigation/links';
import type { ModeDefinition, ModeID } from '@/types/game';
import type { Account } from '@/types/protocol';
import TitleTag from '@/ui/TitleTag';
import { colors, contentWidth, radius } from '@/theme';

// The account screen, which is now first and foremost where you get an
// account. Everyone plays under a name the server gave them until they claim
// one, so the sign-up panel stands where the name field used to.

const MINIMUM_DISCORD_LENGTH = 2;
const MAXIMUM_DISCORD_LENGTH = 64;

const visibleName = (account: Account | null | undefined) =>
  account?.username && account.username.toLowerCase() !== 'guest' ? account.username : '';

// Every mode rates separately. A mode the player has not finished yet reports
// the account's shared rating, which is what the server will seed it with.
/** One mode's rating, as the table shows it. */
interface ModeRatingRow {
  id: ModeID;
  name: string;
  shortCode: string;
  elo: number;
  wins: number;
  draws: number;
  losses: number;
  gamesPlayed: number;
}

const modeRatingRows = (
  account: Account | null | undefined,
  modes: ModeDefinition[],
): ModeRatingRow[] => {
  const seedElo = account?.elo ?? 1200;
  const ratings = account?.modeRatings ?? {};
  return modes
    .filter((mode) => mode.playable !== false || ratings[mode.id])
    .map((mode) => {
      const rating = ratings[mode.id];
      return {
        id: mode.id,
        name: mode.name,
        shortCode: mode.shortCode,
        elo: rating?.elo ?? seedElo,
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

  return (
    // No back button: inside the app shell the sidebar or the tab bar is the
    // way out, and a third answer to "how do I leave" is not an improvement.
    <ScreenShell width={contentWidth.reading}>
      <>
          <View style={styles.hero}>
            <Text style={styles.eyebrow}>PLAYER PROFILE</Text>
            <Text style={styles.title}>Your account</Text>
            <Text style={styles.subtitle}>
              {account?.registered
                ? 'These details appear to your opponent in every online game.'
                : 'Sign in with Discord and everything you have played so far comes with it.'}
            </Text>
          </View>

          <UsernameSetupPanel />
          {signedIn && account && !discordVerified ? <DiscordLinkPrompt /> : null}

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
                    {featuredRating?.gamesPlayed ? `${featuredRating.shortCode} ELO` : 'ELO'}
                  </Text>
                  <Text style={styles.eloValue}>
                    {featuredRating?.elo ?? account?.elo ?? 1200}
                  </Text>
                </View>
              </Panel>

              {signedIn ? (
                <Panel>
                  <SectionHeading
                    eyebrow="PUBLIC DETAILS"
                    title="Online identity"
                    trailing={<GhostButton compact label="SIGN OUT" onPress={signOut} />}
                  />
                  <Text style={styles.helper}>
                    Your username is what opponents see, what challenges are addressed to,
                    and what you sign in with. Discord is optional, and how the host reaches
                    you about tournaments.
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
                      <Text style={styles.helper}>
                        Confirmed by Discord when you signed in, so nobody can enter it as
                        theirs.
                      </Text>
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
              ) : (
                <AccountSignInPanel />
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

              {/*
                A bot belongs to an account, so this is where its registry
                hangs off. It used to be the fourth tab of the Bots page, which
                put a token minter behind a page about playing.
              */}
              <Panel>
                <LinkRow
                  detail="Register an engine, take its token, and run it from your own machine."
                  divided={false}
                  href={links.myBots()}
                  title="Your bots"
                />
              </Panel>

              <Panel>
                <SectionHeading eyebrow="RANKED" title="Mode ratings" />
                <Text style={styles.helper}>
                  Each mode rates on its own. A mode you have not finished yet starts from
                  your current {account?.elo ?? 1200}.
                </Text>
                <View style={styles.ratingList}>
                  {ratingRows.map((rating) => (
                    <View key={rating.id} style={styles.ratingRow}>
                      <View style={styles.ratingIdentity}>
                        <Text style={styles.ratingName}>{rating.name}</Text>
                        <Text style={styles.ratingRecord}>
                          {rating.gamesPlayed > 0
                            ? `${rating.wins}W · ${rating.draws}D · ${rating.losses}L`
                            : 'No ranked games yet'}
                        </Text>
                      </View>
                      <Text
                        style={[
                          styles.ratingElo,
                          rating.gamesPlayed === 0 && styles.ratingEloUnplayed,
                        ]}
                      >
                        {rating.elo}
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
                  What gets stored about you, and the rules of online play ›
                </Text>
              </Pressable>

            </View>
          )}
      </>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({

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
  keyTitle: { color: colors.text, fontSize: 12, fontWeight: '900' },
  keyBody: { color: colors.textMuted, fontSize: 10, lineHeight: 16, marginTop: 4 },
  accountId: { color: colors.textFaint, fontSize: 9, marginTop: 8 },

  policyLink: { alignItems: 'center', paddingVertical: 10 },
  policyLinkText: { color: colors.textMuted, fontSize: 10, fontWeight: '900', lineHeight: 16 },

  pressed: { opacity: 0.7 },
});
