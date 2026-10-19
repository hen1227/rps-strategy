import { Link, usePathname } from 'expo-router';
import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';

import { groupForPath, sectionForPath, sectionsInGroup } from './sections';
import { gridFor } from './subNavGrid';
import { useNavContext } from './useNavContext';
import { navRowProps } from '@/navigation/stack';
import { colors, radius, space, themedSheet, type } from '@/theme';

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
// level down.
//
// When it does wrap it wraps into equal cells. Compete is four pages, and on a
// phone a plain wrap left one chip alone under three, which read as a stray
// rather than as the fourth of four; at a large text size every group does it.
// So the chips are measured as they are, and a strip that does not fit on one
// line is drawn as the fewest even rows its longest label allows — two by two,
// or three by two — like the grids on the board screens.
//
// Nothing renders for a group with one page in it. Play is the whole lobby on
// a single address, and a strip with one chip on it is a label pretending to
// be a control.

export default function SubNav() {
  const pathname = usePathname();
  const nav = useNavContext();
  const { fontScale } = useWindowDimensions();
  const group = groupForPath(pathname);
  const current = sectionForPath(pathname);
  const sections = group ? sectionsInGroup(group, nav) : [];

  // The chips' own widths, measured on the plain row. Keyed by the strip they
  // were measured on: another group, or another text size, is measured afresh.
  const signature = `${fontScale}|${sections.map((section) => section.id).join(',')}`;
  const [measured, setMeasured] = useState<{ signature: string; widths: Record<string, number> }>(
    { signature: '', widths: {} },
  );
  const [innerWidth, setInnerWidth] = useState(0);
  const widths = measured.signature === signature ? measured.widths : {};
  const grid = gridFor(
    sections.map((section) => widths[section.id]),
    innerWidth,
    space.snug,
  );

  if (sections.length < 2) return null;

  const measureStrip = (event: LayoutChangeEvent) => {
    const inner = Math.floor(event.nativeEvent.layout.width) - 2 * space.medium;
    setInnerWidth((current) => (current === inner ? current : inner));
  };
  const measureChip = (id: string) => (event: LayoutChangeEvent) => {
    const width = Math.ceil(event.nativeEvent.layout.width);
    setMeasured((current) => {
      const known = current.signature === signature ? current.widths : {};
      return known[id] === width
        ? current
        : { signature, widths: { ...known, [id]: width } };
    });
  };

  return (
    // Keyed by the shape, so a switch to the grid mounts fresh chips: on iOS a
    // chip given a width after its first layout can keep its old one.
    <View key={grid ? `grid-${grid.columns}` : 'line'} onLayout={measureStrip} style={styles.strip}>
      {sections.map((section) => {
        const lit = section.id === current?.id;
        return (
          // A replace between sections; the analysis board is laid over the
          // shell instead. See `navRowMove`.
          <Link asChild href={section.href} key={section.id} {...navRowProps(section)}>
            <Pressable
              accessibilityLabel={section.label}
              accessibilityRole="link"
              accessibilityState={{ selected: lit }}
              onLayout={grid ? undefined : measureChip(section.id)}
              // One resolved style object: see the note in SidebarNav.
              style={StyleSheet.flatten([
                styles.chip,
                lit && styles.chipCurrent,
                grid && { width: grid.cell, justifyContent: 'center' },
              ])}
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

const styles = themedSheet(() => ({
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
  chipCurrent: { borderColor: colors.borderLight, backgroundColor: colors.surfaceRaised },
  label: { ...type.label, color: colors.textMuted, letterSpacing: 0.4 },
  labelCurrent: { color: colors.textStrong },
  away: { ...type.meta, color: colors.textFaint },
}));
