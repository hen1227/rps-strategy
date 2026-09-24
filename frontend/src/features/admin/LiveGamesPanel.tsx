import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import ConfirmButton from './ConfirmButton';
import { adminStyles } from './adminStyles';
import { failureMessage } from '@/errors';
import { relativeTime } from '@/features/bots/relativeTime';
import type { AdminToken } from '@/hooks/useAdminToken';
import { links } from '@/navigation/links';
import {
  listLiveGames,
  stopLiveGame,
  type AdminLiveGame,
  type StopOutcome,
} from '@/store/api/admin';
import { colors, space, themedSheet, type } from '@/theme';
import {
  Badge,
  Banner,
  EmptyState,
  GhostButton,
  GhostLink,
  LabeledInput,
  OptionChips,
  Panel,
  SectionHeading,
} from '@/ui/primitives';

// Stopping a match.
//
// The panel exists for two situations and it is worth being explicit about
// which is which, because the button a host wants differs:
//
//   - **The game should not count.** A bug, an abusive board, two engines stuck
//     in a loop. Stop it as `void`: the board disappears, nothing is filed, no
//     rating moves.
//   - **The game will not finish but its result is not in doubt.** Somebody has
//     walked away, or a host has adjudicated. Stop it with a result, and it is
//     filed and rated exactly as if it had ended that way on the board.
//
// Voiding is the default of the two, because it is the conservative one: a
// request that did not decide what result to record should not invent one.
//
// One thing this cannot do: stop a game that belongs to a bot series. Voiding
// one game out of a six-game run would leave the runner waiting for a board
// that no longer exists, and the operation actually wanted — call the whole run
// off — already exists on the Bots page.

/** What the outcome chips offer, in the order a host is likely to want them. */
const OUTCOMES: { label: string; value: StopOutcome }[] = [
  { label: 'Void', value: 'void' },
  { label: 'Draw', value: 'draw' },
  { label: 'Red wins', value: 'red' },
  { label: 'Blue wins', value: 'blue' },
];

export interface LiveGamesPanelProps {
  admin: AdminToken;
}

export default function LiveGamesPanel({ admin }: LiveGamesPanelProps) {
  const [games, setGames] = useState<AdminLiveGame[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // The outcome and reason apply to whichever row is pressed next, like the
  // rating toggle on the history panel below. Per-row copies of both would be
  // four chips and a text field inside every row of a list that is usually one
  // row long.
  const [outcome, setOutcome] = useState<StopOutcome>('void');
  const [reason, setReason] = useState('');

  const refresh = useCallback(async () => {
    if (!admin.token) return;
    setLoading(true);
    try {
      setGames((await listLiveGames(admin.token)) ?? []);
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

  const stop = async (game: AdminLiveGame) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await stopLiveGame(admin.token, game.gameId, outcome, reason.trim());
      setNotice(
        result.recorded
          ? `Stopped and filed as ${outcome}. Both players were told why.`
          : 'Stopped and voided. Nothing was filed and no rating moved.',
      );
      setReason('');
      await refresh();
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  return (
    <Panel style={adminStyles.panel}>
      <SectionHeading
        eyebrow="RIGHT NOW"
        title={games.length === 1 ? '1 game in progress' : `${games.length} games in progress`}
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
      {notice ? <Banner message={notice} onDismiss={() => setNotice(null)} /> : null}

      {games.length === 0 ? (
        <EmptyState
          detail="Nothing is being played on this server right now."
          title="No live games"
        />
      ) : (
        <>
          <OptionChips
            label="STOP THE NEXT ONE AS"
            onChange={setOutcome}
            options={OUTCOMES}
            value={outcome}
          />
          <LabeledInput
            hint="Shown to both players and spectators."
            label="REASON"
            maxLength={200}
            onChangeText={setReason}
            placeholder="stuck in a repetition loop"
            value={reason}
          />
          <View style={adminStyles.list}>
            {games.map((game) => (
              <View key={game.gameId} style={adminStyles.row}>
                <View style={adminStyles.rowCopy}>
                  <Text numberOfLines={1} style={adminStyles.rowName}>
                    {game.redPlayer?.username ?? 'Red'} vs {game.bluePlayer?.username ?? 'Blue'}
                  </Text>
                  <Text numberOfLines={1} style={adminStyles.rowMeta}>
                    {game.modeName} · move {game.moveNumber} ·{' '}
                    {game.startedAtUnixMs
                      ? `started ${relativeTime(game.startedAtUnixMs)}`
                      : 'not started'}
                    {game.spectatorCount ? ` · ${game.spectatorCount} watching` : ''}
                  </Text>
                </View>
                {game.ranked ? <Badge label="RANKED" tone="neutral" /> : null}
                {game.tournamentId ? <Badge label="TOURNAMENT" tone="warm" /> : null}
                {game.seriesId ? <Badge label="SERIES" tone="cool" /> : null}
                {/*
                  A game that has been opened but not begun expires by itself
                  when nobody moves, and both players can still abort it. Saying
                  so keeps a host from stopping something that was about to
                  resolve on its own.
                */}
                {game.awaitingFirstMove ? <Badge label="NOT STARTED" tone="neutral" /> : null}
                <GhostLink compact href={links.watch(game.gameId)} label="WATCH" />
                {game.seriesId ? (
                  <Text style={styles.blocked}>abort the series instead</Text>
                ) : (
                  <ConfirmButton
                    armed={confirming === game.gameId}
                    busy={busy}
                    label={outcome === 'void' ? 'VOID' : 'STOP'}
                    onArm={() => setConfirming(game.gameId)}
                    onConfirm={() => stop(game)}
                  />
                )}
              </View>
            ))}
          </View>
        </>
      )}
    </Panel>
  );
}

const styles = themedSheet(() => ({
  blocked: { ...type.meta, color: colors.textFaint, maxWidth: 140 },
}));
