import { useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';

import {
  entrantHandle,
  isTiedStanding,
  rankLabel,
  tableHasResults,
} from '@/store/tournamentSelectors';
import type { Tournament } from '@/types/protocol';
import { colors, radius, themedSheet } from '@/theme';
import PlayerLink from '@/ui/PlayerLink';
import { Badge, EmptyState, Panel } from '@/ui/primitives';
import { playedRecord } from './tournamentBoard';

/**
 * A spotlight figure on one line, shrunk if it has to be.
 *
 * The aside gives each figure about 96 points on an iPad, and "100%" at this
 * size wants more: iOS broke it over two lines and dropped its label a line
 * below the other two. The web never breaks "100%" — no break is allowed
 * before a percent sign — so it keeps its own rendering rather than gaining an
 * ellipsis there.
 */
const FIT_ONE_LINE =
  Platform.OS === 'web'
    ? {}
    : ({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.6 } as const);

interface Props {
  tournament: Tournament;
  ownPlayerId?: number;
  children?: ReactNode;
  /** On a stacked layout, bring the chosen player's performance into view. */
  onInspect?: (offset: number) => void;
}

export default function TournamentOverview({
  tournament,
  ownPlayerId,
  children,
  onInspect,
}: Props) {
  const [width, setWidth] = useState(0);
  const offsets = useRef({ top: 0, performance: 0 });
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const focused =
    tournament.standings.find(
      (row) => row.playerId === (focusedId ?? ownPlayerId),
    ) ?? tournament.standings[0];
  const record = focused ? playedRecord(focused) : null;
  const wide = width >= 860;
  const narrowTable = width < 540;
  const hasByes = tournament.standings.some((row) => (row.byes ?? 0) > 0);
  const ranked = tableHasResults(tournament);
  const hasTies =
    ranked &&
    new Set(tournament.standings.map((row) => row.rank)).size <
      tournament.standings.length;
  const focusedTied = focused ? isTiedStanding(tournament, focused) : false;

  return (
    <View
      // A fresh pair of columns each time the layout switches, on a phone or
      // a tablet. The first layout is always the stacked one — the width is
      // not known until it has been measured — and iOS's layout engine keeps
      // each column's stacked height as its starting size when the row
      // arrives: `flex` there starts from a cached basis, not from zero, and
      // does not shrink. So the standings came out as wide as they had been
      // tall, and the spotlight beside them ran off an iPad's screen. The web
      // lays out afresh every time and never showed it.
      key={wide ? 'columns' : 'stacked'}
      onLayout={(event) => {
        setWidth(event.nativeEvent.layout.width);
        offsets.current.top = event.nativeEvent.layout.y;
      }}
      style={[styles.layout, wide && styles.columns]}
    >
      <Panel style={[styles.standings, wide && styles.standingsWide]}>
        <View style={styles.heading}>
          <View style={styles.headingCopy}>
            <Text style={styles.eyebrow}>THE TOURNAMENT TABLE</Text>
            <Text accessibilityRole="header" style={styles.title}>
              Standings
            </Text>
          </View>
          <Badge label={`${tournament.players.length} PLAYERS`} />
        </View>
        {tournament.standings.length === 0 ? (
          <EmptyState
            title="The table is taking shape"
            detail="Standings appear when the tournament starts."
          />
        ) : (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator
              contentContainerStyle={styles.tableScroll}
            >
              <View style={[styles.table, narrowTable && styles.mobileTable]}>
                <View style={[styles.row, styles.tableHeader]}>
                  <Text style={[styles.rank, styles.columnLabel]}>#</Text>
                  <Text
                    style={[
                      styles.player,
                      narrowTable && styles.mobilePlayer,
                      styles.columnLabel,
                    ]}
                  >
                    PLAYER
                  </Text>
                  {!narrowTable && (
                    <>
                      <Text
                        accessibilityLabel="Matches played"
                        style={[styles.stat, styles.columnLabel]}
                      >
                        P
                      </Text>
                      <Text
                        accessibilityLabel="Wins"
                        style={[styles.stat, styles.columnLabel]}
                      >
                        W
                      </Text>
                      <Text
                        accessibilityLabel="Draws"
                        style={[styles.stat, styles.columnLabel]}
                      >
                        D
                      </Text>
                      <Text
                        accessibilityLabel="Losses"
                        style={[styles.stat, styles.columnLabel]}
                      >
                        L
                      </Text>
                    </>
                  )}
                  <Text style={[styles.points, styles.columnLabel]}>PTS</Text>
                  <View style={styles.inspect} />
                </View>
                {tournament.standings.map((standing) => {
                  const selected = standing.playerId === focused?.playerId;
                  return (
                    <View
                      key={standing.playerId}
                      style={[styles.row, selected && styles.selectedRow]}
                    >
                      <Text
                        accessibilityLabel={
                          ranked && isTiedStanding(tournament, standing)
                            ? `Tied for ${standing.rank}`
                            : undefined
                        }
                        style={[
                          styles.rank,
                          ranked && standing.rank === 1 && styles.firstRank,
                        ]}
                      >
                        {rankLabel(tournament, standing)}
                      </Text>
                      <View
                        style={[
                          styles.player,
                          narrowTable && styles.mobilePlayer,
                        ]}
                      >
                        <PlayerLink
                          handle={entrantHandle(tournament, standing.playerId)}
                          name={standing.ign}
                          numberOfLines={1}
                          style={styles.playerName}
                        />
                        {narrowTable && (
                          <Text style={styles.mobileRecord}>
                            {standing.played} played · {standing.wins}W{' '}
                            {standing.draws}D {standing.losses}L
                          </Text>
                        )}
                        {standing.playerId === ownPlayerId && (
                          <Text style={styles.yours}>YOUR ENTRY</Text>
                        )}
                      </View>
                      {!narrowTable && (
                        <>
                          <Text style={styles.stat}>{standing.played}</Text>
                          <Text style={styles.stat}>{standing.wins}</Text>
                          <Text style={styles.stat}>{standing.draws}</Text>
                          <Text style={styles.stat}>{standing.losses}</Text>
                        </>
                      )}
                      <Text style={styles.points}>{standing.points}</Text>
                      <Pressable
                        accessibilityLabel={`Show performance for ${standing.ign}`}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        onPress={() => {
                          setFocusedId(standing.playerId);
                          if (!wide)
                            onInspect?.(
                              offsets.current.top + offsets.current.performance,
                            );
                        }}
                        style={({ pressed }) => [
                          styles.inspect,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text
                          style={[
                            styles.inspectText,
                            selected && styles.accent,
                          ]}
                        >
                          ›
                        </Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
            <Text style={styles.note}>
              3 points per win · 1 per draw
              {hasByes ? ' · Byes count as wins' : ''}
              {hasTies ? ' · T marks a shared place' : ''}
            </Text>
          </>
        )}
      </Panel>

      <View
        style={[styles.aside, wide && styles.asideWide]}
        onLayout={(event) => {
          offsets.current.performance = event.nativeEvent.layout.y;
        }}
      >
        <Panel style={styles.performance}>
          <Text style={styles.eyebrow}>PLAYER SPOTLIGHT</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Overall performance
          </Text>
          {focused && record ? (
            <>
              <View style={styles.focusIdentity}>
                <View style={styles.monogram}>
                  <Text style={styles.monogramText}>
                    {focused.ign.slice(0, 2).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.headingCopy}>
                  <PlayerLink
                    handle={entrantHandle(tournament, focused.playerId)}
                    name={focused.ign}
                    numberOfLines={2}
                    style={styles.focusName}
                  />
                  <Text style={styles.note}>
                    {focused.playerId === ownPlayerId
                      ? 'Your entry'
                      : !ranked
                        ? 'No results yet'
                        : focused.rank === 1
                          ? focusedTied
                            ? 'Tied for the lead'
                            : 'Leading the standings'
                          : focusedTied
                            ? `Tied for #${focused.rank}`
                            : `Ranked #${focused.rank}`}{' '}
                    · This tournament
                  </Text>
                </View>
              </View>
              <View style={styles.metrics}>
                <View style={styles.metric}>
                  <Text style={styles.bigNumber} {...FIT_ONE_LINE}>
                    {focused.points}
                  </Text>
                  <Text style={styles.metricLabel}>POINTS</Text>
                </View>
                <View style={styles.metric}>
                  <Text style={styles.bigNumber} {...FIT_ONE_LINE}>
                    {!ranked
                      ? '–'
                      : focusedTied
                        ? `T${focused.rank}`
                        : `#${focused.rank}`}
                  </Text>
                  <Text style={styles.metricLabel}>RANK</Text>
                </View>
                <View style={styles.metric}>
                  <Text style={styles.bigNumber} {...FIT_ONE_LINE}>
                    {record.winRate === null ? '—' : `${record.winRate}%`}
                  </Text>
                  <Text style={styles.metricLabel}>WIN RATE</Text>
                </View>
              </View>
              <View style={styles.recordHeader}>
                <Text style={styles.recordTitle}>Match record</Text>
                <Text style={styles.note}>{focused.played} played</Text>
              </View>
              <View
                accessibilityLabel={`${record.wins} ${record.wins === 1 ? 'win' : 'wins'}, ${record.draws} ${record.draws === 1 ? 'draw' : 'draws'}, ${record.losses} ${record.losses === 1 ? 'loss' : 'losses'}`}
                style={styles.recordBar}
              >
                {record.wins > 0 && (
                  <View style={[styles.winBar, { flex: record.wins }]} />
                )}
                {record.draws > 0 && (
                  <View style={[styles.drawBar, { flex: record.draws }]} />
                )}
                {record.losses > 0 && (
                  <View style={[styles.lossBar, { flex: record.losses }]} />
                )}
              </View>
              <View style={styles.recordLegend}>
                <Text style={styles.legend}>
                  <Text style={styles.accent}>●</Text> {record.wins}{' '}
                  {record.wins === 1 ? 'win' : 'wins'}
                </Text>
                <Text style={styles.legend}>
                  <Text style={styles.drawText}>●</Text> {record.draws}{' '}
                  {record.draws === 1 ? 'draw' : 'draws'}
                </Text>
                <Text style={styles.legend}>
                  <Text style={styles.lossText}>●</Text> {record.losses}{' '}
                  {record.losses === 1 ? 'loss' : 'losses'}
                </Text>
              </View>
              {(focused.byes ?? 0) > 0 && (
                <Text style={styles.note}>
                  {focused.byes} bye{focused.byes === 1 ? '' : 's'} awarded ·
                  excluded from match record and win rate
                </Text>
              )}
              {focused.eliminatedInRound && (
                <Text style={styles.note}>
                  Eliminated in round {focused.eliminatedInRound}
                </Text>
              )}
              {focused.played === 0 && (
                <Text style={styles.note}>
                  Waiting for the first completed match.
                </Text>
              )}
            </>
          ) : (
            <EmptyState
              title="Every result counts"
              detail="Player performance appears here once standings are available."
            />
          )}
        </Panel>
        {children}
      </View>
    </View>
  );
}

const styles = themedSheet(() => ({
  layout: { gap: 16 },
  columns: { flexDirection: 'row', alignItems: 'flex-start' },
  standings: { padding: 20, minWidth: 0 },
  standingsWide: { flex: 1.6 },
  performance: {
    padding: 20,
    minWidth: 0,
    borderTopWidth: 3,
    borderTopColor: colors.accent,
  },
  aside: { gap: 16, minWidth: 0 },
  asideWide: { flex: 1 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headingCopy: { flex: 1, minWidth: 0 },
  // Neutral, like every other eyebrow: green is for the button worth pressing.
  eyebrow: {
    color: colors.textFaint,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  title: {
    color: colors.textStrong,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  tableScroll: { flexGrow: 1 },
  table: { minWidth: 440, flex: 1 },
  mobileTable: { minWidth: 0 },
  mobileRecord: { color: colors.textMuted, fontSize: 10, marginTop: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 54,
    paddingHorizontal: 8,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  tableHeader: { minHeight: 40, marginTop: 16, borderTopWidth: 0 },
  selectedRow: {
    backgroundColor: colors.accentSurfaceQuiet,
    borderRadius: radius.small,
  },
  // Wide enough for a shared place past ninth, "T10".
  rank: { width: 40, color: colors.textMuted, fontSize: 16, fontWeight: '800' },
  firstRank: { color: colors.gold },
  player: { flex: 1, minWidth: 140, paddingRight: 8 },
  mobilePlayer: { minWidth: 100 },
  playerName: { color: colors.textStrong, fontSize: 15, fontWeight: '800' },
  yours: {
    color: colors.accent,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
    marginTop: 3,
  },
  stat: {
    width: 32,
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  points: {
    width: 48,
    textAlign: 'center',
    color: colors.accentBright,
    fontSize: 20,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  columnLabel: {
    color: colors.textDim,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.7,
  },
  inspect: {
    width: 36,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inspectText: { color: colors.textDim, fontSize: 19 },
  note: { color: colors.textMuted, fontSize: 11, lineHeight: 18, marginTop: 8 },
  focusIdentity: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    marginTop: 26,
  },
  monogram: {
    width: 48,
    height: 48,
    borderRadius: radius.medium,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSurfaceStrong,
  },
  monogramText: { color: colors.accentBright, fontSize: 18, fontWeight: '900' },
  focusName: { color: colors.textStrong, fontSize: 19, fontWeight: '900' },
  metrics: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 24,
    marginTop: 16,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.borderSoft,
  },
  metric: { flex: 1 },
  bigNumber: {
    color: colors.textStrong,
    fontSize: 32,
    fontWeight: '900',
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  metricLabel: {
    color: colors.textDim,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: 5,
  },
  recordHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: 18,
  },
  recordTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
  recordBar: {
    flexDirection: 'row',
    gap: 3,
    height: 12,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: colors.surfaceRaised,
    marginTop: 12,
  },
  winBar: { backgroundColor: colors.accent },
  drawBar: { backgroundColor: colors.gold },
  lossBar: { backgroundColor: colors.live },
  recordLegend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    marginTop: 12,
  },
  legend: { color: colors.textMuted, fontSize: 12 },
  accent: { color: colors.accentBright },
  drawText: { color: colors.gold },
  lossText: { color: colors.live },
  pressed: { opacity: 0.65 },
}));
