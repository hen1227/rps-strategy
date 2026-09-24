import { Pressable, StyleSheet, Text, View } from 'react-native';

import { adminStyles } from './adminStyles';
import { colors, radius, space, themedSheet, type } from '@/theme';
import type { Account, Title, TitleID } from '@/types/protocol';

// Awarding titles.
//
// One list rather than a picker and a list beside it. "Which titles does this
// person have" is the question being asked, and "can I give them GM" is the
// same row pressed from the other side — so held ones are gold and take the
// title away, and the rest are grey and hand it over.
//
// Granting is not double-confirmed the way the buttons around it are. Nothing
// here is destructive: the worst outcome is a tag on the wrong name, undone by
// pressing the same row again. The confirmation on the delete buttons exists
// because those cannot be undone, and applying it here would teach a host to
// press through confirmations.
//
// The one thing worth knowing about the model: a title can be *earned* or
// *granted*, and revoking only removes a grant. An earned one — a rating title,
// a tournament win — is recomputed from the record, so taking it away by hand
// would last until the next game.

export interface TitleEditorProps {
  account: Account;
  busy: boolean;
  /** The whole catalogue, so the titles they do *not* hold are offerable. */
  catalogue: Title[];
  onGrant: (title: TitleID) => void;
  onRevoke: (title: TitleID) => void;
}

export default function TitleEditor({
  account,
  busy,
  catalogue,
  onGrant,
  onRevoke,
}: TitleEditorProps) {
  const held = new Map((account.titles ?? []).map((award) => [award.id, award]));
  if (catalogue.length === 0) {
    return <Text style={adminStyles.detailNote}>Loading titles…</Text>;
  }
  return (
    <View style={styles.row}>
      {catalogue.map((title) => {
        const award = held.get(title.id);
        // An earned title is shown as held and is not offered for removal:
        // the rules would award it again. Pressing it does nothing rather
        // than failing, which is why it is disabled rather than absent — a
        // host looking for "why can I not take GM away" should be able to see
        // that the row is inert.
        const earned = award?.source === 'earned';
        return (
          <Pressable
            accessibilityLabel={
              earned
                ? `${title.name} is earned and cannot be revoked`
                : award
                  ? `Revoke ${title.name} from ${account.username}`
                  : `Grant ${title.name} to ${account.username}`
            }
            accessibilityRole="button"
            accessibilityState={{ selected: Boolean(award), disabled: busy || earned }}
            disabled={busy || earned}
            key={title.id}
            onPress={() => (award ? onRevoke(title.id) : onGrant(title.id))}
            style={({ pressed }) => [
              styles.chip,
              award && styles.chipHeld,
              earned && styles.chipEarned,
              busy && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.chipId, award && styles.chipIdHeld]}>{title.id}</Text>
            <Text numberOfLines={1} style={styles.chipName}>
              {earned ? 'earned' : award ? 'granted' : title.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = themedSheet(() => ({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.snug,
    paddingVertical: space.snug,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.tight,
    paddingHorizontal: space.small,
    paddingVertical: space.tight,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    maxWidth: 180,
  },
  chipHeld: { borderColor: colors.goldBorder, backgroundColor: colors.goldSurfaceDeep },
  // Earned reads as held-and-settled rather than as pressable: the same gold,
  // dimmer, because it is a statement rather than a control.
  chipEarned: { opacity: 0.75 },
  chipId: { ...type.label, color: colors.textMuted },
  chipIdHeld: { color: colors.goldBright },
  chipName: { fontSize: 8, color: colors.textFaint, flexShrink: 1 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
}));
