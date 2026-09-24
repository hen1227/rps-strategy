import { StyleSheet, Text, View } from 'react-native';

import BotIcon from '@/features/bots/BotIcon';
import { ratingLabel } from '@/features/ratings/scale';
import { botIconUrl } from '@/store/api/bots';
import { links } from '@/navigation/links';
import type { ProfileBot } from '@/store/api/players';
import { colors, space, themedSheet, type } from '@/theme';
import PlayerLink from '@/ui/PlayerLink';
import { GhostLink, Panel, SectionHeading } from '@/ui/primitives';

// The engines somebody wrote.
//
// Only rendered when there are any, rather than as an empty panel on every
// page: most players own no bots, and "No bots" is a row that tells nobody
// anything. It is the one panel on the profile that disappears entirely.
//
// Each row links to the engine's *own* page, because a bot has one: it is an
// account with a rating and a history, and its page is where those live.

export interface ProfileBotsProps {
  bots: ProfileBot[];
  /** Whose page this is, for the panel's copy. */
  owner: string;
}

export default function ProfileBots({ bots, owner }: ProfileBotsProps) {
  if (bots.length === 0) return null;
  return (
    <Panel>
      <SectionHeading
        eyebrow="ENGINES"
        title={bots.length === 1 ? 'Bot' : 'Bots'}
      />
      <Text style={styles.help}>
        Written by {owner}. Each one plays under its own account, with its own rating.
      </Text>
      <View style={styles.list}>
        {bots.map((bot) => (
          <View key={bot.botId} style={styles.row}>
            <BotIcon
              name={bot.name}
              size={28}
              uri={botIconUrl(bot.botId, bot.iconSha256)}
            />
            <View style={styles.copy}>
              <PlayerLink
                handle={bot.username}
                name={bot.name}
                numberOfLines={1}
                style={styles.name}
              />
              {bot.description ? (
                <Text numberOfLines={1} style={styles.meta}>
                  {bot.description}
                </Text>
              ) : null}
            </View>
            {/*
              A dash where the engine has no measured rating, the same as its
              own page and the same as the ladder: a column of ratings is
              exactly where the floor and the absence of a number look most
              alike. See features/ratings/scale.
            */}
            <Text style={styles.elo}>{ratingLabel(bot.elo, bot.ratingState)}</Text>
            <GhostLink compact href={links.player(bot.username)} label="OPEN" />
          </View>
        ))}
      </View>
    </Panel>
  );
}

const styles = themedSheet(() => ({
  help: { ...type.body, color: colors.textFaint, marginTop: space.tight },
  list: { marginTop: space.small },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    paddingVertical: space.snug,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  copy: { flex: 1, minWidth: 120 },
  name: { ...type.rowTitle, color: colors.text },
  meta: { ...type.meta, color: colors.textFaint, marginTop: 2 },
  elo: { ...type.body, color: colors.goldBright, fontWeight: '800' },
}));
