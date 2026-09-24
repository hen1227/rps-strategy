import { StyleSheet, Text, View } from 'react-native';

import { links } from '@/navigation/links';
import type { ProfileTournament } from '@/store/api/players';
import { colors, space, themedSheet, type } from '@/theme';
import { Badge, EmptyState, GhostLink, Panel, SectionHeading } from '@/ui/primitives';
import type { BadgeTone } from '@/ui/tones';

// The events on somebody's page.
//
// One row an event, most recent first, and the only thing it works to say is
// where they finished. A placement on its own is not that — third is a
// different result out of four than out of forty — so the field size travels
// with it, which is why the server publishes both.

/** How a placement reads: the medal positions get a word, the rest a number. */
const placementLabel = (placement: number): string => {
  switch (placement) {
    case 1:
      return 'Champion';
    case 2:
      return 'Runner-up';
    case 3:
      return 'Third';
    default:
      return `${placement}th`;
  }
};

/** A placement's colour: gold for the win, warm for the rest of the podium. */
const placementTone = (placement: number): BadgeTone => {
  if (placement === 1) return 'gold';
  if (placement <= 3) return 'warm';
  return 'neutral';
};

/** What an unfinished event says instead of a placement. */
const statusLabel = (entry: ProfileTournament): string => {
  switch (entry.status) {
    case 'registration':
      return 'ENTERED';
    case 'in_progress':
      return 'PLAYING';
    case 'cancelled':
      return 'CANCELLED';
    default:
      // Completed with no placement, which happens when an event finished
      // without this entrant appearing in the standings — a withdrawal before
      // the field closed.
      return 'FINISHED';
  }
};

export interface ProfileTournamentsProps {
  tournaments: ProfileTournament[];
}

export default function ProfileTournaments({ tournaments }: ProfileTournamentsProps) {
  return (
    <Panel>
      <SectionHeading eyebrow="TOURNAMENTS" title="Events" />
      {tournaments.length === 0 ? (
        <EmptyState
          detail="Events appear here once they have been entered."
          title="No tournaments"
        />
      ) : (
        <View style={styles.list}>
          {tournaments.map((entry) => (
            <View key={entry.tournamentId} style={styles.row}>
              <View style={styles.copy}>
                <Text numberOfLines={1} style={styles.name}>
                  {entry.name}
                </Text>
                <Text numberOfLines={1} style={styles.meta}>
                  {entry.modeName} · {entry.fieldSize} entrant
                  {entry.fieldSize === 1 ? '' : 's'}
                </Text>
              </View>
              {entry.placement ? (
                <Badge
                  label={`${placementLabel(entry.placement)} of ${entry.fieldSize}`}
                  tone={placementTone(entry.placement)}
                />
              ) : (
                <Badge label={statusLabel(entry)} tone="neutral" />
              )}
              <GhostLink
                compact
                href={links.tournaments(entry.tournamentId)}
                label="OPEN"
              />
            </View>
          ))}
        </View>
      )}
    </Panel>
  );
}

const styles = themedSheet(() => ({
  list: { marginTop: space.small },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.small,
    paddingVertical: space.snug,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  copy: { flex: 1, minWidth: 160 },
  name: { ...type.rowTitle, color: colors.text },
  meta: { ...type.meta, color: colors.textFaint, marginTop: 2 },
}));
