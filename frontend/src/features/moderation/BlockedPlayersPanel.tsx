import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { failureMessage } from '@/errors';
import { getBlockedPlayers, unblockPlayer } from '@/store/api/moderation';
import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, themedSheet, type } from '@/theme';
import PlayerLink from '@/ui/PlayerLink';
import TitleTag from '@/ui/TitleTag';
import { Banner, EmptyState, GhostButton, Panel, SectionHeading } from '@/ui/primitives';
import type { BlockedAccount } from '@/types/protocol';

// The list of people you have blocked, and the only place to undo it.
//
// A block has to be reversible from somewhere that is not the room it was
// placed in — the whole point is that you no longer go near that person, so
// "find them again and press unblock" is not a way back. This panel is that
// somewhere, and it is why the account screen shows it even when it is empty:
// somebody who has blocked one person and forgotten needs to be able to find
// the list, and a panel that only exists once you have used the feature cannot
// be found by looking.

export default function BlockedPlayersPanel() {
  const sessionToken = useGameStore((state) => state.sessionToken);
  // The socket's copy, which the server refreshes on every change from any tab.
  // Watched rather than read once, so unblocking somebody in another tab does
  // not leave this list showing them.
  const blockedUserIds = useGameStore((state) => state.blockedUserIds);

  const [blocked, setBlocked] = useState<BlockedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!sessionToken) {
      setBlocked([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getBlockedPlayers(sessionToken)
      .then((list) => {
        if (!cancelled) setBlocked(list);
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
  }, [sessionToken]);

  // Reloaded when the id list changes, because that list is ids and this panel
  // shows names: the socket says *that* something changed, and the route says
  // what it changed to.
  useEffect(() => load(), [load, blockedUserIds.length]);

  const lift = async (entry: BlockedAccount) => {
    if (!sessionToken) return;
    setBusyId(entry.userId);
    setError(null);
    try {
      setBlocked(await unblockPlayer(sessionToken, entry.userId));
    } catch (requestError) {
      setError(failureMessage(requestError));
    } finally {
      setBusyId(null);
    }
  };

  if (!sessionToken) return null;

  return (
    <Panel>
      <SectionHeading
        eyebrow="YOUR CALL"
        title={blocked.length ? `Blocked players (${blocked.length})` : 'Blocked players'}
      />
      <Text style={styles.helper}>
        Blocking hides messages in both directions and prevents direct challenges. Matchmaking can still pair you.
      </Text>

      <Banner message={error} onDismiss={() => setError(null)} tone="error" />

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : blocked.length === 0 ? (
        <EmptyState
          detail="Block somebody from the chat room or from their player page."
          title="You have not blocked anyone"
        />
      ) : (
        <View style={styles.list}>
          {blocked.map((entry) => (
            <View key={entry.userId} style={styles.row}>
              <View style={styles.identity}>
                <View style={styles.nameRow}>
                  <TitleTag title={entry.title} />
                  <PlayerLink
                    name={entry.username}
                    numberOfLines={1}
                    style={styles.name}
                  />
                </View>
                <Text style={styles.meta}>
                  {entry.kind === 'bot' ? 'Engine' : 'Player'} · blocked{' '}
                  {new Date(entry.blockedAtUnixMs).toLocaleDateString()}
                </Text>
              </View>
              <GhostButton
                accessibilityLabel={`Unblock ${entry.username}`}
                compact
                disabled={busyId === entry.userId}
                label="UNBLOCK"
                onPress={() => lift(entry)}
              />
            </View>
          ))}
        </View>
      )}
    </Panel>
  );
}

const styles = themedSheet(() => ({
  helper: { ...type.body, color: colors.textMuted, marginTop: space.small },
  loading: { paddingVertical: space.large, alignItems: 'center' },
  list: { gap: 1, marginTop: space.small },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    paddingVertical: space.snug,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  // minWidth 0 so a long name wraps rather than pushing the button off the row.
  identity: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  name: { ...type.rowTitle, flexShrink: 1, color: colors.text },
  meta: { ...type.meta, color: colors.textFaint, marginTop: 2 },
  radius: { borderRadius: radius.medium },
}));
