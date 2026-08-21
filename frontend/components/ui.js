import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, players, radius } from '../theme';

// Shared building blocks for the lobby and tournament surfaces. Keeping them
// here means a new panel matches the rest of the app without copying styles.

export function Panel({ children, style, tone = 'default' }) {
  return (
    <View
      style={[
        styles.panel,
        tone === 'accent' && styles.panelAccent,
        tone === 'live' && styles.panelLive,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionHeading({ eyebrow, title, trailing }) {
  return (
    <View style={styles.headingRow}>
      <View style={styles.headingCopy}>
        {Boolean(eyebrow) && <Text style={styles.eyebrow}>{eyebrow}</Text>}
        <Text style={styles.headingTitle}>{title}</Text>
      </View>
      {trailing}
    </View>
  );
}

export function Badge({ label, tone = 'neutral' }) {
  return (
    <View
      style={[
        styles.badge,
        tone === 'accent' && styles.badgeAccent,
        tone === 'live' && styles.badgeLive,
        tone === 'gold' && styles.badgeGold,
        tone === 'warm' && styles.badgeWarm,
        tone === 'cool' && styles.badgeCool,
      ]}
    >
      {tone === 'live' && <View style={styles.badgeDot} />}
      <Text
        style={[
          styles.badgeText,
          tone === 'accent' && styles.badgeTextAccent,
          tone === 'live' && styles.badgeTextLive,
          tone === 'gold' && styles.badgeTextGold,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  loading,
  compact,
  tone = 'accent',
  accessibilityLabel,
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        tone === 'quiet' && styles.primaryButtonQuiet,
        compact && styles.primaryButtonCompact,
        (disabled || loading) && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.textStrong} size="small" />
      ) : (
        <Text
          style={[styles.primaryButtonText, tone === 'quiet' && styles.primaryButtonTextQuiet]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function GhostButton({ label, onPress, disabled, compact, accessibilityLabel }) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.ghostButton,
        compact && styles.ghostButtonCompact,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.ghostButtonText}>{label}</Text>
    </Pressable>
  );
}

export function LabeledInput({ label, hint, ...inputProps }) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        {...inputProps}
        accessibilityLabel={label}
        placeholderTextColor={colors.textFaint}
        selectionColor={colors.accentBright}
        style={styles.input}
      />
      {Boolean(hint) && <Text style={styles.inputHint}>{hint}</Text>}
    </View>
  );
}

export function Checkbox({ checked, label, onToggle }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: Boolean(checked) }}
      onPress={onToggle}
      style={({ pressed }) => [styles.checkboxRow, pressed && styles.pressed]}
    >
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        <Text style={styles.checkboxMark}>{checked ? '✓' : ''}</Text>
      </View>
      <Text style={styles.checkboxLabel}>{label}</Text>
    </Pressable>
  );
}

export function Banner({ message, onDismiss, tone = 'notice' }) {
  if (!message) return null;
  return (
    <Pressable
      accessibilityLabel={onDismiss ? 'Dismiss message' : undefined}
      accessibilityRole={onDismiss ? 'button' : 'text'}
      disabled={!onDismiss}
      onPress={onDismiss}
      style={[styles.banner, tone === 'error' && styles.bannerError]}
    >
      <Text style={[styles.bannerText, tone === 'error' && styles.bannerTextError]}>
        {message}
      </Text>
      {Boolean(onDismiss) && <Text style={styles.bannerClose}>×</Text>}
    </Pressable>
  );
}

export function EmptyState({ title, detail }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {Boolean(detail) && <Text style={styles.emptyDetail}>{detail}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    padding: 15,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  panelAccent: { borderColor: colors.accentBorder, backgroundColor: colors.accentSurfaceQuiet },
  panelLive: { borderColor: colors.liveBorder, backgroundColor: colors.liveSurface },

  headingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  headingCopy: { flex: 1 },
  eyebrow: {
    color: colors.accentBright,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1.4,
    marginBottom: 3,
  },
  headingTitle: { color: colors.textStrong, fontSize: 18, fontWeight: '900' },

  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: radius.small,
    backgroundColor: colors.surfaceMuted,
  },
  badgeAccent: { backgroundColor: colors.accentSurfaceRaised },
  badgeLive: { backgroundColor: colors.liveSurface },
  badgeGold: { backgroundColor: colors.goldSurface },
  badgeWarm: { backgroundColor: colors.goldSurface },
  badgeCool: { backgroundColor: players.Blue.surface },
  badgeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.live },
  badgeText: { color: colors.textSubtle, fontSize: 8, fontWeight: '900', letterSpacing: 0.7 },
  badgeTextAccent: { color: colors.accentSoft },
  badgeTextLive: { color: colors.liveSoft },
  badgeTextGold: { color: colors.goldSoft },

  primaryButton: {
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: radius.medium,
    backgroundColor: colors.accent,
  },
  primaryButtonQuiet: { backgroundColor: colors.surfaceMuted },
  primaryButtonCompact: { minHeight: 36, paddingHorizontal: 12 },
  primaryButtonText: {
    color: colors.textStrong,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.9,
  },
  primaryButtonTextQuiet: { color: colors.textSoft },

  ghostButton: {
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceRaised,
  },
  ghostButtonCompact: { minHeight: 34, paddingHorizontal: 10 },
  ghostButtonText: {
    color: colors.textSubtle,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
  },

  inputGroup: { marginTop: 12 },
  inputLabel: {
    color: colors.textMuted,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
    marginBottom: 6,
  },
  input: {
    height: 42,
    paddingHorizontal: 12,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSunken,
    color: colors.textStrong,
    fontSize: 14,
  },
  inputHint: { color: colors.textFaint, fontSize: 10, marginTop: 5 },

  checkboxRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 13 },
  checkbox: {
    width: 21,
    height: 21,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.surfaceSunken,
  },
  checkboxChecked: { borderColor: colors.accent, backgroundColor: colors.accent },
  checkboxMark: { color: colors.textStrong, fontSize: 13, fontWeight: '900' },
  checkboxLabel: { flex: 1, color: colors.textSubtle, fontSize: 11, lineHeight: 17 },

  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: radius.medium,
    backgroundColor: colors.noticeSurface,
  },
  bannerError: { backgroundColor: colors.dangerSurface },
  bannerText: { flex: 1, color: colors.noticeText, fontSize: 12 },
  bannerTextError: { color: colors.dangerText },
  bannerClose: { color: colors.textSoft, fontSize: 18, paddingHorizontal: 5 },

  emptyState: { paddingVertical: 18, alignItems: 'flex-start', gap: 4 },
  emptyTitle: { color: colors.text, fontSize: 13, fontWeight: '900' },
  emptyDetail: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },

  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
});
