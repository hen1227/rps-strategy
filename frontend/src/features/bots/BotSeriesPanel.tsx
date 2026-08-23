import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { failureMessage } from '@/errors';
import { useAdminToken } from '@/hooks/useAdminToken';
import { useRequestIdentity } from '@/hooks/useRequestIdentity';
import { links } from '@/navigation/links';
import {
  abortAdminBotSeries,
  abortBotSeries,
  listBotSeries,
  startAdminBotSeries,
  startBotSeries,
  type BotSeries,
} from '@/store/api/bots';
import { colors, space, type } from '@/theme';
import LinkRow from '@/ui/LinkRow';
import ListRow from '@/ui/ListRow';
import {
  Badge,
  Banner,
  GhostButton,
  LabeledInput,
  OptionChips,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';
import type { ModeDefinition, ModeID } from '@/types/game';
import type { BotPresence } from '@/types/protocol';

// Pit two engine bots against each other.
//
// This was a host control, and the reasoning for that only ever covered the
// cost: a run holds two engines for as long as it lasts, so it should not be
// free to start a hundred of them. It never covered the permission, because the
// bots already carry one — every engine has a public-play switch that decides
// whether strangers may play it, and a series is strangers playing it.
//
// So the form is open to anybody, and what used to be an admin gate is now three
// server-side limits: at most three pairs, at most ten minutes each, and one
// running series per person. The HOST CONTROLS button below lifts all three for
// somebody who holds the host token, which is what a fifty-pair run at a real
// time control needs.
//
// The four numbers that shape a run sit behind a toggle. Every one of them has a
// sensible default, none of them is the decision anybody came here to make, and
// four labelled fields at the top of a panel read as a form to be filled in
// rather than a button to be pressed.

/** What the public form may ask for. The server enforces the same numbers. */
const PUBLIC_MAX_PAIRS = 3;
const PUBLIC_MAX_MINUTES = 10;
/**
 * An opening is a handful of moves off the book, not a position somebody else
 * played into. The server allows up to botSeriesMaxOpeningPlies, which is what
 * the host form still offers.
 */
const PUBLIC_MAX_PLIES = 6;
/** What the host may ask for, matching the server's own ceilings. */
const HOST_MAX_PAIRS = 100;
const HOST_MAX_PLIES = 20;

/** How many finished runs to list. The rest are on the ladder's own page. */
const VISIBLE_RUNS = 5;

const numeric = (value: string, fallback: number) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high);

export interface BotSeriesPanelProps {
  /** The connected engines to pick two opponents from. */
  bots: BotPresence[];
  modes: ModeDefinition[];
}

