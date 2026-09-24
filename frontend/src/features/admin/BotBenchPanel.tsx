import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import ConfirmButton from './ConfirmButton';
import { adminStyles } from './adminStyles';
import { failureMessage } from '@/errors';
import type { AdminToken } from '@/hooks/useAdminToken';
import { useNow } from '@/hooks/useNow';
import {
  cancelBenchWindow,
  listBenchWindows,
  scheduleBenchWindow,
  type BenchWindow,
} from '@/store/api/serverAdmin';
import { colors, space, themedSheet, type } from '@/theme';
import {
  Badge,
  Banner,
  EmptyState,
  GhostButton,
  LabeledInput,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';

// Scheduling the engine bench: a stretch of time in which no bot takes a game.
//
// It is not a switch and this panel deliberately does not offer one. A switch
// has to be thrown twice by a person — once a quarter of an hour before the
// tournament and once when it is over — and the second of those is the one that
// gets forgotten, leaving the ladder off for a week. A window declared ahead of
// time happens whether or not anybody is at a keyboard, and ends the same way.
//
// Benching the engines *right now* is still possible and needs no second
// control: schedule a window that starts now. That is why the server accepts a
// start time in the past and refuses only a window that has already finished.
//
// # The one hard part is timezones
//
// The server stores two exact instants and knows nothing about zones, which is
// correct and is argued at length in `backend/internal/server/bot_bench.go`. So
// the conversion has to happen here, where the browser knows what zone the
// person typing is in. Two consequences the layout has to carry:
//
//   - Every field on this form is in the **host's own** local time, and says
//     so. A host in Berlin scheduling a 10 AM Eastern tournament types 16:00,
//     and the preview is what confirms they meant the right moment.
//   - `untilLabel` is the exception, and the only string here that knows what a
//     timezone is. Players read it — "the engines are offline until 4 PM
//     Eastern" — so it is written in the zone the *event* was announced in,
//     which is not necessarily the host's. It is suggested from the end instant
//     and then left alone.
//
// The preview is the whole sentence a refused player will see, rather than a
// summary of the form. A bench is read by everybody who tries to challenge a bot
// that afternoon, and the moment to notice it reads badly is before it is
// scheduled.

export interface BotBenchPanelProps {
  admin: AdminToken;
}

/** A YYYY-MM-DD and an HH:MM in this browser's zone, as an instant. */
const instantFrom = (date: string, time: string): number | null => {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const clock = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!day || !clock) return null;
  const [year, month, dayOfMonth] = [Number(day[1]), Number(day[2]), Number(day[3])];
  const [hour, minute] = [Number(clock[1]), Number(clock[2])];
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;
  if (hour > 23 || minute > 59) return null;
  // The local-time constructor rather than Date.parse, which reads a bare
  // "2026-09-13" as UTC and would put the window four hours out for a host in
  // New York — in the direction that opens it late.
  const at = new Date(year, month - 1, dayOfMonth, hour, minute, 0, 0);
  return Number.isNaN(at.getTime()) ? null : at.getTime();
};

/** An instant in this browser's zone, spelled for a person. */
const localMoment = (unixMs: number): string => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(unixMs));
  } catch {
    return new Date(unixMs).toISOString();
  }
};

/**
 * The clock half alone, with the zone — the shape an `untilLabel` wants.
 *
 * A suggestion and nothing more. It names the host's zone because that is the
 * only one the browser can know, and a host scheduling somebody else's event
 * overwrites it.
 */
const suggestedLabel = (unixMs: number): string => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(unixMs));
  } catch {
    return '';
  }
};

/** Today, in this browser's zone, as the date field wants it. */
const todayLocal = (): string => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

