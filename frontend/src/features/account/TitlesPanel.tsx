import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { failureMessage } from '@/errors';
import { getTitleCatalogue, setAccountTitle } from '@/store/api/accounts';
import { isSignedIn } from '@/store/accountSession';
import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, type } from '@/theme';
import TitleTag from '@/ui/TitleTag';
import { Banner, Panel, SectionHeading } from '@/ui/primitives';
import type { Account, Title, TitleAward, TitleID } from '@/types/protocol';

// The collection, and the one you are wearing.
//
// Two lists, and the second is the point of the first: everything this account
// holds, then everything still to go and get. Both spell out the rule, held ones
// included — three letters and a name do not say what somebody did to get there,
// and a collection you cannot read back is a worse prize than one you can.
// A catalogue that only showed what you already had would be a trophy cabinet;
// showing the rest is what makes a title something to chase. The rest is only
// what a player can actually chase — see `unearned`.
//
// Choosing saves immediately rather than behind a button. There is nothing to
// validate — every option came from the server as something already owned — and
// a picker that needs confirming reads as though the choice might be refused.
//
// The second list starts folded. On a new account it is the whole catalogue, and
// a page whose first screenful is every title you do not have reads as a list of
// failures rather than as a cabinet with room in it.

const NONE = '' as const;

/**
 * How a held title explains itself: the rule it was earned by, or the fact of
 * the grant. The same sentence the list below shows for one still to earn, so
 * that earning a title changes where it sits rather than what it says it is.
 *
 * Source rather than kind decides, because an administrator can hand out a
 * rating title, and "Reach 2000 in any mode." under a tag nobody reached 2000
 * for would be the one description here that is not true. The granted-kind
 * titles keep their own wording — it already says who gave it and what for.
 */
const awardDetail = (award: TitleAward) =>
  award.source === 'earned' || award.kind === 'granted'
    ? award.requirement
    : 'Granted by the host.';

export interface TitlesPanelProps {
  account: Account | null | undefined;
  /** Absent until the account is registered and signed in; nothing can be worn without one. */
  sessionToken: string | null;
}

