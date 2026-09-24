import { Pressable, StyleSheet, Text, View } from 'react-native';

import { adminStyles } from './adminStyles';
import type { AccountQuery, AccountSort } from '@/store/api/bots';
import { colors, radius, space, themedSheet, type } from '@/theme';
import { GhostButton, LabeledInput, OptionChips } from '@/ui/primitives';

// Narrowing the account browser.
//
// The panel needs this because of one fact about identity here: every browser
// that has ever loaded the site owns an account called Guest, created the moment
// it arrived. They outnumber everybody else by orders of magnitude, they are
// indistinguishable, and the list was ordered newest-first — so opening the
// browser reliably showed fifty Guests and nothing a host was looking for.
//
// Two decisions:
//
//   - **It opens with the Guests hidden.** That is the default because it is the
//     answer almost every time; "everybody" is one press away, because a host
//     hunting a particular anonymous browser genuinely needs it.
//   - **The filters are toggles rather than a form.** Nothing here is submitted:
//     pressing one narrows the list. A form with an Apply button would make the
//     common case — hide guests, look, widen again — three presses instead of
//     one.
//
// The activity windows are the other half of the request behind this file, and
// they are hours rather than a date picker for the same reason: a host asking
// "who was here in the last hour" is not going to type a timestamp.

/** The activity windows on offer, in hours. */
const WINDOWS: { label: string; value: number }[] = [
  { label: 'Any time', value: 0 },
  { label: '1 hour', value: 1 },
  { label: '8 hours', value: 8 },
  { label: '24 hours', value: 24 },
  { label: '7 days', value: 168 },
  { label: '30 days', value: 720 },
];

const SORTS: { label: string; value: AccountSort }[] = [
  { label: 'Newest', value: 'newest' },
  { label: 'Last played', value: 'active' },
  { label: 'Rating', value: 'rating' },
  { label: 'Games', value: 'games' },
  { label: 'Name', value: 'name' },
];

/**
 * One on/off narrowing.
 *
 * Its own control rather than `Checkbox` because the underlying filter is
 * tri-state — on, off, and not applied — while a press only ever needs two of
 * those. Pressing an active toggle clears it back to "not applied" rather than
 * inverting to "only the excluded ones", which is almost never what somebody
 * means. Where the inverse *is* useful it gets a control of its own, which is
 * why "Hide guests" and "Only guests" are two buttons rather than one.
 */
function Toggle({
  label,
  active,
  onPress,
  disabled,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: active, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toggle,
        active && styles.toggleActive,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.toggleLabel, active && styles.toggleLabelActive]}>{label}</Text>
    </Pressable>
  );
}

export interface AccountFiltersProps {
  filter: AccountQuery;
  /** How many accounts matched, and how many there are without the filter. */
  matched: number;
  busy: boolean;
  onChange: (filter: AccountQuery) => void;
}

export default function AccountFilters({
  filter,
  matched,
  busy,
  onChange,
}: AccountFiltersProps) {
  // A press on an active toggle clears it. See the note on `Toggle`.
  const toggle = (key: 'registered' | 'discordVerified' | 'disabled' | 'isAdmin') =>
    onChange({ ...filter, [key]: filter[key] ? undefined : true });

  const guestsHidden = filter.registered === true;
  const onlyGuests = filter.registered === false;

  return (
    <View style={styles.block}>
      <View style={adminStyles.searchRow}>
        <View style={adminStyles.searchField}>
          <LabeledInput
            autoCapitalize="none"
            label="SEARCH"
            onChangeText={(query) => onChange({ ...filter, query })}
            placeholder="username or user id"
            value={filter.query ?? ''}
          />
        </View>
        <GhostButton
          compact
          disabled={busy}
          label="CLEAR"
          // Back to the screen's own default rather than to nothing, because
          // "no filter at all" is the state that shows fifty Guests and is not
          // what anybody pressing Clear is asking for.
          onPress={() => onChange({ registered: true, sort: 'active' })}
        />
      </View>

      <View style={styles.row}>
        {/*
          The two ends of the same question, side by side. Only Guests is worth
          a control of its own because it is the one way to find an anonymous
          browser at all — searching for "Guest" matches every one of them.
        */}
        <Toggle
          active={guestsHidden}
          disabled={busy}
          label="Hide guests"
          onPress={() =>
            onChange({ ...filter, registered: guestsHidden ? undefined : true })
          }
        />
        <Toggle
          active={onlyGuests}
          disabled={busy}
          label="Only guests"
          onPress={() =>
            onChange({ ...filter, registered: onlyGuests ? undefined : false })
          }
        />
        <Toggle
          active={filter.discordVerified === true}
          disabled={busy}
          label="Discord linked"
          onPress={() => toggle('discordVerified')}
        />
        <Toggle
          active={filter.kind === 'bot'}
          disabled={busy}
          label="Engines"
          onPress={() =>
            onChange({ ...filter, kind: filter.kind === 'bot' ? undefined : 'bot' })
          }
        />
        <Toggle
          active={filter.kind === 'human'}
          disabled={busy}
          label="People"
          onPress={() =>
            onChange({ ...filter, kind: filter.kind === 'human' ? undefined : 'human' })
          }
        />
        <Toggle
          active={filter.disabled === true}
          disabled={busy}
          label="Disabled"
          onPress={() => toggle('disabled')}
        />
        <Toggle
          active={filter.isAdmin === true}
          disabled={busy}
          label="Admins"
          onPress={() => toggle('isAdmin')}
        />
        <Toggle
          active={Boolean(filter.minGames)}
          disabled={busy}
          label="Has played"
          onPress={() =>
            onChange({ ...filter, minGames: filter.minGames ? undefined : 1 })
          }
        />
      </View>

      <OptionChips
        disabled={busy}
        label="PLAYED WITHIN"
        onChange={(hours) =>
          onChange({ ...filter, activeWithinHours: hours || undefined })
        }
        options={WINDOWS}
        value={filter.activeWithinHours ?? 0}
      />

      <OptionChips
        disabled={busy}
        label="SORT BY"
        onChange={(sort) => onChange({ ...filter, sort })}
        options={SORTS}
        value={filter.sort ?? 'newest'}
      />

      <Text style={styles.count}>
        {matched === 1 ? '1 account matches' : `${matched} accounts match`}
        {matched > (filter.limit ?? 50)
          ? ` · showing the first ${filter.limit ?? 50}`
          : ''}
      </Text>
    </View>
  );
}

const styles = themedSheet(() => ({
  block: { gap: space.small },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.snug },
  toggle: {
    paddingHorizontal: space.small,
    paddingVertical: space.snug,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceMuted,
  },
  toggleActive: {
    borderColor: colors.goldBorder,
    backgroundColor: colors.goldSurfaceDeep,
  },
  toggleLabel: { ...type.label, color: colors.textMuted },
  toggleLabelActive: { color: colors.goldBright },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  count: { ...type.meta, color: colors.textFaint },
}));
