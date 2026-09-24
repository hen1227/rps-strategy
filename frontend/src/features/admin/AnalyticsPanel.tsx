import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { adminStyles } from './adminStyles';
import { failureMessage } from '@/errors';
import { relativeTime } from '@/features/bots/relativeTime';
import type { AdminToken } from '@/hooks/useAdminToken';
import { readAnalytics, type Analytics, type DailyActivity } from '@/store/api/admin';
import { colors, radius, space, themedSheet, type } from '@/theme';
import { Badge, Banner, GhostButton, Panel, SectionHeading } from '@/ui/primitives';

// The overview: is anybody here, are they playing, and is anything broken.
//
// Those three questions are the whole brief, and every figure on this panel
// answers one of them. Nothing here exists because it was easy to compute —
// which is the failure mode of a dashboard, and the reason there is no chart of
// average game length by day of week.
//
// Two presentation decisions worth stating:
//
//   - **Live figures are separated from stored ones.** The top strip is the
//     process — who is connected right now — and everything below it is the
//     database. They go stale at completely different rates, and mixing them
//     produces a panel where "12 online" and "4,300 games" sit side by side
//     implying the same freshness.
//   - **The daily chart is bars drawn with Views.** Thirty values do not need a
//     charting library, an SVG, or a canvas — and an `<Svg>` over this panel
//     would swallow touches on iOS. Thirty flexed Views is the whole thing.

/** One number with a word under it. */
function Figure({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'gold' | 'live' | 'warn';
}) {
  return (
    <View style={styles.figure}>
      <Text
        style={[
          styles.figureValue,
          tone === 'gold' && styles.figureGold,
          tone === 'live' && styles.figureLive,
          tone === 'warn' && styles.figureWarn,
        ]}
      >
        {value}
      </Text>
      <Text style={styles.figureLabel}>{label}</Text>
      {detail ? <Text style={styles.figureDetail}>{detail}</Text> : null}
    </View>
  );
}

/**
 * Thirty days of play, as bars.
 *
 * Scaled to the busiest day rather than to a fixed ceiling, because the useful
 * reading is the shape — which days were quiet — and a fixed ceiling makes a
 * quiet month look like an empty one. A day with no games is a visible baseline
 * rather than nothing, so a gap reads as zero rather than as missing data; the
 * server guarantees there are no gaps.
 */
function DailyBars({ daily }: { daily: DailyActivity[] }) {
  const peak = Math.max(1, ...daily.map((day) => day.games));
  return (
    <View>
      <View style={styles.chart}>
        {daily.map((day) => {
          const height = Math.max(2, Math.round((day.games / peak) * 100));
          return (
            <View
              accessibilityLabel={`${new Date(day.dayUnixMs).toLocaleDateString()}: ${
                day.games
              } games, ${day.players} players`}
              accessibilityRole="image"
              key={day.dayUnixMs}
              style={styles.chartColumn}
            >
              <View style={[styles.chartBar, { height: `${height}%` }]} />
            </View>
          );
        })}
      </View>
      <View style={styles.chartAxis}>
        <Text style={styles.chartAxisLabel}>
          {daily.length ? new Date(daily[0].dayUnixMs).toLocaleDateString() : ''}
        </Text>
        <Text style={styles.chartAxisLabel}>peak {peak} games/day</Text>
        <Text style={styles.chartAxisLabel}>today</Text>
      </View>
    </View>
  );
}

export interface AnalyticsPanelProps {
  admin: AdminToken;
}

