import { failureMessage } from '@/errors';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  Badge,
  Banner,
  GhostButton,
  LabeledInput,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';
import { useAdminToken } from '@/hooks/useAdminToken';
import {
  abortBotSeries,
  listBotSeries,
  startBotSeries,
  type BotSeries,
} from '@/store/api/bots';
import { colors } from '@/theme';
import type { ModeDefinition } from '@/types/game';
import type { BotPresence } from '@/types/protocol';

// Host controls for engine bots: pit two of them against each other.
//
// It sits next to the bot roster rather than on its own screen because that is
// where you are when you decide to do it. The games it starts are ordinary
// games, so watching them is the existing live-games table doing its job.

const numeric = (value: string, fallback: number) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export interface BotSeriesPanelProps {
  /** The connected engines to pick two opponents from. */
  bots: BotPresence[];
  modes: ModeDefinition[];
}

export default function BotSeriesPanel({ bots, modes }: BotSeriesPanelProps) {
  const [open, setOpen] = useState(false);
  const admin = useAdminToken();
  const [draft, setDraft] = useState('');

  const [redBotId, setRedBotId] = useState<string | null>(null);
  const [blueBotId, setBlueBotId] = useState<string | null>(null);
  const [modeId, setModeId] = useState(modes[0]?.id ?? 'V5');
  const [pairs, setPairs] = useState('2');
  const [plies, setPlies] = useState('6');
  const [seed, setSeed] = useState('');
  const [minutes, setMinutes] = useState('1');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [series, setSeries] = useState<BotSeries[]>([]);

  const refresh = async () => {
    try {
      setSeries((await listBotSeries()) ?? []);
    } catch {
      // The scoreboard is a nicety; a failure here should not block starting one.
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    refresh();
    // Series games are ordinary games, so the lobby already updates live. This
    // only refreshes the tally, which changes once per game.
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [open]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!redBotId || !blueBotId) return;
      await startBotSeries(admin.token, {
        firstBotId: redBotId,
        secondBotId: blueBotId,
        modeId,
        pairs: numeric(pairs, 2),
        openingPlies: numeric(plies, 6),
        seed: numeric(seed, 0),
        timeControl: {
          initialTimeMs: Math.max(numeric(minutes, 1), 1) * 60_000,
          incrementMs: 1000,
        },
      });
      await refresh();
    } catch (caught) {
      setError(failureMessage(caught, 'The series could not be started.'));
    } finally {
      setBusy(false);
    }
  };

  // A bot that is mid-game cannot be entered into a new series.
  const idle = bots.filter((bot) => !bot.busy);
  const canStart =
    !busy && redBotId && blueBotId && redBotId !== blueBotId && admin.unlocked;

  const picker = (
    label: string,
    selected: string | null,
    onSelect: (botId: string) => void,
  ) => (
    <View style={styles.picker}>
      <Text style={styles.pickerLabel}>{label}</Text>
      <View style={styles.pickerRow}>
        {idle.map((bot) => (
          <GhostButton
            compact
            key={bot.botId}
            label={bot.botId === selected ? `▸ ${bot.name}` : bot.name}
            onPress={() => onSelect(bot.botId)}
          />
        ))}
      </View>
    </View>
  );

  return (
    <Panel style={admin.unlocked ? styles.adminPanel : undefined}>
      <SectionHeading
        eyebrow="PRIVATE"
        title="Pit two bots"
        trailing={
          <GhostButton
            compact
            label={open ? 'CLOSE' : 'HOST CONTROLS'}
            onPress={() => setOpen(!open)}
          />
        }
      />
      {!open ? null : !admin.unlocked ? (
        <>
          {admin.error ? <Banner message={admin.error} tone="error" /> : null}
          <LabeledInput
            label="ADMIN TOKEN"
            onChangeText={setDraft}
            secureTextEntry
            value={draft}
          />
          <PrimaryButton
            disabled={admin.verifying}
            label="UNLOCK COMMANDS"
            onPress={() => admin.unlock(draft).then((ok) => ok && setDraft(''))}
          />
        </>
      ) : (
        <>
          {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
          {idle.length < 2 ? (
            <Text style={styles.help}>
              Two idle bots are needed. {idle.length} available right now.
            </Text>
          ) : null}
          {picker('FIRST BOT', redBotId, setRedBotId)}
          {picker('SECOND BOT', blueBotId, setBlueBotId)}
          <View style={styles.pickerRow}>
            {modes.map((mode) => (
              <GhostButton
                compact
                key={mode.id}
                label={mode.id === modeId ? `▸ ${mode.name}` : mode.name}
                onPress={() => setModeId(mode.id)}
              />
            ))}
          </View>
          <View style={styles.fields}>
            <LabeledInput
              hint="Each pair is played twice, colours swapped"
              keyboardType="number-pad"
              label="PAIRS"
              onChangeText={setPairs}
              value={pairs}
            />
            <LabeledInput
              hint="Random moves both bots start from"
              keyboardType="number-pad"
              label="OPENING PLIES"
              onChangeText={setPlies}
              value={plies}
            />
            <LabeledInput
              hint="Blank picks one"
              keyboardType="number-pad"
              label="SEED"
              onChangeText={setSeed}
              value={seed}
            />
            <LabeledInput
              keyboardType="number-pad"
              label="MINUTES EACH"
              onChangeText={setMinutes}
              value={minutes}
            />
          </View>
          <View style={styles.actions}>
            <PrimaryButton disabled={!canStart} label="START SERIES ▶" onPress={start} />
            <GhostButton label="LOCK" onPress={admin.lock} />
          </View>

          {series.length === 0 ? null : (
            <View style={styles.list}>
              {series.slice(0, 6).map((run) => (
                <View key={run.seriesId} style={styles.row}>
                  <View style={styles.rowCopy}>
                    <Text style={styles.rowName}>
                      {run.firstBotName} {run.firstWins}–{run.secondWins} {run.secondBotName}
                      {run.draws ? ` (${run.draws} drawn)` : ''}
                    </Text>
                    <Text style={styles.rowMeta}>
                      {run.modeId} · {run.pairs} pairs · seed {run.seed}
                    </Text>
                  </View>
                  <Badge
                    label={run.status.toUpperCase()}
                    tone={run.status === 'running' ? 'live' : 'neutral'}
                  />
                  {run.status === 'running' ? (
                    <GhostButton
                      compact
                      label="ABORT"
                      onPress={() =>
                        abortBotSeries(admin.token, run.seriesId).then(refresh).catch(() => {})
                      }
                    />
                  ) : null}
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  adminPanel: { borderColor: colors.goldBorder, backgroundColor: colors.goldSurfaceDeep },
  help: { color: colors.textFaint, fontSize: 11, marginTop: 8 },
  picker: { marginTop: 10 },
  pickerLabel: {
    color: colors.textFaint,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 4,
  },
  pickerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10 },
  list: { gap: 1, marginTop: 12 },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  rowCopy: { flex: 1 },
  rowName: { color: colors.text, fontSize: 12, fontWeight: '800' },
  rowMeta: { color: colors.textFaint, fontSize: 10, marginTop: 2 },
});
