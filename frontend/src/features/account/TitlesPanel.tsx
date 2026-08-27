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
// holds, then everything it does not, with the requirement spelled out. A
// catalogue that only showed what you already had would be a trophy cabinet;
// showing the rest is what makes a title something to go and get.
//
// Choosing saves immediately rather than behind a button. There is nothing to
// validate — every option came from the server as something already owned — and
// a picker that needs confirming reads as though the choice might be refused.
//
// The second list starts folded. On a new account it is the whole catalogue, and
// a page whose first screenful is ten things you do not have reads as a list of
// failures rather than as a cabinet with room in it.

const NONE = '' as const;

/** How a held title explains itself: the rule, or the fact of the grant. */
const awardDetail = (award: TitleAward) =>
  award.source === 'granted' ? `${award.name} · granted by the host` : award.name;

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
  const unearned = catalogue.filter((title) => !heldIds.has(title.id));
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
        {held.length === 0
          ? 'Titles are earned by playing, and sit in front of your name in games and chat. You have none yet.'
          : 'The one you choose sits in front of your name in every game and every message. Titles are yours for good once earned.'}
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
              label={award.id}
              onPress={() => choose(award.id)}
              selected={worn === award.id}
              tag
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
                  <Text style={styles.unearnedTag}>{title.id}</Text>
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

/** One row of the picker: a tag, what it is, and whether it is the one worn. */
function Choice({
  busy,
  detail,
  disabled,
  label,
  onPress,
  selected,
  tag,
}: {
  busy: boolean;
  detail: string;
  disabled: boolean;
  label: string;
  onPress: () => void;
  selected: boolean;
  /** Draw the label as the gold tag rather than as words. */
  tag?: boolean;
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
      {tag ? <TitleTag size="large" title={label} /> : <Text style={styles.noneTag}>—</Text>}
      <View style={styles.choiceCopy}>
        <Text style={styles.choiceLabel}>{tag ? detail : label}</Text>
        {tag ? null : <Text style={styles.choiceDetail}>{detail}</Text>}
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
    minWidth: 30,
    ...type.label,
    color: colors.textFaint,
    paddingTop: space.hair,
    textAlign: 'center',
  },
  unearnedCopy: { flex: 1, minWidth: 0 },
  unearnedName: { ...type.body, color: colors.textMuted, fontWeight: '800' },
  unearnedRule: { ...type.meta, color: colors.textFaint },
  pressed: { opacity: 0.7 },
});
