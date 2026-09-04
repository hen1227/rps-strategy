import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { adminStyles } from './adminStyles';
import type { AdminRestriction } from '@/store/api/admin';
import { colors, radius, space, type } from '@/theme';
import type { RestrictionKind } from '@/types/protocol';
import { Badge, GhostButton, LabeledInput, OptionChips } from '@/ui/primitives';

// Placing and lifting the three sanctions.
//
// The set is deliberately small, and the reason is worth having in front of you
// while editing this: `disabled` on the account row above is the whole hammer —
// the account stops existing, every session is revoked, the connection closes.
// It is almost never what an incident calls for. These three are the narrow
// answers, so that the alternative to a proportionate response is not "the
// hammer or nothing":
//
//   - **Mute** stops chat *and* challenges. Those travel together because a
//     challenge carries a username somebody typed and lands in that person's
//     inbox, which is the second way to put words in front of somebody who does
//     not want them.
//   - **No ranked** keeps them playing and off the ladder. A rated game is
//     downgraded to casual exactly the way a guest's is, so this never leaves
//     anybody unable to play.
//   - **No tournaments** refuses signups. An event already entered is left
//     alone, because withdrawing somebody from a started round robin rewrites
//     results other people earned.
//
// The durations offered are all finite except one, and that is the point rather
// than an oversight: a sanction with no end is a thing to remember to undo, and
// the ones nobody remembers quietly become permanent. "Until lifted" is
// available and is last.

/** What each sanction is called where a host is choosing one. */
const KIND_LABEL: Record<RestrictionKind, string> = {
  mute: 'Mute',
  ranked: 'No ranked',
  tournament: 'No tournaments',
};

/** The one-line explanation under each, so the choice is not from a name alone. */
const KIND_DETAIL: Record<RestrictionKind, string> = {
  mute: 'No chat and no challenges. They can still play.',
  ranked: 'Rated games become casual. Nothing else changes.',
  tournament: 'No new signups. Events already entered stand.',
};

/**
 * The durations on offer.
 *
 * Hours rather than an arbitrary number field: a host reaching for this is
 * reacting to something and should not also have to decide whether 5400 seconds
 * is the right answer. Zero is "until lifted".
 */
const DURATIONS: { label: string; value: number }[] = [
  { label: '1 hour', value: 3600 },
  { label: '1 day', value: 86_400 },
  { label: '1 week', value: 604_800 },
  { label: '30 days', value: 2_592_000 },
  { label: 'Until lifted', value: 0 },
];

/** How a sanction's remaining time reads, or why it no longer applies. */
const standing = (restriction: AdminRestriction): { label: string; active: boolean } => {
  if (restriction.expiresAtUnixMs === undefined) {
    return { label: 'until lifted', active: true };
  }
  const remaining = restriction.expiresAtUnixMs - Date.now();
  if (remaining <= 0) return { label: 'expired', active: false };
  const hours = Math.round(remaining / 3_600_000);
  if (hours < 1) return { label: 'under an hour left', active: true };
  if (hours < 48) return { label: `${hours}h left`, active: true };
  return { label: `${Math.round(hours / 24)}d left`, active: true };
};

export interface ModerationControlsProps {
  username: string;
  /** Everything on record, lapsed ones included. */
  restrictions: AdminRestriction[];
  busy: boolean;
  onRestrict: (kind: RestrictionKind, reason: string, durationSeconds: number) => void;
  onLift: (kind: RestrictionKind) => void;
}

