import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import ReignNote from './ReignNote';
import { RatioBar, ladderRecord, recordLine, winRateLabel } from './ladderRecord';
import BotIcon from '@/features/bots/BotIcon';
import {
  RATING_UNRATED_LABEL,
  ratingCaveat,
  ratingIsRankable,
  ratingLabel,
} from '@/features/ratings/scale';
import { links } from '@/navigation/links';
import { botIconUrl } from '@/store/api/bots';
import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, themedSheet, type } from '@/theme';
import ListRow from '@/ui/ListRow';
import Monogram from '@/ui/Monogram';
import TitleTag from '@/ui/TitleTag';
import { Badge } from '@/ui/primitives';
import type { ModeID } from '@/types/game';
import type { LeaderboardEntry } from '@/types/protocol';

// The rows of a ladder, wherever one is shown.
//
// Every row goes somewhere. This used to be a name with a PROFILE button beside
// it, which is two things to look at for one destination and a button to hunt
// for on a page of forty of them; the whole row is the link now, the way the
// lobby's rows and the documentation's rows already were. The button is gone
// rather than moved — an anchor inside an anchor has no defined meaning on the
// web, and a row that navigates has nothing left for a second one to do.
//
// A bot row says more than a person's, because there is more to say: an engine
// has an author who answers for it and a version that says which build this
// record belongs to, and neither is derivable from its name.

/** The medal colours, best three only. Fourth place is a number, not a colour. */
const rankTone = (rank: number) => {
  if (rank === 1) return styles.rankFirst;
  if (rank <= 3) return styles.rankPodium;
  return undefined;
};

export interface LadderRowsProps {
  entries: LeaderboardEntry[];
  /** Set on a per-mode board, so a row knows not to name a mode again. */
  modeId?: ModeID | null;
  /** Draw a portrait beside the rank. Bots have one; people get a monogram. */
  showPortraits?: boolean;
  /** Mark this account's own row, when it can appear here. */
  highlightUserId?: string;
  /** Room for the ratio bar and the win rate. Dropped on a narrow screen. */
  wide?: boolean;
}

