import { Text, View } from 'react-native';

import ConfirmButton from './ConfirmButton';
import { adminStyles } from './adminStyles';
import { links } from '@/navigation/links';
import type { AdminGameRecord } from '@/store/api/bots';
import { Badge, GhostButton, GhostLink } from '@/ui/primitives';

// One stored game, as a line an administrator can identify it from and act on.
//
// Shared between the account browser — where it is a row inside somebody's
// expanded detail — and the game browser, where it is a row of the whole
// archive. The same row in both, deliberately: an administrator who learns to
// read it in one place should not have to learn it again in the other.

export interface GameRowProps {
  armed: boolean;
  busy: boolean;
  game: AdminGameRecord;
  onArm: () => void;
  onDelete: () => void;
  /**
   * Move the game to the other side of ranked and casual. Offered only on a
   * game between two engines, which is the only kind the server can move.
   */
  onToggleRanked?: () => void;
}

export default function GameRow({
  armed,
  busy,
  game,
  onArm,
  onDelete,
  onToggleRanked,
}: GameRowProps) {
  const played = new Date(game.finishedAtUnixMs);
  const outcome =
    game.outcome === 'draw'
      ? 'draw'
      : `${game.outcome === 'red_win' ? game.redPlayer.username : game.bluePlayer.username} won`;
  return (
    <View style={adminStyles.subRow}>
      <View style={adminStyles.rowCopy}>
        <Text numberOfLines={1} style={adminStyles.subRowName}>
          {game.redPlayer.username} vs {game.bluePlayer.username}
        </Text>
        <Text numberOfLines={1} style={adminStyles.rowMeta}>
          {game.modeName} · {outcome} · {game.endReason} ·{' '}
          {Number.isFinite(played.valueOf()) ? played.toLocaleDateString() : 'undated'} ·{' '}
          {game.gameId}
        </Text>
      </View>
      {game.ranked ? <Badge label="RANKED" tone="neutral" /> : null}
      {/*
        Before the delete button, because the usual reason to be looking at a
        game on this screen is to find out whether it should be deleted, and
        that question is answered by watching it rather than by reading the row.
      */}
      <GhostLink compact href={links.review(game.gameId)} label="REVIEW" />
      {/*
        Beside delete, as the gentler answer to the same question: "that
        shouldn't have counted" is often all that is wrong with a game, and it
        can be put back with the same press.
      */}
      {game.engineGame && onToggleRanked ? (
        <GhostButton
          accessibilityLabel={`${game.ranked ? 'Make casual' : 'Make ranked'}: ${
            game.redPlayer.username
          } against ${game.bluePlayer.username}`}
          compact
          disabled={busy}
          label={game.ranked ? 'MAKE CASUAL' : 'MAKE RANKED'}
          onPress={onToggleRanked}
        />
      ) : null}
      <ConfirmButton
        armed={armed}
        busy={busy}
        label="DELETE"
        onArm={onArm}
        onConfirm={onDelete}
      />
    </View>
  );
}
