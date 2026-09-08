import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import LadderPodium, { PODIUM_SIZE } from './LadderPodium';
import LadderRows from './LadderRows';
import { failureMessage } from '@/errors';
import BotHistoryFeed from '@/features/bots/BotHistoryFeed';
import { useWideScreen } from '@/hooks/useBoardLayout';
import { leaderboard, type LeaderboardKind } from '@/store/api/leaderboard';
import { useGameStore } from '@/store/gameStore';
import { colors, contentWidth, space, type } from '@/theme';
import ScreenShell from '@/ui/ScreenShell';
import TabBar from '@/ui/TabBar';
import { Banner, EmptyState, GhostButton, Panel, SectionHeading } from '@/ui/primitives';
import type { ModeID } from '@/types/game';
import type { LeaderboardEntry } from '@/types/protocol';

// The ladder: one mode at a time, bots then people.
//
// **The mode is a tab.** It used to be a column, all modes side by side, on the
// argument that standing two boards next to each other is what shows a rating is
// per mode rather than asserting it. That argument was right about the claim and
// wrong about the page: at three modes it was three narrow columns of ten rows,
// each of them too tight for anything but a name and a number, and a fourth mode
// would have made them unreadable. A tab has room for a podium, a record, and
// who wrote the engine — and it says the same thing, because you cannot read
// this page without picking a mode first. The tab is in the URL, so a board can
// be linked to; see `links.leaderboard`.
//
// **Bots and people are not a tab.** They stack, both boards visible at once.
// The two ratings are not measuring the same competition — a bot's rating moves
// in ranked bot-versus-bot series, bot-versus-human is unranked in both
// directions, and they are not even the same arithmetic: a person's Elo is a
// per-game transfer, a bot's is a fit over every pair of bots' head-to-head
// record, because an engine's author picks its opponents and a transfer system
// pays out for beating a fresh account. Ranking them together would read as a
// claim nobody made, but behind a tab that separation reads as a question —
// pick a population — when it is really two answers. Bots go first: the engines
// play each other constantly, and the games behind their ranking are listed
// underneath.

/** Rows fetched per board. The server's own ceiling is 200. */
const BOARD_LIMIT = 50;
/**
 * Rows shown under the podium before asking.
 *
 * Ten *including* the three on the podium, so the fold is at the same place it
 * has always been rather than at thirteen because the top of the board grew a
 * second representation.
 */
const COLLAPSED_ROWS = 10;

const SECTIONS: { kind: LeaderboardKind; title: string; help: string }[] = [
  {
    kind: 'bot',
    title: 'Best bots',
    help: 'Engines, ranked by their games against each other. Every row is a page.',
  },
  {
    kind: 'human',
    title: 'Best players',
    help: 'People, ranked by ranked games in this mode.',
  },
];

export interface LeaderboardScreenProps {
  /** The mode from the URL, if it named one. */
  mode?: string;
  /** Whether the query string is readable yet. See `useSettledSearchParams`. */
  settled?: boolean;
  /** Called to put the chosen mode in the address. */
  onChooseMode?: (modeId: ModeID) => void;
}