export default function LadderRows({
  entries,
  modeId = null,
  showPortraits = false,
  highlightUserId,
  wide = false,
}: LadderRowsProps) {
  const modes = useGameStore((state) => state.modes);
  const modeName = (id: string | undefined) => modes.find((mode) => mode.id === id)?.name ?? id;

  // On the combined board the rating is the account's strongest mode, so the row
  // has to say which one — a number with no scope attached invites the reader to
  // think it is one rating for the whole game, which this game does not have.
  // The counters beside it are lifetime totals, which do cover every mode.
  const scopeOf = (entry: LeaderboardEntry) =>
    modeId ? '' : `best in ${modeName(entry.modeId)} · `;

  return (
    <View style={styles.list}>
      {entries.map((entry, index) => {
        const result = ladderRecord(entry);
        const you = entry.userId === highlightUserId;
        return (
          <Link asChild href={links.player(entry.username)} key={entry.userId}>
            <Pressable
              accessibilityLabel={
                ratingIsRankable(entry.ratingState)
                  ? `${entry.username}, rated ${entry.elo}. Open their page.`
                  : `${entry.username}, ${RATING_UNRATED_LABEL}. Open their page.`
              }
              accessibilityRole="link"
              // One resolved style object, not an array and not the usual
              // `({ pressed })` function: `Link asChild` clones this child into
              // a real anchor and an array throws on the way into the DOM node.
              // See the longer note in `GhostLink`.
              style={StyleSheet.flatten([styles.pressable, you && styles.you])}
            >
              <ListRow
                divided={index > 0}
                leading={
                  <View style={styles.leading}>
                    <Text style={[styles.rank, rankTone(entry.rank)]}>{entry.rank}</Text>
                    {showPortraits ? (
                      <BotIcon
                        name={entry.username}
                        size={30}
                        uri={botIconUrl(entry.userId, entry.iconSha256)}
                      />
                    ) : (
                      <Monogram name={entry.username} round size={30} />
                    )}
                  </View>
                }
                meta={
                  <View style={styles.metaBlock}>
                    <Text numberOfLines={1} style={styles.meta}>
                      {scopeOf(entry)}
                      {recordLine(result)}
                    </Text>
                    {/*
                      The words, where the dash on the right is only a gap.
                      A row with a long record and no rating is the confusing
                      case — it looks like a rating of nothing rather than the
                      absence of one — so the reason sits under the record it
                      appears to contradict. Provisional says the softer version
                      of the same thing: there is a number, and it is still
                      moving.
                    */}
                    {ratingCaveat(entry.ratingState) ? (
                      <Text numberOfLines={1} style={styles.caveat}>
                        {ratingCaveat(entry.ratingState)}
                      </Text>
                    ) : null}
                    {/*
                      Who to talk to about this engine, and which build the
                      record belongs to. Both only when the server sent them: a
                      server older than the fields sends neither, and "by —"
                      would be the row inventing a gap.
                    */}
                    {entry.ownerUsername ? (
                      <Text numberOfLines={1} style={styles.byline}>
                        by {entry.ownerUsername}
                        {entry.engineName ? ` · ${entry.engineName}` : ''}
                      </Text>
                    ) : null}
                    <ReignNote entry={entry} isBot={entry.kind === 'bot'} />
                  </View>
                }
                title={
                  <View style={styles.nameRow}>
                    <TitleTag title={entry.title} />
                    <Text numberOfLines={1} style={styles.name}>
                      {entry.username}
                    </Text>
                    {you ? <Badge label="YOU" tone="accent" /> : null}
                  </View>
                }
                trailing={
                  <View style={styles.trailing}>
                    {/*
                      The ratio, at the width a column of them can be compared
                      down. Only where there is room: on a phone it would be the
                      one thing squeezing the name it describes.
                    */}
                    {wide ? (
                      <View style={styles.ratio}>
                        <Text style={styles.rate}>{winRateLabel(result)}</Text>
                        <RatioBar result={result} />
                      </View>
                    ) : null}
                    {/*
                      A dash rather than the number, when the number is not one.
                      The floor of this scale means "plays no better than
                      chance", so printing it for an account nobody has managed
                      to measure would be making a claim about them — see
                      ratingLabel. The row keeps its place and its record; what
                      it loses is a figure it has not earned.
                    */}
                    <Text style={styles.elo}>{ratingLabel(entry.elo, entry.ratingState)}</Text>
                    <Text style={styles.chevron}>›</Text>
                  </View>
                }
              />
            </Pressable>
          </Link>
        );
      })}
    </View>
  );
}

const styles = themedSheet(() => ({
  list: { marginTop: space.small },
  pressable: { width: '100%' },
  leading: { flexDirection: 'row', alignItems: 'center', gap: space.snug, minWidth: 34 },
  rank: { ...type.rowTitle, color: colors.textFaint, minWidth: 20, textAlign: 'right' },
  rankFirst: { color: colors.gold },
  rankPodium: { color: colors.goldMuted },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  name: { ...type.rowTitle, color: colors.text, flexShrink: 1 },
  metaBlock: { marginTop: space.hair },
  meta: { ...type.meta, color: colors.textFaint },
  byline: { ...type.meta, color: colors.textDim },
  // Dimmer than the record above it: this is the row explaining itself, not a
  // second fact about the player.
  caveat: { ...type.meta, color: colors.textFaint },
  you: {
    borderRadius: radius.small,
    backgroundColor: colors.accentSurfaceQuiet,
    paddingHorizontal: space.snug,
  },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: space.medium },
  ratio: { width: 72, gap: space.hair, alignItems: 'flex-end' },
  rate: { ...type.meta, color: colors.textMuted },
  elo: { ...type.cardTitle, color: colors.textStrong, minWidth: 46, textAlign: 'right' },
  chevron: { color: colors.textFaint, fontSize: 18, paddingLeft: space.tight },
}));