export default function BotBenchPanel({ admin }: BotBenchPanelProps) {
  const [windows, setWindows] = useState<BenchWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('');
  const [hours, setHours] = useState('');
  const [label, setLabel] = useState('');

  // A window is running or not according to the clock, and the list is fetched
  // once. Re-reading the time is what stops a bench that ended five minutes ago
  // still wearing a RUNNING badge.
  const now = useNow();

  const refresh = useCallback(async () => {
    if (!admin.token) return;
    setLoading(true);
    try {
      setWindows((await listBenchWindows(admin.token)) ?? []);
      setError(null);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [admin.token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Only after the clock has settled — see `useNow`. Filling it during the
  // pre-render would put a build-time date into the HTML.
  useEffect(() => {
    if (now !== null && date === '') setDate(todayLocal());
  }, [now, date]);

  const from = instantFrom(date, start);
  const length = Number(hours.trim());
  const lengthValid = hours.trim() !== '' && Number.isFinite(length) && length > 0;
  const until = from !== null && lengthValid ? from + Math.round(length * 3_600_000) : null;
  const endLabel = label.trim() || (until === null ? '' : suggestedLabel(until));
  const finished = until !== null && now !== null && until <= now;
  const ready = reason.trim() !== '' && from !== null && until !== null && !finished;

  const run = async (action: () => Promise<unknown>, successNotice: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successNotice);
      await refresh();
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  const schedule = () => {
    if (!ready || from === null || until === null) return;
    void run(async () => {
      await scheduleBenchWindow(admin.token, {
        reason: reason.trim(),
        untilLabel: endLabel,
        fromUnixMs: from,
        untilUnixMs: until,
      });
      setReason('');
      setStart('');
      setHours('');
      setLabel('');
    }, "Scheduled. Engines pause and resume automatically.");
  };

  return (
    <Panel style={adminStyles.panel}>
      <SectionHeading
        eyebrow="ADMINISTRATION"
        title="Engine bench"
        trailing={
          <GhostButton
            compact
            disabled={loading}
            label={loading ? 'LOADING' : 'REFRESH'}
            onPress={refresh}
          />
        }
      />
      <Text style={styles.help}>
        Schedule a break from bot games. Engines stay connected, decline challenges with your message, and resume automatically.
      </Text>

      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
      {notice ? <Banner message={notice} onDismiss={() => setNotice(null)} /> : null}

      <LabeledInput
        hint="Shown to players after “the engines are offline for…”."
        label="WHAT FOR"
        maxLength={160}
        onChangeText={setReason}
        placeholder="the official Intransitive tournament on meaf.us/rps2"
        value={reason}
      />

      {/*
        Wrapped rather than styled: LabeledInput spreads its props onto the
        TextInput and keeps the group's own style, so a `style` passed here
        would size the box and not the column.
      */}
      <View style={styles.fieldRow}>
        <View style={styles.field}>
          <LabeledInput
            autoCapitalize="none"
            autoCorrect={false}
            label="DATE"
            onChangeText={setDate}
            placeholder="2026-09-13"
            value={date}
          />
        </View>
        <View style={styles.field}>
          <LabeledInput
            autoCapitalize="none"
            autoCorrect={false}
            label="STARTS"
            onChangeText={setStart}
            placeholder="09:45"
            value={start}
          />
        </View>
        <View style={styles.field}>
          <LabeledInput
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="decimal"
            label="HOURS"
            onChangeText={setHours}
            placeholder="6.25"
            value={hours}
          />
        </View>
      </View>
      <Text style={styles.zoneNote}>
        Enter times in your device’s timezone.
      </Text>

      <LabeledInput
        hint="Timezone shown to players. Change it if the event uses another zone."
        label="BACK AT"
        maxLength={40}
        onChangeText={setLabel}
        placeholder={until === null ? '4 PM Eastern' : suggestedLabel(until)}
        value={label}
      />

      {/*
        The preview is the refusal itself, not a summary. It is the sentence
        every player who challenges a bot that afternoon will read, and the
        moment to notice it reads badly is before it is scheduled.
      */}
      {from !== null && until !== null ? (
        <View style={styles.preview}>
          <Text style={styles.previewWhen}>
            {localMoment(from)} → {localMoment(until)}, your time
          </Text>
          <Text style={styles.previewLine}>
            “the engines are offline until {endLabel || '…'} for{' '}
            {reason.trim() || '…'}”
          </Text>
          {finished ? (
            <Text style={styles.previewWarn}>That window has already finished.</Text>
          ) : null}
        </View>
      ) : null}

      <PrimaryButton
        disabled={busy || !ready}
        label="SCHEDULE BENCH"
        onPress={schedule}
      />

      <Text style={adminStyles.detailHeading}>SCHEDULED</Text>
      {windows.length === 0 ? (
        <EmptyState
          detail="The engines are on the ladder whenever they are online."
          title="Nothing scheduled"
        />
      ) : (
        <View style={adminStyles.list}>
          {windows.map((window) => {
            // The server's own flags are the fallback, for the render before
            // the clock settles. After that this browser's clock is exact and
            // the fetched list is not.
            const running =
              now === null
                ? window.active
                : now >= window.fromUnixMs && now < window.untilUnixMs;
            const over = now === null ? window.past : now >= window.untilUnixMs;
            return (
              <View key={window.id} style={adminStyles.row}>
                <View style={adminStyles.rowCopy}>
                  <Text numberOfLines={2} style={adminStyles.rowName}>
                    {window.reason}
                  </Text>
                  <Text style={adminStyles.rowMeta}>
                    {localMoment(window.fromUnixMs)} → {localMoment(window.untilUnixMs)} · back
                    at {window.untilLabel}
                  </Text>
                </View>
                {running ? <Badge label="RUNNING" tone="live" /> : null}
                {over ? <Badge label="OVER" tone="neutral" /> : null}
                <ConfirmButton
                  armed={confirming === window.id}
                  busy={busy}
                  label={over ? 'REMOVE' : 'CANCEL'}
                  onArm={() => setConfirming(window.id)}
                  onConfirm={() =>
                    run(
                      () => cancelBenchWindow(admin.token, window.id),
                      running
                        ? 'Called off. The engines are back on the ladder now.'
                        : 'Called off. A deploy will not put it back.',
                    )
                  }
                  tone={over ? 'quiet' : 'danger'}
                />
              </View>
            );
          })}
        </View>
      )}
    </Panel>
  );
}

const styles = themedSheet(() => ({
  help: { ...type.body, color: colors.textFaint, marginBottom: space.small },

  fieldRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.small },
  // minWidth rather than width so three fields become one column on a phone
  // rather than three unreadable ones.
  field: { flex: 1, minWidth: 120 },
  zoneNote: { ...type.meta, color: colors.textFaint, marginTop: space.snug },

  preview: {
    marginTop: space.small,
    marginBottom: space.small,
    paddingLeft: space.medium,
    borderLeftWidth: 2,
    borderLeftColor: colors.goldBorder,
  },
  previewWhen: { ...type.meta, color: colors.textFaint },
  previewLine: { ...type.body, color: colors.text, marginTop: 2 },
  previewWarn: { ...type.meta, color: colors.dangerSoft, marginTop: space.snug },
}));
