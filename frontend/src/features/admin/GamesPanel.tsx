import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import GameRow from './GameRow';
import LiveGamesPanel from './LiveGamesPanel';
import { adminStyles } from './adminStyles';
import { failureMessage } from '@/errors';
import type { AdminToken } from '@/hooks/useAdminToken';
import { deleteGame, listAdminGames } from '@/store/api/bots';
import type { GameRecord } from '@/types/protocol';
import {
  Banner,
  Checkbox,
  EmptyState,
  GhostButton,
  LabeledInput,
  Panel,
  SectionHeading,
} from '@/ui/primitives';

// The games: the ones being played, and the ones on record.
//
// Two panels in one tab because they are the same subject at two ages, and a
// host who has come here has one of two questions — "stop that" or "that
// shouldn't have counted". The live one goes first, since it is the one with a
// clock running on it.

export interface GamesPanelProps {
  admin: AdminToken;
}

export default function GamesPanel({ admin }: GamesPanelProps) {
  const [query, setQuery] = useState('');
  const [games, setGames] = useState<GameRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Deleting a game hands its rating back by default, because the usual reason
  // to delete one is that the result should not stand. The exception — a game
  // removed for being unwatchable, whose result was fair — is a toggle rather
  // than a second button, since it applies to whichever row is pressed next.
  const [revertRatings, setRevertRatings] = useState(true);

  const refresh = useCallback(
    async (searchText = query) => {
      if (!admin.token) return;
      try {
        setGames((await listAdminGames(admin.token, searchText)) ?? []);
      } catch (caught) {
        setError(failureMessage(caught));
      }
    },
    [admin.token, query],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  const removeGame = async (gameId: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await deleteGame(admin.token, gameId, revertRatings);
      setNotice(
        revertRatings
          ? 'Game deleted. Both players have their rating back.'
          : 'Game deleted. The ratings it moved were left alone.',
      );
      await refresh();
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  return (
    <>
      <LiveGamesPanel admin={admin} />

      <Panel style={adminStyles.panel}>
        <SectionHeading eyebrow="ADMINISTRATION" title="Game history" />
        {error ? (
          <Banner message={error} onDismiss={() => setError(null)} tone="error" />
        ) : null}
        {notice ? <Banner message={notice} onDismiss={() => setNotice(null)} /> : null}
        <View style={adminStyles.searchRow}>
          <View style={adminStyles.searchField}>
            <LabeledInput
              autoCapitalize="none"
              label="SEARCH"
              onChangeText={setQuery}
              onSubmitEditing={() => refresh()}
              placeholder="username, user id, or game id"
              value={query}
            />
          </View>
          <GhostButton label="SEARCH" onPress={() => refresh()} />
        </View>
        <Checkbox
          checked={revertRatings}
          label="Give both players their rating back"
          onToggle={() => setRevertRatings((current) => !current)}
        />

        {games.length === 0 ? (
          <EmptyState detail="Nothing matched that search." title="No games" />
        ) : (
          <View style={adminStyles.list}>
            {games.map((game) => (
              <GameRow
                armed={confirming === `game:${game.gameId}`}
                busy={busy}
                game={game}
                key={game.gameId}
                onArm={() => setConfirming(`game:${game.gameId}`)}
                onDelete={() => removeGame(game.gameId)}
              />
            ))}
          </View>
        )}
        <Text style={adminStyles.help}>
          A deleted game leaves the history, the archive, and any review of it. With the box
          above ticked — which is the default, since the usual reason to delete a game is that
          its result should not stand — the Elo and the win counts it moved are reversed for
          both players. That reversal is exact for the last game somebody played and an
          approximation for an older one, because the games since were rated against a number
          that has now changed.
        </Text>
      </Panel>
    </>
  );
}
