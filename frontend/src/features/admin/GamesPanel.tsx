import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import GameRow from './GameRow';
import LiveGamesPanel from './LiveGamesPanel';
import { adminStyles } from './adminStyles';
import { failureMessage } from '@/errors';
import type { AdminToken } from '@/hooks/useAdminToken';
import {
  deleteGame,
  listAdminGames,
  setAdminGameRanked,
  type AdminGameRecord,
} from '@/store/api/bots';
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
  const [games, setGames] = useState<AdminGameRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Deleting a game takes its result off both records by default, because the
  // usual reason to delete one is that the result should not stand. The
  // exception — a game removed for being unwatchable, whose result was fair —
  // is a toggle rather than a second button, since it applies to whichever row
  // is pressed next. Ratings are recomputed without the game either way.
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
          ? 'Game deleted. Ratings recomputed without it.'
          : 'Game deleted. Ratings recomputed; win counts kept.',
      );
      await refresh();
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  // No confirmation, unlike delete: the same press puts it back, and every
  // rating is recomputed from the record rather than adjusted.
  const toggleRanked = async (game: AdminGameRecord) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await setAdminGameRanked(admin.token, game.gameId, !game.ranked);
      setNotice(
        game.ranked
          ? 'Game made casual. Ratings recomputed without it.'
          : 'Game made ranked. Ratings recomputed with it.',
      );
      await refresh();
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
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
          label="Take the result off both players' records"
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
                onToggleRanked={() => toggleRanked(game)}
              />
            ))}
          </View>
        )}
        <Text style={adminStyles.help}>
          Deletion removes the game from history, archives, and reviews, and every rating is recomputed as if it had never been played. Keep the box checked to take it off both players' win counts too.
        </Text>
        <Text style={adminStyles.help}>
          A game between two engines can also be made ranked or casual. Ratings are recomputed from every game, so the change is exact and can be undone. Games with a person in them cannot be moved.
        </Text>
      </Panel>
    </>
  );
}