export default function LeaderboardScreen({
  mode,
  onChooseMode,
  settled = true,
}: LeaderboardScreenProps) {
  const modes = useGameStore((state) => state.modes);
  const accountId = useGameStore((state) => state.accountId);
  const isWide = useWideScreen();

  // A retired mode accepts no new games, so a tab for it would be a museum
  // piece standing beside the live boards.
  const ladderModes = useMemo(() => modes.filter((entry) => entry.playable !== false), [modes]);

  // The URL's mode when it names a live one, and the first tab otherwise. A
  // hand-typed or stale `?mode=` lands on a board rather than on a blank, the
  // same way `/admin?tab=` does.
  const linked = ladderModes.find((entry) => entry.id === mode)?.id;
  const activeMode = linked ?? ladderModes[0]?.id;

  const [boards, setBoards] = useState<Record<LeaderboardKind, LeaderboardEntry[]>>({
    bot: [],
    human: [],
  });
  const [expanded, setExpanded] = useState<Record<LeaderboardKind, boolean>>({
    bot: false,
    human: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeMode) return;
    setLoading(true);
    setError(null);
    try {
      // Both boards of the open tab and neither of the others, for the reason
      // the admin screen gives about its own tabs: fetching every mode would be
      // six requests to look at two, and the four nobody is looking at would go
      // stale while showing numbers.
      //
      // One banner if either fails: these are the same route on the same
      // server, so a failure is the ladder being down rather than one board of
      // it being unavailable.
      const [bots, humans] = await Promise.all(
        SECTIONS.map((section) =>
          leaderboard({ kind: section.kind, limit: BOARD_LIMIT, modeId: activeMode }),
        ),
      );
      setBoards({ bot: bots ?? [], human: humans ?? [] });
    } catch (caught) {
      setError(failureMessage(caught));
      setBoards({ bot: [], human: [] });
    } finally {
      setLoading(false);
    }
  }, [activeMode]);

  // Held until the query string is readable, because until then this page does
  // not know which board it is: fetching first would download the first mode's
  // on the way to every link that names another.
  useEffect(() => {
    if (settled) load();
  }, [load, settled]);

  // Switching tabs collapses both boards again. An expanded board is a request
  // for more of *that* board, and carrying it across would open the next mode
  // at fifty rows because somebody wanted fifty of the last one.
  const chooseMode = (nextMode: ModeID) => {
    if (nextMode === activeMode) return;
    setExpanded({ bot: false, human: false });
    onChooseMode?.(nextMode);
  };

  const modeName = ladderModes.find((entry) => entry.id === activeMode)?.name ?? 'this mode';

  return (
    <ScreenShell width={contentWidth.page}>
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}

      <Panel>
        <SectionHeading eyebrow="THE LADDER" title="Who is winning" />
        <Text style={styles.help}>
          Every rating in this game belongs to one mode. Pick the one you play.
        </Text>
        {/*
          One tab per playable mode. `fill` because there are three of them and
          a wrapping row of three is a segmented control; a server that publishes
          a dozen modes would wrap, which is why the bar handles that itself.
        */}
        {activeMode ? (
          <View style={styles.tabs}>
            <TabBar
              accessibilityLabel="Game mode"
              fill={isWide}
              onChange={chooseMode}
              options={ladderModes.map((entry) => ({
                value: entry.id,
                label: entry.name,
                eyebrow: entry.shortCode,
              }))}
              value={activeMode}
            />
          </View>
        ) : null}
      </Panel>

      {SECTIONS.map((section) => {
        const entries = boards[section.kind];
        const isExpanded = expanded[section.kind];
        const shown = isExpanded ? entries : entries.slice(0, COLLAPSED_ROWS);
        return (
          <Panel key={section.kind}>
            <SectionHeading
              eyebrow={`${modeName.toUpperCase()} · THE LADDER`}
              title={section.title}
              trailing={
                entries.length > COLLAPSED_ROWS ? (
                  <GhostButton
                    compact
                    label={isExpanded ? `TOP ${COLLAPSED_ROWS}` : `ALL ${entries.length}`}
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
            ) : entries.length === 0 ? (
              <EmptyState
                detail={
                  section.kind === 'bot'
                    ? `No bot has finished a ranked ${modeName} game yet.`
                    : `Nobody has finished a ranked ${modeName} game yet. Be first.`
                }
                title="Nothing to rank"
              />
            ) : (
              <>
                <LadderPodium
                  entries={entries}
                  highlightUserId={accountId}
                  kind={section.kind}
                  wide={isWide}
                />
                {/*
                  The rest of the board. The three on the podium are dropped
                  rather than repeated: a page that says the same thing twice
                  reads as a page that has lost track of what it said.
                */}
                {shown.length > PODIUM_SIZE ? (
                  <LadderRows
                    entries={shown.slice(PODIUM_SIZE)}
                    highlightUserId={accountId}
                    modeId={activeMode}
                    showPortraits={section.kind === 'bot'}
                    wide={isWide}
                  />
                ) : null}
              </>
            )}
          </Panel>
        );
      })}

      {/*
        The games behind the board above, in the mode the tab names — so the
        history under a per-mode ladder is the history of that ladder rather
        than of the whole site.
      */}
      <BotHistoryFeed
        botUserIds={boards.bot.map((entry) => entry.userId)}
        emptyDetail="Anybody can pit two engines against each other from the Bots page."
        eyebrow="MATCH HISTORY"
        modeId={activeMode ?? null}
        title={`Games behind the ${modeName} ladder`}
      />
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  help: { ...type.body, color: colors.textMuted, marginTop: space.small },
  tabs: { marginTop: space.medium },
  loading: { paddingVertical: space.xlarge, alignItems: 'center' },
});
