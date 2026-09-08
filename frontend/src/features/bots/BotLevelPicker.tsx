import { Pressable, StyleSheet, Text, View } from 'react-native';

import BotIcon from './BotIcon';
import { BOT_PROFILES } from '@/engine/bots/profiles';
import { colors, radius, space, type } from '@/theme';

// The difficulty ladder, as tiles.
//
// Lived inside the lobby screen and was rendered three times from there — once
// for the practice board and once for each side of a bot battle. It is the same
// control every time, so it is one component now.

export interface BotLevelPickerProps {
  label?: string;
  selectedProfileId: string;
  onSelect: (profileId: string) => void;
  /**
   * Smaller art and tighter tiles, for a page that has other controls under it.
   * The ladder is still six named faces; it just stops being the whole screen.
   */
  compact?: boolean;
}

export default function BotLevelPicker({
  label,
  selectedProfileId,
  onSelect,
  compact,
}: BotLevelPickerProps) {
  return (
    <View>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      {/*
        Six tiles wrap into as many rows as the column allows, so the whole
        ladder is visible at a glance on a phone and in one row on a desktop.
      */}
      <View style={[styles.levels, compact && styles.levelsCompact]}>
        {BOT_PROFILES.map((profile) => {
          const selected = profile.id === selectedProfileId;
          return (
            <Pressable
              accessibilityLabel={`${label ? `${label}, ` : ''}${profile.name}, level ${profile.rating}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              key={profile.id}
              onPress={() => onSelect(profile.id)}
              style={({ pressed }) => [
                styles.level,
                compact && styles.levelCompact,
                selected && styles.levelSelected,
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.art, compact && styles.artCompact]}>
                <BotIcon profileId={profile.id} size={compact ? 40 : undefined} />
              </View>
              <Text style={[styles.name, selected && styles.nameSelected]}>{profile.name}</Text>
              <Text style={[styles.rating, selected && styles.ratingSelected]}>
                {profile.rating}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { ...type.eyebrow, color: colors.textFaint, letterSpacing: 1.2, marginTop: space.large },
  levels: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.snug,
    marginTop: space.medium,
  },
  levelsCompact: { gap: space.tight, marginTop: space.small },
  level: {
    minWidth: 78,
    flexGrow: 1,
    alignItems: 'center',
    paddingHorizontal: space.small,
    paddingTop: space.small,
    paddingBottom: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSunken,
  },
  // Wide enough that six tiles wrap into two clean rows of three on a phone
  // and sit in one row on a desktop, rather than four and a ragged two.
  levelCompact: { minWidth: 84, paddingTop: space.tight, paddingBottom: space.tight },
  levelSelected: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceStrong },
  art: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.tight,
  },
  artCompact: { width: 40, height: 40, marginBottom: 0 },
  name: { ...type.body, color: colors.textSubtle, fontWeight: '900' },
  nameSelected: { color: colors.accentTextStrong },
  rating: { fontSize: 9, fontWeight: '800', color: colors.textFaint, marginTop: space.hair },
  ratingSelected: { color: colors.accentSoft },
  pressed: { opacity: 0.7 },
});
