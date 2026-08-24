import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import LadderRows from './LadderRows';
import { failureMessage } from '@/errors';
import BotHistoryFeed from '@/features/bots/BotHistoryFeed';
import { useWideScreen } from '@/hooks/useBoardLayout';
import { leaderboard, type LeaderboardKind } from '@/store/api/leaderboard';
import { useGameStore } from '@/store/gameStore';
import { colors, contentWidth, space, type } from '@/theme';
import ScreenShell from '@/ui/ScreenShell';
import { Banner, EmptyState, GhostButton, Panel, SectionHeading } from '@/ui/primitives';
import type { ModeDefinition } from '@/types/game';
import type { LeaderboardEntry } from '@/types/protocol';

// The ladder: four boards on one page, and neither axis of them is a tab.
//
// Bots and people are separate boards because the ratings are not measuring the
// same competition: a bot's rating moves in ranked bot-versus-bot series, and
// bot-versus-human is unranked in both directions. They are not even the same
// arithmetic — a person's Elo is a per-game transfer, a bot's rating is a fit
// over every pair of bots' head-to-head record, because an engine's author picks
// its opponents and a transfer system pays out for beating a fresh account. A bot
// with too few opponents, or one that only plays engines its own author entered,
// is not on the board at all.
// Ranking them together would read as a claim nobody made. Behind a tab, though, that separation read as a
// question — pick a population — when it is really two answers. So they stack,
// bots first: the engines play each other constantly, and the games behind
// their ranking are listed underneath.
//
// The modes sit side by side for the same reason. A rating in this game *is*
// per mode, so Total War and Infiltration are two boards rather than two views
// of one, and standing them next to each other is what shows that instead of
// asserting it.

/** Rows fetched per board. The server's own ceiling is 200. */
const BOARD_LIMIT = 50;
/** Rows shown per board before asking. Four full boards is a page nobody reads. */
const COLLAPSED_ROWS = 10;

const SECTIONS: { kind: LeaderboardKind; title: string; help: string }[] = [
  {
    kind: 'bot',
    title: 'Best bots',
    help: 'Bot ratings come from the head-to-head record between every pair of bots, solved all at once, not from points won and lost per game. Playing one opponent over and over stops counting, a bot needs at least two opponents to be ranked at all, and beating engines the board has already placed is what moves a rating. Anybody can start a series from the Bots page. Games against people are unranked.',
  },
  {
    kind: 'human',
    title: 'Best players',
    help: 'Ranked games only, and named accounts only — every browser owns a Guest, and a page of Guests is not a ladder.',
  },
];

const boardKey = (kind: LeaderboardKind, modeId: string) => `${kind}:${modeId}`;