export default function AnalyticsPanel({ admin }: AnalyticsPanelProps) {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!admin.token) return;
    setLoading(true);
    try {
      setAnalytics(await readAnalytics(admin.token));
      setError(null);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [admin.token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const stored = analytics?.stored;
  const live = analytics?.live;
  const sanctions =
    (stored?.moderation.muted ?? 0) +
    (stored?.moderation.rankedBanned ?? 0) +
    (stored?.moderation.tournamentBanned ?? 0);

  return (
    <>
      <Panel style={adminStyles.panel}>
        <SectionHeading
          eyebrow="RIGHT NOW"
          title="The server"
          trailing={
            <GhostButton
              compact
              disabled={loading}
              label={loading ? 'LOADING' : 'REFRESH'}
              onPress={refresh}
            />
          }
        />
        {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
        <View style={styles.figureRow}>
          <Figure label="ONLINE" tone="live" value={String(live?.onlineCount ?? 0)} />
          <Figure label="GAMES LIVE" value={String(live?.liveGames ?? 0)} />
          <Figure label="ENGINES" value={String(live?.botsConnected ?? 0)} />
          <Figure
            detail="people practising against a browser bot"
            label="VS BOT"
            value={String(live?.botsPractising ?? 0)}
          />
          <Figure label="OPEN CHALLENGES" value={String(live?.openChallenges ?? 0)} />
          <Figure
            label="IN QUEUE"
            value={String(
              Object.values(live?.queued ?? {}).reduce<number>(
                (total, count) => total + (count ?? 0),
                0,
              ),
            )}
          />
        </View>
        {stored ? (
          <Text style={adminStyles.help}>
            Everything below was computed {relativeTime(stored.generatedAtUnixMs)}. The strip
            above is this process, read when you pressed refresh.
          </Text>
        ) : null}
      </Panel>

      <Panel style={adminStyles.panel}>
        <SectionHeading eyebrow="ANALYTICS" title="Players" />
        <View style={styles.figureRow}>
          <Figure label="ACCOUNTS" value={String(stored?.accounts.total ?? 0)} />
          <Figure
            detail="can sign in"
            label="REGISTERED"
            value={String(stored?.accounts.registered ?? 0)}
          />
          <Figure
            detail="have a profile page"
            label="DISCORD"
            tone="gold"
            value={String(stored?.accounts.discordLinked ?? 0)}
          />
          <Figure
            detail="played in the last week"
            label="ACTIVE"
            value={String(stored?.accounts.activeLast7Days ?? 0)}
          />
          <Figure label="ENGINES" value={String(stored?.accounts.bots ?? 0)} />
          <Figure label="NEW / 7D" value={String(stored?.accounts.newLast7Days ?? 0)} />
          <Figure label="NEW / 30D" value={String(stored?.accounts.newLast30Days ?? 0)} />
          <Figure
            label="DISABLED"
            tone={stored?.accounts.disabled ? 'warn' : undefined}
            value={String(stored?.accounts.disabled ?? 0)}
          />
        </View>
      </Panel>

      <Panel style={adminStyles.panel}>
        <SectionHeading eyebrow="ANALYTICS" title="Games" />
        <View style={styles.figureRow}>
          <Figure label="TOTAL" value={String(stored?.games.total ?? 0)} />
          <Figure label="LAST 24H" value={String(stored?.games.last24Hours ?? 0)} />
          <Figure label="LAST 7D" value={String(stored?.games.last7Days ?? 0)} />
          <Figure label="LAST 30D" value={String(stored?.games.last30Days ?? 0)} />
          <Figure
            detail="of all games ever"
            label="RANKED"
            value={String(stored?.games.ranked ?? 0)}
          />
          <Figure
            detail="median, last 30 days"
            label="MOVES"
            value={String(stored?.games.medianMoves ?? 0)}
          />
          <Figure
            detail="median, last 30 days"
            label="LENGTH"
            value={
              stored ? `${Math.round((stored.games.medianSeconds / 60) * 10) / 10}m` : '–'
            }
          />
        </View>
        {/*
          The one figure here that is about the game rather than the server. A
          persistent gap between the two is a first-move advantage, and this is
          the only place it would be visible.
        */}
        <Text style={adminStyles.help}>
          Red has won {stored?.games.redWins ?? 0}, Blue {stored?.games.blueWins ?? 0}, drawn{' '}
          {stored?.games.draws ?? 0}
        </Text>

        {stored?.daily?.length ? (
          <View style={styles.chartBlock}>
            <Text style={adminStyles.detailHeading}>GAMES A DAY, LAST 30</Text>
            <DailyBars daily={stored.daily} />
          </View>
        ) : null}

        {stored?.byMode?.length ? (
          <View style={styles.modeBlock}>
            <Text style={adminStyles.detailHeading}>BY MODE</Text>
            {stored.byMode.map((mode) => (
              <View key={mode.modeId} style={adminStyles.row}>
                <View style={adminStyles.rowCopy}>
                  <Text numberOfLines={1} style={adminStyles.rowName}>
                    {mode.modeName}
                  </Text>
                  <Text numberOfLines={1} style={adminStyles.rowMeta}>
                    {mode.players} players · {mode.ranked} ranked
                  </Text>
                </View>
                <Text style={adminStyles.rowNumber}>{mode.last7Days} / 7d</Text>
                <Text style={adminStyles.rowNumber}>{mode.games} total</Text>
              </View>
            ))}
          </View>
        ) : null}
      </Panel>

      <Panel style={adminStyles.panel}>
        <SectionHeading
          eyebrow="ANALYTICS"
          title="Events and moderation"
          trailing={
            sanctions > 0 ? <Badge label={`${sanctions} IN FORCE`} tone="live" /> : null
          }
        />
        <View style={styles.figureRow}>
          <Figure label="DRAFTS" value={String(stored?.tournaments.drafts ?? 0)} />
          <Figure label="OPEN" value={String(stored?.tournaments.registration ?? 0)} />
          <Figure
            label="RUNNING"
            tone={stored?.tournaments.inProgress ? 'live' : undefined}
            value={String(stored?.tournaments.inProgress ?? 0)}
          />
          <Figure label="FINISHED" value={String(stored?.tournaments.completed ?? 0)} />
          <Figure label="CANCELLED" value={String(stored?.tournaments.cancelled ?? 0)} />
          <Figure
            detail="in events not yet finished"
            label="ENTRANTS"
            value={String(stored?.tournaments.entrants ?? 0)}
          />
        </View>
        <View style={styles.figureRow}>
          <Figure
            label="MUTED"
            tone={stored?.moderation.muted ? 'warn' : undefined}
            value={String(stored?.moderation.muted ?? 0)}
          />
          <Figure
            label="RANKED BARRED"
            tone={stored?.moderation.rankedBanned ? 'warn' : undefined}
            value={String(stored?.moderation.rankedBanned ?? 0)}
          />
          <Figure
            label="EVENT BARRED"
            tone={stored?.moderation.tournamentBanned ? 'warn' : undefined}
            value={String(stored?.moderation.tournamentBanned ?? 0)}
          />
        </View>
        <Text style={adminStyles.help}>
          Active restrictions only. Expired restrictions remain on each player’s account.
        </Text>
      </Panel>
    </>
  );
}

const styles = themedSheet(() => ({
  figureRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.large,
    marginTop: space.medium,
  },
  figure: { minWidth: 84, maxWidth: 150, gap: 2 },
  figureValue: { ...type.cardTitle, color: colors.text },
  figureGold: { color: colors.goldBright },
  figureLive: { color: colors.accentBright },
  figureWarn: { color: colors.dangerSoft },
  figureLabel: { ...type.label, color: colors.textFaint },
  figureDetail: { ...type.meta, color: colors.textFaint, fontSize: 9 },

  chartBlock: { marginTop: space.medium },
  chart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: 88,
    marginTop: space.snug,
  },
  chartColumn: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  chartBar: {
    width: '100%',
    borderRadius: radius.small,
    backgroundColor: colors.accentBorder,
    minHeight: 2,
  },
  chartAxis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.tight,
  },
  chartAxisLabel: { ...type.meta, color: colors.textFaint, fontSize: 9 },

  modeBlock: { marginTop: space.medium },
}));