export default function ModerationControls({
  username,
  restrictions,
  busy,
  onRestrict,
  onLift,
}: ModerationControlsProps) {
  // Which sanction the form is composing. Null means the form is closed, which
  // is how the panel stays a list of what is in force until a host asks for
  // more — a permanently open form invites a mute nobody meant to place.
  const [composing, setComposing] = useState<RestrictionKind | null>(null);
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState<number>(3600);

  const close = () => {
    setComposing(null);
    setReason('');
    setDuration(3600);
  };

  const inForce = restrictions.filter((restriction) => standing(restriction).active);
  const lapsed = restrictions.filter((restriction) => !standing(restriction).active);

  return (
    <View>
      {inForce.length === 0 ? (
        <Text style={adminStyles.detailNote}>Nothing in force.</Text>
      ) : (
        inForce.map((restriction) => (
          <View key={restriction.kind} style={adminStyles.subRow}>
            <Badge label={KIND_LABEL[restriction.kind].toUpperCase()} tone="live" />
            <View style={adminStyles.rowCopy}>
              <Text numberOfLines={2} style={adminStyles.subRowName}>
                {restriction.reason || 'No reason recorded'}
              </Text>
              <Text style={adminStyles.rowMeta}>
                {standing(restriction).label}
                {restriction.issuedBy ? ` · by ${restriction.issuedBy}` : ''}
              </Text>
            </View>
            {/*
              Lifting is not double-confirmed, unlike everything else on this
              screen. It is the *undo*: the worst outcome of a stray press is
              that somebody can talk again, which is the state they were in
              yesterday.
            */}
            <GhostButton
              compact
              disabled={busy}
              label="LIFT"
              onPress={() => onLift(restriction.kind)}
            />
          </View>
        ))
      )}

      {/*
        Lapsed sanctions are shown, quietly. "Muted for an hour last Tuesday,
        for spamming the lobby" is exactly the context a host wants before
        deciding what to do about tonight.
      */}
      {lapsed.length > 0 ? (
        <Text style={styles.history}>
          Previously:{' '}
          {lapsed
            .map(
              (restriction) =>
                `${KIND_LABEL[restriction.kind].toLowerCase()}${
                  restriction.reason ? ` (${restriction.reason})` : ''
                }`,
            )
            .join(', ')}
          .
        </Text>
      ) : null}

      {composing === null ? (
        <View style={adminStyles.chipRow}>
          {(Object.keys(KIND_LABEL) as RestrictionKind[]).map((kind) => (
            <Pressable
              accessibilityLabel={`${KIND_LABEL[kind]} ${username}`}
              accessibilityRole="button"
              disabled={busy}
              key={kind}
              onPress={() => setComposing(kind)}
              style={({ pressed }) => [
                styles.offer,
                busy && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.offerLabel}>{KIND_LABEL[kind]}</Text>
              <Text style={styles.offerDetail}>{KIND_DETAIL[kind]}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={styles.form}>
          <Text style={styles.formTitle}>
            {KIND_LABEL[composing]} {username}
          </Text>
          <Text style={styles.formDetail}>{KIND_DETAIL[composing]}</Text>
          <LabeledInput
            hint="Shown to them when they run into it, so write it for them to read."
            label="REASON"
            maxLength={200}
            onChangeText={setReason}
            placeholder="spamming the lobby"
            value={reason}
          />
          <OptionChips
            label="FOR HOW LONG"
            onChange={setDuration}
            options={DURATIONS}
            value={duration}
          />
          <View style={styles.formActions}>
            <GhostButton
              disabled={busy}
              label={`APPLY ${KIND_LABEL[composing].toUpperCase()}`}
              onPress={() => {
                onRestrict(composing, reason.trim(), duration);
                close();
              }}
            />
            <GhostButton compact disabled={busy} label="CANCEL" onPress={close} />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  history: { ...type.meta, color: colors.textFaint, paddingBottom: space.snug },

  offer: {
    flexBasis: 200,
    flexGrow: 1,
    gap: 2,
    paddingHorizontal: space.small,
    paddingVertical: space.snug,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceRaised,
  },
  offerLabel: { ...type.body, color: colors.text, fontWeight: '800' },
  offerDetail: { ...type.meta, color: colors.textFaint },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },

  form: {
    gap: space.snug,
    marginTop: space.snug,
    padding: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurfaceQuiet,
  },
  formTitle: { ...type.rowTitle, color: colors.text },
  formDetail: { ...type.meta, color: colors.textFaint },
  formActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    marginTop: space.tight,
  },
});