export default function LeaderboardScreen() {
  const modes = useGameStore((state) => state.modes);
  const accountId = useGameStore((state) => state.accountId);
  const isWide = useWideScreen();

  // A retired mode accepts no new games, so a column for it would be a museum
  // piece standing beside the live boards.
  const ladderModes = useMemo(() => modes.filter((mode) => mode.playable !== false), [modes]);

  const [boards, setBoards] = useState<Record<string, LeaderboardEntry[]>>({});
  const [expanded, setExpanded] = useState<Record<LeaderboardKind, boolean>>({
    bot: false,
    human: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Joined rather than depended on as an array, so a store update that rebuilds
  // an equal mode list does not refetch every board with it.
  const modeIds = ladderModes.map((mode) => mode.id).join(',');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const ids = modeIds ? modeIds.split(',') : [];
    try {
      // All of them together, and one banner if any fails: these are the same
      // route on the same server, so a failure is the ladder being down rather
      // than one board of it being unavailable.
      const loaded = await Promise.all(
        SECTIONS.flatMap((section) =>
          ids.map(async (modeId) => {
            const entries = await leaderboard({ kind: section.kind, limit: BOARD_LIMIT, modeId });
            return [boardKey(section.kind, modeId), entries] as const;
          }),
        ),
      );
      setBoards(Object.fromEntries(loaded));
    } catch (caught) {
      setError(failureMessage(caught));
      setBoards({});
    } finally {
      setLoading(false);
    }
  }, [modeIds]);

  useEffect(() => {
    load();
  }, [load]);

  // Every bot this page just ranked, in either mode. The feed below is not
  // filtered by mode any more, because both modes are on the page now and every
  // card names the mode it was played in.
  const rankedBots = ladderModes.flatMap((mode) => boards[boardKey('bot', mode.id)] ?? []);

  return (
    <ScreenShell width={contentWidth.page}>
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}

      {SECTIONS.map((section) => {
        const isExpanded = expanded[section.kind];
        const hasMore = ladderModes.some(
          (mode) => (boards[boardKey(section.kind, mode.id)]?.length ?? 0) > COLLAPSED_ROWS,
        );
        return (
          <Panel key={section.kind}>
            <SectionHeading
              eyebrow="THE LADDER"
              title={section.title}
              trailing={
                hasMore ? (
                  <GhostButton
                    compact
                    label={isExpanded ? `TOP ${COLLAPSED_ROWS}` : 'SHOW ALL'}
                    onPress={() =>
                      setExpanded((current) => ({ ...current, [section.kind]: !isExpanded }))
                    }
                  />
                ) : undefined
              }
            />
            <Text style={styles.help}>{section.help}</Text>

            {loading ? (
              <View style={styles.loading}>
                <ActivityIndicator color={colors.accentBright} />
              </View>
            ) : (
              <View style={[styles.columns, isWide && styles.columnsWide]}>
                {ladderModes.map((mode, index) => (
                  <ModeBoard
                    divided={isWide && index > 0}
                    entries={boards[boardKey(section.kind, mode.id)] ?? []}
                    highlightUserId={accountId}
                    key={mode.id}
                    kind={section.kind}
                    mode={mode}
                    rows={isExpanded ? BOARD_LIMIT : COLLAPSED_ROWS}
                  />
                ))}
              </View>
            )}
          </Panel>
        );
      })}

      <BotHistoryFeed
        botUserIds={rankedBots.map((entry) => entry.userId)}
        emptyDetail="Anybody can pit two engines against each other from the Bots page."
        eyebrow="MATCH HISTORY"
        title="Games behind the ladder"
      />
    </ScreenShell>
  );
}

interface ModeBoardProps {
  entries: LeaderboardEntry[];
  highlightUserId?: string;
  kind: LeaderboardKind;
  mode: ModeDefinition;
  /** How many rows to draw of however many were fetched. */
  rows: number;
  /** Draw the rule between this column and the one before it. */
  divided?: boolean;
}

// One mode's board. The mode is named over the rows rather than in the panel
// heading, because two of these share a heading now.
function ModeBoard({ divided, entries, highlightUserId, kind, mode, rows }: ModeBoardProps) {
  return (
    <View style={[styles.column, divided && styles.columnDivided]}>
      <Text style={styles.columnLabel}>{mode.name.toUpperCase()}</Text>
      {entries.length === 0 ? (
        <EmptyState
          detail={
            kind === 'bot'
              ? `No bot has finished a ranked ${mode.name} game yet.`
              : `Nobody has finished a ranked ${mode.name} game yet. Be first.`
          }
          title="Nothing to rank"
        />
      ) : (
        <LadderRows
          entries={entries.slice(0, rows)}
          highlightUserId={highlightUserId}
          modeId={mode.id}
          showPortraits={kind === 'bot'}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  help: { ...type.body, color: colors.textMuted, marginTop: space.small },
  loading: { paddingVertical: space.xlarge, alignItems: 'center' },

  // Side by side where there is room, stacked where there is not. `minWidth: 0`
  // is what lets a long username truncate instead of widening its column, and
  // the columns stretch rather than sitting at the top so the rule between them
  // runs the height of the taller board instead of stopping at the shorter one.
  columns: { gap: space.medium, marginTop: space.medium },
  columnsWide: { flexDirection: 'row', gap: space.large },
  column: { flex: 1, minWidth: 0 },
  columnDivided: {
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSoft,
    paddingLeft: space.large,
  },

  columnLabel: { ...type.rowTitle, color: colors.accentSoft, letterSpacing: 0.6 },
});