export default function BotSeriesPanel({ bots, modes }: BotSeriesPanelProps) {
  const identity = useRequestIdentity();
  const admin = useAdminToken();
  const [hostFormOpen, setHostFormOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const [firstBotId, setFirstBotId] = useState<string | null>(null);
  const [secondBotId, setSecondBotId] = useState<string | null>(null);
  const [modeId, setModeId] = useState<ModeID>(modes[0]?.id ?? 'V5');
  const [pairs, setPairs] = useState('2');
  const [plies, setPlies] = useState('3');
  const [seed, setSeed] = useState('');
  const [minutes, setMinutes] = useState('1');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [series, setSeries] = useState<BotSeries[]>([]);

  const asHost = admin.unlocked;
  const maxPairs = asHost ? HOST_MAX_PAIRS : PUBLIC_MAX_PAIRS;
  const maxPlies = asHost ? HOST_MAX_PLIES : PUBLIC_MAX_PLIES;
  const maxMinutes = asHost ? 60 : PUBLIC_MAX_MINUTES;

  const refresh = useCallback(async () => {
    try {
      setSeries((await listBotSeries(12)) ?? []);
    } catch {
      // The scoreboard is a nicety; a failure here should not stop somebody
      // starting a run, and the error that matters is the one from the start.
    }
  }, []);

  useEffect(() => {
    refresh();
    // Series games are ordinary games, so the lobby already updates live. This
    // only refreshes the tally, which changes once per game.
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const start = async () => {
    if (!firstBotId || !secondBotId) return;
    setBusy(true);
    setError(null);
    try {
      const options = {
        firstBotId,
        secondBotId,
        modeId,
        pairs: clamp(numeric(pairs, 2), 1, maxPairs),
        openingPlies: clamp(numeric(plies, 3), 0, maxPlies),
        // Passed through as text rather than parsed: the value a person pastes
        // here is one they copied off a finished run, and `Number.parseInt`
        // would round it before it ever left the browser.
        seed: seed.trim().replace(/\D/g, ''),
        timeControl: {
          initialTimeMs: clamp(numeric(minutes, 1), 1, maxMinutes) * 60_000,
          incrementMs: 1000,
        },
      };
      if (asHost) await startAdminBotSeries(admin.token, options);
      else await startBotSeries(identity, options);
      await refresh();
    } catch (caught) {
      setError(failureMessage(caught, 'The series could not be started.'));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (run: BotSeries) => {
    setError(null);
    try {
      if (asHost) await abortAdminBotSeries(admin.token, run.seriesId);
      else await abortBotSeries(identity, run.seriesId);
      await refresh();
    } catch (caught) {
      setError(failureMessage(caught, 'The series could not be stopped.'));
    }
  };

  // A bot that is mid-game cannot be entered into a new run. A bot whose owner
  // has not opened it to public play is still listed, marked, because its owner
  // is allowed to enter it and the server is the one that knows who that is.
  const idle = useMemo(() => bots.filter((bot) => !bot.busy), [bots]);
  const botOptions = useMemo(
    () =>
      idle.map((bot) => ({
        label: bot.allowPublicPlay ? bot.name : `${bot.name} · PRIVATE`,
        value: bot.botId as string | null,
      })),
    [idle],
  );
  const enoughBots = idle.length >= 2;
  const canStart =
    !busy && Boolean(firstBotId) && Boolean(secondBotId) && firstBotId !== secondBotId;
  const mine = (run: BotSeries) =>
    Boolean(run.requestedByUserId) && run.requestedByUserId === identity.userId;

  return (
    <Panel style={asHost ? styles.adminPanel : undefined}>
      <SectionHeading
        eyebrow={asHost ? 'HOST' : 'ANYBODY'}
        title="Pit two bots against each other"
        trailing={
          admin.bySession ? undefined : (
            <GhostButton
              compact
              label={hostFormOpen || asHost ? 'CLOSE' : 'HOST CONTROLS'}
              onPress={() => {
                if (asHost) admin.lock();
                setHostFormOpen(!hostFormOpen && !asHost);
              }}
            />
          )
        }
      />

      <Text style={styles.help}>
        {asHost
          ? 'Host limits: up to 100 pairs at any clock. The public form is capped at 3 pairs and 10 minutes each.'
          : `Up to ${PUBLIC_MAX_PAIRS} pairs at ${PUBLIC_MAX_MINUTES} minutes each, and one run at a time per person. Both engines have to be open to public play — or be yours.`}
      </Text>

      {hostFormOpen && !asHost ? (
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
            label="UNLOCK HOST LIMITS"
            onPress={() => admin.unlock(draft).then((ok) => ok && setDraft(''))}
          />
        </>
      ) : null}

      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}

      {enoughBots && (
        <View style={styles.form}>
          <OptionChips<string | null>
            label="FIRST BOT"
            onChange={setFirstBotId}
            options={botOptions}
            value={firstBotId}
          />
          <OptionChips<string | null>
            label="SECOND BOT"
            onChange={setSecondBotId}
            options={botOptions}
            value={secondBotId}
          />
          <OptionChips<ModeID>
            label="MODE"
            onChange={setModeId}
            options={modes.map((mode) => ({ label: mode.name, value: mode.id }))}
            value={modeId}
          />

          {optionsOpen ? (
            <View style={styles.fields}>
              <LabeledInput
                hint={`Played twice each, colours swapped · max ${maxPairs}`}
                keyboardType="number-pad"
                label="PAIRS"
                onChangeText={setPairs}
                value={pairs}
              />
              <LabeledInput
                hint={`Random moves both bots start from · max ${maxPlies}`}
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
                hint={`Max ${maxMinutes}`}
                keyboardType="number-pad"
                label="MINUTES EACH"
                onChangeText={setMinutes}
                value={minutes}
              />
            </View>
          ) : null}

          <View style={styles.actions}>
            <PrimaryButton disabled={!canStart} label="START SERIES ▶" onPress={start} />
            <GhostButton
              compact
              label={
                optionsOpen
                  ? 'HIDE OPTIONS'
                  : `${pairs} PAIRS · ${plies} PLIES · ${minutes} MIN`
              }
              onPress={() => setOptionsOpen(!optionsOpen)}
            />
          </View>
        </View>
      )}

      {series.length === 0 ? null : (
        <View style={styles.list}>
          {series.slice(0, VISIBLE_RUNS).map((run, index) => (
            <ListRow
              detail={
                run.requestedByName ? (
                  <Text style={styles.rowMeta}>
                    started by {run.requestedByName}
                    {mine(run) ? ' · you' : ''}
                  </Text>
                ) : undefined
              }
              divided={index > 0}
              key={run.seriesId}
              meta={`${run.modeId} · ${run.pairs} pairs · seed ${run.seed}`}
              title={`${run.firstBotName} ${run.firstWins}–${run.secondWins} ${run.secondBotName}${
                run.draws ? ` (${run.draws} drawn)` : ''
              }`}
              trailing={
                <View style={styles.rowActions}>
                  <Badge
                    label={run.status.toUpperCase()}
                    tone={run.status === 'running' ? 'live' : 'neutral'}
                  />
                  {run.status === 'running' && (asHost || mine(run)) ? (
                    <GhostButton compact label="STOP" onPress={() => stop(run)} />
                  ) : null}
                </View>
              }
            />
          ))}
        </View>
      )}

      {/*
        Where these runs end up. The standings and the game-by-game history used
        to be copied onto this page as well, which made a page about starting a
        run twice as long as the run's own scoreboard.
      */}
      <LinkRow
        detail="Ranked engine standings, and every game behind them."
        href={links.leaderboard()}
        title="The bot ladder"
      />
    </Panel>
  );
}

const styles = StyleSheet.create({
  adminPanel: { borderColor: colors.goldBorder, backgroundColor: colors.goldSurfaceDeep },
  help: { ...type.body, color: colors.textMuted, marginTop: space.small },
  form: { gap: space.medium, marginTop: space.medium },
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: space.medium },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.small,
  },
  list: { marginTop: space.medium },
  rowMeta: { ...type.meta, color: colors.textFaint, marginTop: space.hair },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
});
