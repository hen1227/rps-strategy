import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { failureMessage } from '@/errors';
import { getReports, resolveReport } from '@/store/api/moderation';
import { links } from '@/navigation/links';
import { colors, radius, space, themedSheet, type } from '@/theme';
import type { AdminToken } from '@/hooks/useAdminToken';
import {
  Badge,
  Banner,
  EmptyState,
  GhostButton,
  GhostLink,
  Panel,
  SectionHeading,
} from '@/ui/primitives';
import TabBar from '@/ui/TabBar';
import type { Report, ReportStatus } from '@/types/protocol';

import { adminStyles } from './adminStyles';

// The report queue.
//
// This is the half of reporting that decides whether the other half was worth
// building. A report button with nothing behind it is a button that teaches
// people reporting does nothing — so the queue opens on the unread pile, shows
// what was actually said, and puts the two decisions one press away.
//
// # Why it does not sanction from here
//
// Reading a report and acting on an account are separate, and this panel only
// does the first. "Actioned" records that the host agreed and dealt with it; the
// dealing itself happens on the Players tab, where the account is in front of
// them along with everything else about it — its history, its other sanctions,
// and whoever else has reported it. A mute button on a report row would be a
// sanction placed on the strength of one person's account of an incident, with
// none of that context on screen.
//
// What this panel does instead is make the context findable: every row links to
// the reported player's page, and says how many other open reports name them.

const FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'actioned', label: 'Actioned' },
  { id: 'dismissed', label: 'Dismissed' },
  { id: '', label: 'All' },
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  harassment: 'Harassment',
  hate: 'Hate speech',
  sexual: 'Sexual content',
  spam: 'Spam',
  cheating: 'Cheating',
  name: 'Offensive name',
  other: 'Other',
};

/** The categories that should not sit behind a queue of spam reports. */
const URGENT = new Set(['hate', 'sexual', 'harassment']);

const when = (unixMs: number) => new Date(unixMs).toLocaleString();

export interface ReportsPanelProps {
  admin: AdminToken;
}

export default function ReportsPanel({ admin }: ReportsPanelProps) {
  const [status, setStatus] = useState<ReportStatus | ''>('open');
  const [reports, setReports] = useState<Report[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (applied: ReportStatus | '' = status) => {
      if (!admin.token) return;
      try {
        const page = await getReports(admin.token, applied);
        setReports(page?.reports ?? []);
        setOpenCount(page?.open ?? 0);
      } catch (caught) {
        setError(failureMessage(caught));
      }
    },
    [admin.token, status],
  );

  useEffect(() => {
    void refresh(status);
  }, [refresh, status]);

  const settle = async (report: Report, next: ReportStatus) => {
    if (!admin.token) return;
    setBusyId(report.reportId);
    setError(null);
    try {
      await resolveReport(admin.token, report.reportId, next);
      await refresh(status);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Panel style={adminStyles.panel}>
      <SectionHeading
        eyebrow="MODERATION"
        title={openCount > 0 ? `Reports (${openCount} open)` : 'Reports'}
      />
      <Text style={styles.helper}>
        Review the report, open the player to take action, then mark it resolved.
      </Text>

      <View style={styles.filters}>
        <TabBar
          accessibilityLabel="Which reports to show"
          onChange={(next) => setStatus(next as ReportStatus | '')}
          options={FILTERS.map((entry) => ({ value: entry.id, label: entry.label }))}
          value={status}
        />
      </View>

      <Banner message={error} onDismiss={() => setError(null)} tone="error" />

      {reports.length === 0 ? (
        <EmptyState
          detail={
            status === 'open'
              ? "No reports waiting for review."
              : 'Nothing in this pile.'
          }
          title="No reports"
        />
      ) : (
        <View style={adminStyles.list}>
          {reports.map((report) => {
            const open = expanded === report.reportId;
            return (
              <View key={report.reportId}>
                <Pressable
                  accessibilityLabel={`Report against ${report.targetName}`}
                  accessibilityRole="button"
                  onPress={() => setExpanded(open ? null : report.reportId)}
                  style={({ pressed }) => [adminStyles.row, pressed && styles.pressed]}
                >
                  <View style={adminStyles.rowCopy}>
                    <View style={styles.titleRow}>
                      <Text numberOfLines={1} style={adminStyles.rowName}>
                        {report.targetName || 'Unnamed'}
                      </Text>
                      <Badge
                        label={CATEGORY_LABELS[report.category] ?? report.category}
                        tone={URGENT.has(report.category) ? 'warm' : 'neutral'}
                      />
                      {report.targetIsDisabled ? (
                        <Badge label="DISABLED" tone="neutral" />
                      ) : null}
                      {/*
                        The number that changes the decision. A third report
                        about one person is not the same call as a first, and it
                        is the one thing a queue sorted by time will not tell
                        you.
                      */}
                      {(report.targetOpenReports ?? 0) > 1 ? (
                        <Badge label={`${report.targetOpenReports} OPEN`} tone="live" />
                      ) : null}
                    </View>
                    <Text style={adminStyles.rowMeta}>
                      from {report.reporterName || 'a guest'} · {when(report.createdAtUnixMs)}
                      {report.status !== 'open' ? ` · ${report.status}` : ''}
                    </Text>
                  </View>
                  <Text style={styles.chevron}>{open ? '−' : '+'}</Text>
                </Pressable>

                {open && (
                  <View style={adminStyles.detail}>
                    {Boolean(report.details) && (
                      <>
                        <Text style={adminStyles.detailHeading}>WHAT THEY SAID</Text>
                        <Text style={styles.detailBody}>{report.details}</Text>
                      </>
                    )}
                    {Boolean(report.context) && (
                      <>
                        <Text style={adminStyles.detailHeading}>THE CONVERSATION</Text>
                        {/*
                          Selectable, because the host's next move is often to
                          quote a line of it back to somebody. The room it came
                          from no longer exists — chat is never written to the
                          database — so this copy is the only one there is.
                        */}
                        <Text selectable style={styles.transcript}>
                          {report.context}
                        </Text>
                      </>
                    )}

                    <View style={styles.actions}>
                      {report.targetName ? (
                        <GhostLink
                          compact
                          href={links.player(report.targetName)}
                          label="OPEN PLAYER"
                        />
                      ) : null}
                      {report.gameId ? (
                        <GhostLink compact href={links.watch(report.gameId)} label="THE GAME" />
                      ) : null}
                      {report.status === 'open' ? (
                        <>
                          <GhostButton
                            compact
                            disabled={busyId === report.reportId}
                            label="ACTIONED"
                            onPress={() => settle(report, 'actioned')}
                          />
                          <GhostButton
                            compact
                            disabled={busyId === report.reportId}
                            label="DISMISS"
                            onPress={() => settle(report, 'dismissed')}
                          />
                        </>
                      ) : (
                        <GhostButton
                          compact
                          disabled={busyId === report.reportId}
                          label="REOPEN"
                          onPress={() => settle(report, 'open')}
                        />
                      )}
                    </View>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}
    </Panel>
  );
}

const styles = themedSheet(() => ({
  helper: { ...type.body, color: colors.textMuted, marginTop: space.small },
  filters: { paddingVertical: space.small },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.tight, flexWrap: 'wrap' },
  chevron: { ...type.rowTitle, color: colors.textFaint, paddingHorizontal: space.small },
  detailBody: { ...type.body, color: colors.text, marginBottom: space.small },
  transcript: {
    ...type.meta,
    color: colors.textMuted,
    marginBottom: space.small,
    padding: space.small,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceWell,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.snug, marginTop: space.tight },
  pressed: { opacity: 0.7 },
}));
