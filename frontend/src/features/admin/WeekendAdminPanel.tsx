import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { adminStyles } from './adminStyles';
import { failureMessage } from '@/errors';
import type { AdminToken } from '@/hooks/useAdminToken';
import {
  loadWeekendConfig,
  openWeekendNow,
  saveWeekendConfig,
  type WeekendAdminView,
  type WeekendConfig,
} from '@/store/api/weekend';
import { colors, space, themedSheet, type } from '@/theme';
import type { ModeID } from '@/types/game';
import {
  Badge,
  Banner,
  Checkbox,
  GhostButton,
  LabeledInput,
  OptionChips,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';

// The recurring bot event's settings, which outlive every event they produce.
//
// Everything here is a property of the *series* rather than of this weekend,
// which is why it is a page of its own rather than fields on the tournament
// builder: "Saturday at eight, Intransitive, six engines minimum" is not a
// decision anybody makes again every week.

const DAYS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const MODES: { value: ModeID; label: string }[] = [
  { value: 'V5', label: 'Total War' },
  { value: 'V3', label: 'Infiltration' },
  { value: 'V6', label: 'Intransitive' },
];

/** A number field that keeps its own text so a half-typed value is not clobbered. */
const numberField = (value: number) => (value === 0 ? '' : String(value));

/** "Saturday 09:00" from a weekday and an hour, in the host's own terms. */
const slotLabel = (day: number, hour: number) =>
  `${DAY_NAMES[((day % 7) + 7) % 7]} ${String(hour).padStart(2, '0')}:00`;

/**
 * The window as a sentence: where it opens, where it closes, how long it is.
 *
 * Spelled out rather than left as two numbers because the closing end is the
 * part that decides who can vote for their own Saturday night, and nobody works
 * "Saturday, 09:00, 36" out in their head.
 */
const windowLabel = (config: WeekendConfig, hours: number) => {
  const total = config.windowOpensDay * 24 + config.windowOpensHour + (hours - 1);
  return `${slotLabel(config.windowOpensDay, config.windowOpensHour)} → ${slotLabel(
    Math.floor(total / 24),
    total % 24,
  )}`;
};

export interface WeekendAdminPanelProps {
  admin: AdminToken;
}

export default function WeekendAdminPanel({ admin }: WeekendAdminPanelProps) {
  const [view, setView] = useState<WeekendAdminView | null>(null);
  const [draft, setDraft] = useState<WeekendConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const loaded = await loadWeekendConfig(admin.token);
      setView(loaded);
      setDraft(loaded.config);
      setError(null);
    } catch (requestError) {
      setError(failureMessage(requestError, 'The weekend settings could not be loaded.'));
    }
  }, [admin.token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const change = (patch: Partial<WeekendConfig>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
    } catch (requestError) {
      setError(failureMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  if (!draft || !view) {
    return (
      <Panel style={adminStyles.panel}>
        <SectionHeading eyebrow="ADMINISTRATION" title="Weekend bot arena" />
        {error ? <Banner message={error} tone="error" /> : null}
        <Text style={styles.help}>Loading the settings…</Text>
      </Panel>
    );
  }

  // The server owns the window's length; falling back to 36 only matters
  // against a backend older than this build.
  const windowHours = view.windowHours || 36;

  return (
    <Panel style={adminStyles.panel}>
      <SectionHeading
        eyebrow="ADMINISTRATION"
        title="Weekend bot arena"
        trailing={
          <Badge
            label={draft.enabled ? 'RUNNING' : 'OFF'}
            tone={draft.enabled ? 'accent' : 'neutral'}
          />
        }
      />
      <Text style={styles.help}>
        Weekly tournaments for online engines. Changes apply to the next event.
        {draft.lastRunDate ? ` Last opened ${draft.lastRunDate}.` : ''}
      </Text>

      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
      {notice ? (
        <Banner message={notice} onDismiss={() => setNotice(null)} tone="notice" />
      ) : null}

      <View style={styles.section}>
        <Checkbox
          checked={draft.enabled}
          label="Run a weekend tournament"
          onToggle={() => change({ enabled: !draft.enabled })}
        />
      </View>

      <View style={styles.row}>
        <View style={styles.field}>
          <LabeledInput
            autoCapitalize="none"
            hint="Local wall clock, 24-hour."
            label="STARTS AT"
            onChangeText={(startLocal) => change({ startLocal })}
            placeholder="20:00"
            value={draft.startLocal}
          />
        </View>
        <View style={styles.field}>
          <LabeledInput
            autoCapitalize="none"
            autoCorrect={false}
            hint="An IANA zone. The clock follows it through daylight saving."
            label="TIME ZONE"
            onChangeText={(zone) => change({ zone })}
            placeholder="America/New_York"
            value={draft.zone}
          />
        </View>
      </View>

      <OptionChips
        label="RUNS ON"
        onChange={(startDay) => change({ startDay })}
        options={DAYS}
        value={draft.startDay}
      />
      <Text style={styles.detail}>
        Default weekly start time. Availability votes can move it.
      </Text>

      <OptionChips
        label="GAME"
        onChange={(modeId) => change({ modeId })}
        options={MODES}
        value={draft.modeId}
      />

      <View style={styles.section}>
        <OptionChips
          label="VOTING WINDOW OPENS"
          onChange={(windowOpensDay) => change({ windowOpensDay })}
          options={DAYS}
          value={draft.windowOpensDay}
        />
      </View>
      <View style={styles.row}>
        <View style={styles.field}>
          <LabeledInput
            hint="The hour the window's first slot sits at, 0–23."
            keyboardType="number-pad"
            label="WINDOW OPENS AT"
            onChangeText={(text) =>
              change({ windowOpensHour: Math.min(23, Math.max(0, Number(text) || 0)) })
            }
            placeholder="9"
            value={String(draft.windowOpensHour)}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.windowLabel}>THE WINDOW</Text>
          <Text style={styles.window}>{windowLabel(draft, windowHours)}</Text>
          <Text style={styles.detail}>
            {windowHours} hours, in your zone above. Everybody votes inside it, and each
            reader sees the slots on their own weekday.
          </Text>
        </View>
      </View>
      <Text style={styles.detail}>
        No {windowHours} hours are fair to everybody: wherever the window sits, some part of
        the world loses one of its two evenings. Slide it towards the continent the field
        actually plays from. A start time outside the window is dragged to the nearer end of
        it, because the vote is the only thing that can move the schedule.
      </Text>

      <View style={styles.row}>
        <View style={styles.field}>
          <LabeledInput
            hint="Cancel if fewer engines are online at the start."
            keyboardType="number-pad"
            label="MINIMUM FIELD"
            onChangeText={(text) => change({ minimumField: Number(text) || 0 })}
            placeholder="6"
            value={numberField(draft.minimumField)}
          />
        </View>
        <View style={styles.field}>
          <LabeledInput
            hint="Everybody plays everybody up to this size. Above it, Swiss."
            keyboardType="number-pad"
            label="ROUND ROBIN UP TO"
            onChangeText={(text) => change({ roundRobinMax: Number(text) || 0 })}
            placeholder="10"
            value={numberField(draft.roundRobinMax)}
          />
        </View>
      </View>

      <View style={styles.row}>
        <View style={styles.field}>
          <LabeledInput
            hint="How long before the start the event appears and voting opens."
            keyboardType="number-pad"
            label="DOORS OPEN (MIN)"
            onChangeText={(text) => change({ doorsMinutes: Number(text) || 0 })}
            placeholder="30"
            value={numberField(draft.doorsMinutes)}
          />
        </View>
        <View style={styles.field}>
          <LabeledInput
            hint="Colours swap each game. Use an even number to balance them."
            keyboardType="number-pad"
            label="GAMES PER MATCH"
            onChangeText={(text) => change({ gamesPerMatch: Number(text) || 0 })}
            placeholder="2"
            value={numberField(draft.gamesPerMatch)}
          />
        </View>
      </View>

      <View style={styles.section}>
        <Checkbox
          checked={draft.pollEnabled}
          label="Let people vote on the time control"
          onToggle={() => change({ pollEnabled: !draft.pollEnabled })}
        />
      </View>

      <OptionChips
        label="DEFAULT CLOCK"
        onChange={(defaultControl) => change({ defaultControl })}
        options={view.controls.map((control) => ({
          value: control.key,
          label: control.key,
        }))}
        value={draft.defaultControl}
      />
      <Text style={styles.detail}>
        {draft.pollEnabled
          ? "Used when votes tie or fall below the minimum."
          : "Time control when voting is off."}
      </Text>

      <View style={styles.row}>
        <View style={styles.field}>
          <LabeledInput
            hint="Fewer votes than this and the default wins."
            keyboardType="number-pad"
            label="MINIMUM VOTES"
            onChangeText={(text) => change({ minimumVotes: Number(text) || 0 })}
            placeholder="3"
            value={numberField(draft.minimumVotes)}
          />
        </View>
        <View style={styles.field}>
          <LabeledInput
            hint="How long before the start the ballot locks."
            keyboardType="number-pad"
            label="VOTING CLOSES (MIN)"
            onChangeText={(text) => change({ pollClosesMinutes: Number(text) || 0 })}
            placeholder="60"
            value={numberField(draft.pollClosesMinutes)}
          />
        </View>
      </View>

      <View style={styles.row}>
        <View style={styles.field}>
          <LabeledInput
            hint="How long a match waits for an engine that has gone away before forfeiting it."
            keyboardType="number-pad"
            label="GRACE (SECONDS)"
            onChangeText={(text) => change({ graceSeconds: Number(text) || 0 })}
            placeholder="90"
            value={numberField(draft.graceSeconds)}
          />
        </View>
        <View style={styles.field}>
          <LabeledInput
            autoCapitalize="none"
            autoCorrect={false}
            hint="One weekend off, as YYYY-MM-DD. Blank runs every scheduled weekend."
            label="SKIP A DATE"
            onChangeText={(skipDate) => change({ skipDate })}
            placeholder=""
            value={draft.skipDate}
          />
        </View>
      </View>

      <View style={styles.actions}>
        <PrimaryButton
          disabled={busy}
          label="SAVE SETTINGS"
          loading={busy}
          onPress={() =>
            run(async () => {
              const saved = await saveWeekendConfig(admin.token, draft);
              setDraft(saved);
            }, 'Saved. It applies from the next weekend.')
          }
        />
        <GhostButton
          compact
          disabled={busy}
          label="OPEN THIS WEEKEND NOW"
          onPress={() =>
            run(async () => {
              await openWeekendNow(admin.token);
              await refresh();
            }, "Event opened. It starts at the scheduled time unless started early from Tournaments.")
          }
        />
      </View>
      <Text style={styles.detail}>
        Open the event now for testing. Use Tournaments to start it early.
      </Text>
    </Panel>
  );
}

const styles = themedSheet(() => ({
  help: { color: colors.textMuted, ...type.body, marginTop: space.small },
  detail: { color: colors.textFaint, ...type.meta, marginTop: space.snug },
  section: { marginTop: space.medium },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.medium },
  field: { flexGrow: 1, flexBasis: 200 },
  windowLabel: { color: colors.textFaint, ...type.label, marginBottom: space.tight },
  window: { color: colors.text, ...type.rowTitle },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.medium,
    marginTop: space.large,
  },
}));
