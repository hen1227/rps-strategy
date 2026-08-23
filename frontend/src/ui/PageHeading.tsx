import { Link } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Href } from 'expo-router';

import { colors, space, type } from '@/theme';

// The top of a page that is not a section of its own.
//
// `ScreenShell` deliberately has no header, and the reason it gives is sound:
// inside the app shell the sidebar and the tab bar are the way out, so a
// per-section back button is a second answer to a question already answered.
// A page *underneath* a section is the case that argument does not cover —
// nothing in the sidebar leads back from the protocol reference to your bots —
// so these pages carry one line of trail and their own title.

export interface PageHeadingProps {
  eyebrow?: string;
  title: string;
  detail?: string;
  /** The page one level up. A trail, not a navigation bar. */
  back?: { label: string; href: Href };
  /** A badge or a button, at the end of the title row. */
  trailing?: ReactNode;
}

export default function PageHeading({
  eyebrow,
  title,
  detail,
  back,
  trailing,
}: PageHeadingProps) {
  return (
    <View style={styles.header}>
      {back ? (
        <Link asChild href={back.href}>
          <Pressable
            accessibilityLabel={`Back to ${back.label}`}
            accessibilityRole="link"
            // One resolved style object: see the note in SidebarNav.
            style={styles.back}
          >
            <Text style={styles.backText}>‹ {back.label}</Text>
          </Pressable>
        </Link>
      ) : null}
      <View style={styles.titleRow}>
        <View style={styles.copy}>
          {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
          <Text style={styles.title}>{title}</Text>
        </View>
        {trailing}
      </View>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.tight },
  back: { alignSelf: 'flex-start', paddingVertical: space.tight },
  backText: { ...type.label, color: colors.textFaint },
  titleRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.small },
  copy: { flex: 1, minWidth: 0 },
  eyebrow: { ...type.eyebrow, color: colors.accent, marginBottom: space.hair },
  title: { ...type.screenTitle, color: colors.textStrong, letterSpacing: -0.4 },
  detail: { ...type.body, color: colors.textMuted, maxWidth: 620 },
});
