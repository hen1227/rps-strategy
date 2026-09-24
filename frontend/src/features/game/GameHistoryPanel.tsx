import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import ResultLine from './ResultLine';
import { resultForPlayer } from './resultLabels';
import { failureMessage } from '@/errors';
import { relativeTime } from '@/features/bots/relativeTime';
import { useWideScreen } from '@/hooks/useBoardLayout';
import { gameReviewURL, links } from '@/navigation/links';
import { getGameHistory } from '@/store/api/accounts';
import { colors, radius, space, themedSheet, type } from '@/theme';
import type { GameRecord } from '@/types/protocol';
import CopyLinkButton from '@/ui/CopyLinkButton';
import ListRow from '@/ui/ListRow';
import { Banner, EmptyState, GhostButton, GhostLink, Panel, SectionHeading } from '@/ui/primitives';

// The games one account has played, newest first, each one a review away.
//
// The server has always kept this list — it is the same archive the review
// screen reads, and the bots page has drawn its own half of it for a while —
// but a person had no page that showed *their* games. So a game you wanted to
// look at again was findable only if the tab was still open.
//
// Keyed by account id rather than by "the signed-in player", so the panel is
// also the one a profile page for somebody else would use. That is why the
// copy in it never says "you": the row it draws is the same row either way.

/** How many games arrive at a time. A screenful, then more on request. */
const PAGE_SIZE = 10;

export interface GameHistoryPanelProps {
  /** Whose games. Any account id: this list is public, like the archive. */
  userId: string;
  eyebrow?: string;
  title?: string;
}

export default function GameHistoryPanel({
  userId,
  eyebrow = 'HISTORY',
  title = 'Recent games',
}: GameHistoryPanelProps) {
  // On a phone the two buttons go under the row rather than beside it: at 390
  // points a title and a meta line squeezed past them truncate to "Henry beat
  // Kestrel …", which loses the only thing the row is for.
  const wide = useWideScreen();
  const [games, setGames] = useState<GameRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Whether the archive has more to give. A short page is the end of it, which
  // is what keeps LOAD MORE from offering a request that returns nothing.
  const [more, setMore] = useState(false);

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    setLoading(true);
    getGameHistory(userId, PAGE_SIZE)
      .then((page) => {
        if (cancelled) return;
        setGames(page ?? []);
        setMore((page ?? []).length === PAGE_SIZE);
        setError(null);
      })
      .catch((caught) => {
        if (!cancelled) setError(failureMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const loadMore = async () => {
    setLoading(true);
    try {
      const page = await getGameHistory(userId, PAGE_SIZE, games.length);
      // Filtered against what is already here: a game that finished between
      // the two requests shifts the window, and the same game arriving twice
      // would give two rows the same React key.
      const known = new Set(games.map((game) => game.gameId));
      setGames([...games, ...(page ?? []).filter((game) => !known.has(game.gameId))]);
      setMore((page ?? []).length === PAGE_SIZE);
      setError(null);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Panel>
      <SectionHeading
        eyebrow={eyebrow}
        title={title}
        trailing={
          more && games.length > 0 ? (
            <GhostButton
              compact
              disabled={loading}
              label="LOAD MORE"
              onPress={loadMore}
            />
          ) : undefined
        }
      />
      <Text style={styles.help}>
        Replay your finished games or share a link.
      </Text>

      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}

      {games.length === 0 ? (
        loading ? (
          <Text style={styles.help}>Loading games…</Text>
        ) : (
          <EmptyState
            detail="Your finished online games will appear here."
            title="No games yet"
          />
        )
      ) : (
        <View style={styles.list}>
          {games.map((game, index) => (
            <GameHistoryRow
              divided={index > 0}
              game={game}
              key={game.gameId}
              viewerId={userId}
              wide={wide}
            />
          ))}
        </View>
      )}
    </Panel>
  );
}

const OUTCOME_LETTER = { win: 'W', loss: 'L', draw: 'D', unknown: '·' } as const;

/** One game: how it went for this player, what it was, and the two ways in. */
function GameHistoryRow({
  divided,
  game,
  viewerId,
  wide,
}: {
  divided: boolean;
  game: GameRecord;
  viewerId: string;
  wide: boolean;
}) {
  const outcome = resultForPlayer(game, viewerId);
  const opponent =
    game.redPlayer.userId === viewerId ? game.bluePlayer.username : game.redPlayer.username;

  const actions = (
    <View style={[styles.actions, !wide && styles.actionsStacked]}>
      <CopyLinkButton
        accessibilityLabel={`Copy a link to the game against ${opponent}`}
        url={gameReviewURL(game.gameId)}
      />
      <GhostLink
        accessibilityLabel={`Review the game against ${opponent}`}
        compact
        href={links.review(game.gameId)}
        label="REVIEW"
      />
    </View>
  );

  return (
    <ListRow
      detail={wide ? undefined : actions}
      divided={divided}
      // Stacked, the row is three lines tall, and a letter centred against all
      // three floats beside nothing. It belongs next to the line it grades.
      style={wide ? undefined : styles.rowStacked}
      leading={
        <View style={[styles.outcome, styles[outcome]]}>
          <Text style={[styles.outcomeText, styles[`${outcome}Text`]]}>
            {OUTCOME_LETTER[outcome]}
          </Text>
        </View>
      }
      meta={`${game.modeName} · ${game.ranked ? 'ranked' : 'casual'} · ${game.moveNumber} moves · ${relativeTime(game.finishedAtUnixMs)}`}
      title={<ResultLine record={game} />}
      trailing={wide ? actions : undefined}
    />
  );
}

const styles = themedSheet(() => ({
  help: { ...type.body, color: colors.textMuted, marginTop: space.small },
  list: { marginTop: space.small },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  actionsStacked: { marginTop: space.small, marginBottom: space.tight },
  rowStacked: { alignItems: 'flex-start', paddingTop: space.snug },

  outcome: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.small,
    borderWidth: 1,
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.borderSoft,
  },
  outcomeText: { ...type.label, color: colors.textFaint },
  win: { backgroundColor: colors.accentSurface, borderColor: colors.accentBorder },
  winText: { color: colors.accentSoft },
  loss: { backgroundColor: colors.dangerSurfaceQuiet, borderColor: colors.dangerBorder },
  lossText: { color: colors.dangerSoft },
  draw: {},
  drawText: { color: colors.textMuted },
  unknown: {},
  unknownText: {},
}));
