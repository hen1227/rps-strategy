import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { failureMessage } from '@/errors';
import { namedResultLabel } from '@/features/game/resultLabels';
import { links } from '@/navigation/links';
import { botMatches, type BotMatch } from '@/store/api/bots';
import { colors, space, type } from '@/theme';
import ListRow from '@/ui/ListRow';
import { Badge, Banner, EmptyState, GhostButton, Panel, SectionHeading } from '@/ui/primitives';
import type { ModeID } from '@/types/game';

// The games two bots have already played.
//
// One component wherever the question is asked: the ladder lists the games of the
// bots it just ranked, and an unscoped list is every recent bot-versus-bot game.
// The difference between those two is the `botUserIds` it is given, which is the
// whole reason this is not two lists — a second copy would be a second place for
// "what counts as a bot game" to be decided.
//
// Every row opens the review, because that is what a finished game is for here:
// the moves are archived as PGN, the opening plies a series dealt are tagged as
// book, and the review screen already knows how to read both.

/** How long a list of games can go without being wrong about a live series. */
const REFRESH_MS = 20_000;

const relativeTime = (unixMs: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - unixMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(unixMs).toLocaleDateString();
};

/** The name of whoever won, or null on a draw. */
const winnerName = (match: BotMatch) => {
  if (match.winnerUserId === match.redPlayer.userId) return match.redPlayer.username;
  if (match.winnerUserId === match.bluePlayer.userId) return match.bluePlayer.username;
  return null;
};

export interface BotMatchHistoryProps {
  /**
   * Bot account ids to keep to. Omitted lists every bot's games; the ladder
   * passes the bots it ranked.
   */
  botUserIds?: string[];
  /** One mode's games, so a per-mode ladder is not followed by other modes. */
  modeId?: ModeID | null;
  limit?: number;
  eyebrow?: string;
  title?: string;
  /** What to say when there is nothing yet. */
  emptyDetail?: string;
}

export default function BotMatchHistory({
  botUserIds,
  modeId = null,
  limit = 10,
  eyebrow = 'PAST GAMES',
  title = 'Recent bot games',
  emptyDetail = 'Pit two engines against each other and their games show up here.',
}: BotMatchHistoryProps) {
  const router = useRouter();
  const [matches, setMatches] = useState<BotMatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // The ids are joined into one string rather than depended on as an array, so a
  // parent that rebuilds an equal list on every render does not restart the
  // effect on every render with it.
  const scope = (botUserIds ?? []).join(',');

  const load = useCallback(async () => {
    try {
      const found = await botMatches({
        botUserIds: scope ? scope.split(',') : [],
        limit,
        modeId,
      });
      setMatches(found ?? []);
      setError(null);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setLoaded(true);
    }
  }, [limit, modeId, scope]);

  useEffect(() => {
    load();
    // A running series finishes a game every few minutes, so this list goes
    // stale on its own even when nobody touches the page.
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <Panel>
      <SectionHeading eyebrow={eyebrow} title={title} />
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
      {matches.length === 0 ? (
        loaded ? (
          <EmptyState detail={emptyDetail} title="No bot games yet" />
        ) : (
          <Text style={styles.help}>Loading…</Text>
        )
      ) : (
        <View style={styles.list}>
          {matches.map((match, index) => (
            <ListRow
              divided={index > 0}
              key={match.gameId}
              meta={`${match.modeName} · ${match.moveNumber} moves · ${relativeTime(
                match.finishedAtUnixMs,
              )}`}
              title={
                <View style={styles.titleRow}>
                  <Text numberOfLines={1} style={styles.result}>
                    {namedResultLabel({
                      blueName: match.bluePlayer.username,
                      endReason: match.endReason,
                      redName: match.redPlayer.username,
                      winnerName: winnerName(match),
                    })}
                  </Text>
                  {match.seriesId ? <Badge label="SERIES" tone="accent" /> : null}
                </View>
              }
              trailing={
                <GhostButton
                  accessibilityLabel={`Review ${match.redPlayer.username} versus ${match.bluePlayer.username}`}
                  compact
                  label="REVIEW"
                  onPress={() => router.push(links.review(match.gameId))}
                />
              }
            />
          ))}
        </View>
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  help: { ...type.body, color: colors.textFaint, marginTop: space.small },
  list: { marginTop: space.small },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  result: { ...type.rowTitle, color: colors.text, flexShrink: 1 },
});
