import { StyleSheet, Text, View } from 'react-native';

import BotIcon from '@/features/bots/BotIcon';
import { links } from '@/navigation/links';
import { botIconUrl } from '@/store/api/bots';
import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, type } from '@/theme';
import ListRow from '@/ui/ListRow';
import TitleTag from '@/ui/TitleTag';
import { Badge, GhostLink } from '@/ui/primitives';
import type { ModeID } from '@/types/game';
import type { LeaderboardEntry } from '@/types/protocol';

// The rows of a ladder, wherever one is shown.
//
// There were two of these: the Leaderboard page's paged board and the Bots
// page's top-eight card. They had already drifted — the card left the mode off
// the record line, so its ratings claimed to be about the whole game when they
// were about one mode of it — which is the drift a second copy always produces
// eventually. This is the one copy; what differs between the two places is how
// many rows they ask for and what heading sits above them.

/** The medal colours, best three only. Fourth place is a number, not a colour. */
const rankTone = (rank: number) => {
  if (rank === 1) return styles.rankFirst;
  if (rank <= 3) return styles.rankPodium;
  return undefined;
};

export interface LadderRowsProps {
  entries: LeaderboardEntry[];
  /** Set on a per-mode board, so a row knows not to name a mode again. */
  modeId?: ModeID | null;
  /** Draw a portrait beside the rank. Bots have one; people do not. */
  showPortraits?: boolean;
  /** Mark this account's own row, when it can appear here. */
  highlightUserId?: string;
}

export default function LadderRows({
  entries,
  modeId = null,
  showPortraits = false,
  highlightUserId,
}: LadderRowsProps) {
  const modes = useGameStore((state) => state.modes);
  const modeName = (id: string | undefined) => modes.find((mode) => mode.id === id)?.name ?? id;

  // On the combined board the rating is the account's strongest mode, so the row
  // has to say which one — a number with no scope attached invites the reader to
  // think it is one rating for the whole game, which this game does not have.
  // The counters beside it are lifetime totals, which do cover every mode.
  const record = (entry: LeaderboardEntry) => {
    const scope = modeId ? '' : `best in ${modeName(entry.modeId)} · `;
    const games = entry.gamesPlayed === 1 ? '1 game' : `${entry.gamesPlayed} games`;
    return `${scope}${entry.wins}W · ${entry.draws}D · ${entry.losses}L · ${games}`;
  };

  return (
    <View style={styles.list}>
      {entries.map((entry, index) => (
        <ListRow
          divided={index > 0}
          key={entry.userId}
          leading={
            <View style={styles.leading}>
              <Text style={[styles.rank, rankTone(entry.rank)]}>{entry.rank}</Text>
              {showPortraits ? (
                <BotIcon
                  name={entry.username}
                  size={28}
                  uri={botIconUrl(entry.userId, entry.iconSha256)}
                />
              ) : null}
            </View>
          }
          meta={record(entry)}
          style={entry.userId === highlightUserId ? styles.you : undefined}
          title={
            <View style={styles.nameRow}>
              <TitleTag title={entry.title} />
              <Text numberOfLines={1} style={styles.name}>
                {entry.username}
              </Text>
              {entry.userId === highlightUserId ? <Badge label="YOU" tone="accent" /> : null}
            </View>
          }
          trailing={
            <View style={styles.trailing}>
              <Text style={styles.elo}>{entry.elo}</Text>
              {/*
                The ladder was the site's one big list of names and every one of
                them was a dead end. A page exists for anybody who has signed in
                with Discord and for every engine, which between them is every
                row that can reach a board like this — an anonymous guest cannot
                be rated, so cannot be here.
              */}
              <GhostLink
                accessibilityLabel={`Open ${entry.username}'s page`}
                compact
                href={links.player(entry.username)}
                label="PROFILE"
              />
            </View>
          }
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: space.small },
  leading: { flexDirection: 'row', alignItems: 'center', gap: space.snug, minWidth: 34 },
  rank: { ...type.rowTitle, color: colors.textFaint, minWidth: 20, textAlign: 'right' },
  rankFirst: { color: colors.gold },
  rankPodium: { color: colors.goldMuted },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  name: { ...type.rowTitle, color: colors.text, flexShrink: 1 },
  you: {
    borderRadius: radius.small,
    backgroundColor: colors.accentSurfaceQuiet,
    paddingHorizontal: space.snug,
  },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: space.small },
  elo: { ...type.cardTitle, color: colors.textStrong, minWidth: 46, textAlign: 'right' },
});
