import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Banner,
  LabeledInput,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '../components/ui';
import { getAccount, updateAccount } from '../store/accountApi';
import { useGameStore } from '../store/gameStore';
import { colors, radius } from '../theme';

const visibleName = (account) =>
  account?.username && account.username.toLowerCase() !== 'guest' ? account.username : '';

// Every mode rates separately. A mode the player has not finished yet reports
// the account's shared rating, which is what the server will seed it with.
const modeRatingRows = (account, modes) => {
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

const isReserved = (value) => {
  const normalized = value.trim().replace(/^@/, '').toLowerCase();
  return normalized === 'henhen1227' || normalized === 'webgoatguy';
};

export default function AccountScreen({ navigation }) {
  const accountId = useGameStore((state) => state.accountId);
  const profileKey = useGameStore((state) => state.profileKey);
  const storedAccount = useGameStore((state) => state.account);
  const modes = useGameStore((state) => state.modes);
  const applyAccountUpdate = useGameStore((state) => state.applyAccountUpdate);
  const [account, setAccount] = useState(storedAccount);
  const [displayName, setDisplayName] = useState(() => visibleName(storedAccount));
  const [discord, setDiscord] = useState(storedAccount?.discord ?? '');
  const [loading, setLoading] = useState(!storedAccount);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [reservationToken, setReservationToken] = useState('');

  useEffect(() => {
    if (!storedAccount) return;
    setAccount(storedAccount);
    setDisplayName(visibleName(storedAccount));
    setDiscord(storedAccount.discord ?? '');
    setLoading(false);
  }, [storedAccount?.updatedAtUnixMs]);

  useEffect(() => {
    if (storedAccount) return;
    let cancelled = false;
    getAccount(accountId)
      .then((nextAccount) => {
        if (cancelled) return;
        setAccount(nextAccount);
        setDisplayName(visibleName(nextAccount));
        setDiscord(nextAccount.discord ?? '');
      })
      .catch((requestError) => {
        if (!cancelled) setError(requestError.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, storedAccount]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateAccount(
        accountId,
        profileKey,
        displayName.trim(),
        discord.trim(),
        reservationToken.trim(),
      );
      setAccount(updated);
      setDisplayName(updated.username);
      setDiscord(updated.discord);
      setSaved(true);
      setReservationToken('');
      applyAccountUpdate(updated);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const canSave =
    !saving &&
    displayName.trim().length >= 1 &&
    displayName.trim().length <= 40 &&
    discord.trim().length >= 2 &&
    discord.trim().length <= 64 &&
    !/\s/.test(discord.trim());
  const needsReservationToken = isReserved(displayName) || isReserved(discord);
  const ratingRows = modeRatingRows(account, modes);
  // The badge follows the mode the player actually plays rather than averaging
  // ratings that are deliberately independent.
  const featuredRating = ratingRows.reduce(
    (best, rating) => (best && best.gamesPlayed >= rating.gamesPlayed ? best : rating),
    null,
  );
  const saveDisabled = !canSave || (needsReservationToken && !reservationToken.trim());

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
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
            <Text style={styles.eyebrow}>PLAYER PROFILE</Text>
            <Text style={styles.title}>Your account</Text>
            <Text style={styles.subtitle}>
              These details appear to your opponent in every online game.
            </Text>
          </View>

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
                    {(displayName.trim() || 'P').slice(0, 1).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.profileIdentity}>
                  <Text style={styles.profileName}>{displayName.trim() || 'New player'}</Text>
                  <Text style={styles.profileDiscord}>
                    {discord.trim() ? `Discord: ${discord.trim()}` : 'Add your Discord username'}
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

              <Panel>
                <SectionHeading eyebrow="PUBLIC DETAILS" title="Online identity" />
                <Text style={styles.helper}>
                  Use the name people know you by. Discord must not contain spaces.
                </Text>

                <LabeledInput
                  autoCapitalize="words"
                  label="DISPLAY NAME"
                  maxLength={40}
                  onChangeText={(value) => {
                    setDisplayName(value);
                    setSaved(false);
                  }}
                  placeholder="Your display name"
                  value={displayName}
                />
                <Text style={styles.characterCount}>{displayName.length}/40</Text>

                <LabeledInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  label="DISCORD HANDLE"
                  maxLength={64}
                  onChangeText={(value) => {
                    setDiscord(value);
                    setSaved(false);
                  }}
                  placeholder="username or username#1234"
                  value={discord}
                />
                <Text style={styles.characterCount}>{discord.length}/64</Text>

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
                    disabled={saveDisabled}
                    label="SAVE PROFILE"
                    loading={saving}
                    onPress={save}
                  />
                </View>
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

              <Panel style={styles.keyPanel}>
                <View style={styles.keyIcon}>
                  <Text style={styles.keyIconText}>◆</Text>
                </View>
                <View style={styles.keyCopy}>
                  <Text style={styles.keyTitle}>Protected by a local account key</Text>
                  <Text style={styles.keyBody}>
                    This browser keeps a random private key and the server stores only its hash.
                    Clearing this site’s browser data will create a new account.
                  </Text>
                  <Text style={styles.accountId} selectable>
                    Account ID: {accountId}
                  </Text>
                </View>
              </Panel>

              <Pressable
                accessibilityLabel="Read the privacy policy and online play agreement"
                accessibilityRole="button"
                onPress={() => navigation.navigate('Policy')}
                style={({ pressed }) => [styles.policyLink, pressed && styles.pressed]}
              >
                <Text style={styles.policyLinkText}>
                  What gets stored about you, and the rules of online play ›
                </Text>
              </Pressable>
            </View>
          )}
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
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
  profileName: { color: colors.textStrong, fontSize: 16, fontWeight: '900' },
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