export default function TitlesPanel({ account, sessionToken }: TitlesPanelProps) {
  const applyAccountUpdate = useGameStore((state) => state.applyAccountUpdate);
  const [catalogue, setCatalogue] = useState<Title[]>([]);
  const [saving, setSaving] = useState<TitleID | typeof NONE | null>(null);
  const [showUnearned, setShowUnearned] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The whole catalogue, for the "still to earn" half. A failure here is not
  // worth a banner: the collection above it is the part that matters, and it
  // came with the account.
  useEffect(() => {
    let cancelled = false;
    getTitleCatalogue()
      .then((titles) => {
        if (!cancelled) setCatalogue(titles);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const held = account?.titles ?? [];
  const worn = account?.title ?? NONE;
  const heldIds = new Set(held.map((award) => award.id));
  // Granted titles are left out of the second list. Nothing a player does
  // earns one, so a row promising "granted by the host" under a heading that
  // says STILL TO EARN sets a goal that does not exist. They are in the list
  // above the moment somebody is given one, which is the only way to get one.
  const unearned = catalogue.filter(
    (title) => !heldIds.has(title.id) && title.kind !== 'granted',
  );
  const canChoose = isSignedIn(sessionToken, account);

  const choose = async (title: TitleID | typeof NONE) => {
    if (!account || !sessionToken || title === worn) return;
    setSaving(title);
    setError(null);
    try {
      const updated = await setAccountTitle(account.userId, sessionToken, title);
      // Reconnects the lobby socket, which is what rebuilds the profile every
      // other player sees this account through. Without it the new tag would
      // be on the account page and nowhere else until the next reload.
      applyAccountUpdate(updated);
    } catch (requestError) {
      setError(failureMessage(requestError));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Panel>
      <SectionHeading eyebrow="TITLES" title="Your titles" />
      <Text style={styles.helper}>
        {held.length === 0 && 'Titles are earned by playing! You have none yet.'}
      </Text>

      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}

      {held.length > 0 ? (
        <View style={styles.list}>
          <Choice
            busy={saving === NONE}
            disabled={!canChoose || saving !== null}
            detail="Just your name."
            label="No title"
            onPress={() => choose(NONE)}
            selected={worn === NONE}
          />
          {held.map((award) => (
            <Choice
              busy={saving === award.id}
              detail={awardDetail(award)}
              disabled={!canChoose || saving !== null}
              key={award.id}
              label={award.name}
              onPress={() => choose(award.id)}
              selected={worn === award.id}
              tagId={award.id}
            />
          ))}
        </View>
      ) : null}

      {held.length > 0 && !canChoose ? (
        <Text style={styles.note}>
          Claim a username to wear one. Everything you have earned stays with the account.
        </Text>
      ) : null}

      {unearned.length > 0 ? (
        <View style={styles.unearned}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showUnearned }}
            onPress={() => setShowUnearned((open) => !open)}
            style={({ pressed }) => [styles.unearnedToggle, pressed && styles.pressed]}
          >
            <Text style={styles.unearnedHeading}>STILL TO EARN · {unearned.length}</Text>
            <Text style={styles.unearnedMark}>{showUnearned ? '▾' : '▸'}</Text>
          </Pressable>

          {showUnearned ? (
            <View style={styles.unearnedList}>
              {unearned.map((title) => (
                <View key={title.id} style={styles.unearnedRow}>
                  {/*
                    The real tag, dimmed, rather than the letters in grey. Each
                    title has a colour of its own and that colour is part of
                    what there is to want — a list that hid it until the moment
                    you earned it would be describing a different prize. The
                    dimming is what keeps it clearly not yours yet.
                  */}
                  <View style={styles.unearnedTag}>
                    <TitleTag size="medium" title={title.id} />
                  </View>
                  <View style={styles.unearnedCopy}>
                    <Text style={styles.unearnedName}>{title.name}</Text>
                    <Text style={styles.unearnedRule}>{title.requirement}</Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </Panel>
  );
}

/** One row of the picker: a tag, what it is, how it was come by, and whether it is the one worn. */
function Choice({
  busy,
  detail,
  disabled,
  label,
  onPress,
  selected,
  tagId,
}: {
  busy: boolean;
  detail: string;
  disabled: boolean;
  label: string;
  onPress: () => void;
  selected: boolean;
  /** The title this row is for, drawn as its own tag. Absent on the "no title" row. */
  tagId?: TitleID;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        selected && styles.choiceSelected,
        disabled && styles.choiceDisabled,
        pressed && styles.pressed,
      ]}
    >
      {tagId ? <TitleTag size="large" title={tagId} /> : <Text style={styles.noneTag}>—</Text>}
      <View style={styles.choiceCopy}>
        <Text style={styles.choiceLabel}>{label}</Text>
        <Text style={styles.choiceDetail}>{detail}</Text>
      </View>
      <Text style={[styles.mark, selected && styles.markSelected]}>
        {busy ? '…' : selected ? '●' : '○'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  helper: { ...type.body, color: colors.textMuted, marginTop: space.small },
  note: { ...type.meta, color: colors.textFaint, marginTop: space.small },
  list: { gap: space.snug, marginTop: space.medium },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    paddingVertical: space.small,
    paddingHorizontal: space.medium,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: colors.surfaceMuted,
  },
  choiceSelected: { borderColor: colors.goldBorder, backgroundColor: colors.goldSurfaceDeep },
  choiceDisabled: { opacity: 0.5 },
  choiceCopy: { flex: 1, minWidth: 0 },
  choiceLabel: { ...type.rowTitle, color: colors.text },
  choiceDetail: { ...type.meta, color: colors.textFaint, marginTop: space.hair },
  noneTag: {
    minWidth: 24,
    color: colors.textFaint,
    fontSize: 13,
    fontWeight: '900',
    textAlign: 'center',
  },
  mark: { color: colors.textFaint, fontSize: 11 },
  markSelected: { color: colors.gold },

  unearned: { marginTop: space.large },
  unearnedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.small,
    paddingVertical: space.tight,
  },
  unearnedHeading: { ...type.eyebrow, color: colors.textSoft },
  unearnedMark: { color: colors.textFaint, fontSize: 11 },
  unearnedList: { gap: space.snug, marginTop: space.tight },
  unearnedRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.small },
  unearnedTag: {
    // Fixed rather than minimum, so a three-letter tag does not push its own
    // row's copy further right than the two-letter rows beside it.
    width: 38,
    alignItems: 'center',
    paddingTop: space.hair,
    opacity: 0.55,
  },
  unearnedCopy: { flex: 1, minWidth: 0 },
  unearnedName: { ...type.body, color: colors.textMuted, fontWeight: '800' },
  unearnedRule: { ...type.meta, color: colors.textFaint },
  pressed: { opacity: 0.7 },
});
