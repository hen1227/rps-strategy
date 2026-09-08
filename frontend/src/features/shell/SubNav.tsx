import { Link, usePathname } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { groupForPath, sectionForPath, sectionsInGroup } from './sections';
import { useNavContext } from './useNavContext';
import { colors, radius, space, type } from '@/theme';

// The pages inside the group the tab bar has open.
//
// The tab bar names five groups; this names what is in the one you are
// standing in. Together they are the whole site in two rows, which is the
// thing the four-tabs-plus-More arrangement could not do: there, the contents
// of More were invisible until you pressed it, so the answer to "what is on
// this site" was behind a button labelled with no answer at all.
//
// It wraps rather than scrolling sideways. A horizontally scrolling strip
// would be one line instead of sometimes two, but it hides whatever is past
// the right edge and gives no sign it is doing it — which is the objection the
// tab bar itself was written against, and it does not get better for being one
// level down. Bots is the group that wraps; the rest fit on one line.
//
// Nothing renders for a group with one page in it. Play is the whole lobby on
// a single address, and a strip with one chip on it is a label pretending to
// be a control.

export default function SubNav() {
  const pathname = usePathname();
  const nav = useNavContext();
  const group = groupForPath(pathname);
  const current = sectionForPath(pathname);
  const sections = group ? sectionsInGroup(group, nav) : [];

  if (sections.length < 2) return null;

  return (
    <View style={styles.strip}>
      {sections.map((section) => {
        const lit = section.id === current?.id;
        return (
          <Link asChild href={section.href} key={section.id} replace>
            <Pressable
              accessibilityLabel={section.label}
              accessibilityRole="link"
              accessibilityState={{ selected: lit }}
              // One resolved style object: see the note in SidebarNav.
              style={StyleSheet.flatten([styles.chip, lit && styles.chipCurrent])}
            >
              <Text numberOfLines={1} style={[styles.label, lit && styles.labelCurrent]}>
                {section.label}
              </Text>
              {/*
                The one mark that says this chip behaves differently: it leaves
                the shell, and the two rows of navigation go with it. Cheaper
                than a sentence, and it is the only thing on the strip that
                needs one — see `Section.external`.
              */}
              {section.external ? <Text style={styles.away}>↗</Text> : null}
            </Pressable>
          </Link>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.snug,
    paddingHorizontal: space.medium,
    paddingVertical: space.snug,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSunken,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.hair,
    minHeight: 28,
    paddingHorizontal: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipCurrent: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceQuiet },
  label: { ...type.label, color: colors.textMuted, letterSpacing: 0.4 },
  labelCurrent: { color: colors.textStrong },
  away: { ...type.meta, color: colors.textFaint },
});
