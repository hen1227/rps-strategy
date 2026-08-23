import { Link, useRouter } from 'expo-router';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { visibleSections } from './sections';
import { links, YOUTUBE_URL } from '@/navigation/links';
import { useGameStore } from '@/store/gameStore';
import { colors, contentWidth, radius, space, type } from '@/theme';
import ScreenShell from '@/ui/ScreenShell';
import { Panel, SectionHeading } from '@/ui/primitives';

// The sections that do not fit a phone's tab bar.
//
// A list rather than a scrolling strip of tabs, because a list says out loud
// that there is more, and a strip only says it to whoever thinks to swipe.

export default function MoreScreen() {
  const router = useRouter();
  const account = useGameStore((state) => state.account);
  // The four with their own tabs are already one tap away; repeating them here
  // would make this a list of everything and therefore a list of nothing.
  const overflow = visibleSections(account).filter((section) => !section.primary);

  return (
    <ScreenShell width={contentWidth.reading}>
      <Panel>
        <SectionHeading eyebrow="EVERYTHING ELSE" title="More" />
        <View style={styles.list}>
          {overflow.map((section) => (
            <Link asChild href={section.href} key={section.id}>
              <Pressable
                accessibilityLabel={section.label}
                accessibilityRole="link"
                // One resolved style object: see the note in SidebarNav.
                style={styles.row}
              >
                <View style={styles.copy}>
                  <Text style={styles.title}>{section.label}</Text>
                  <Text style={styles.detail}>{section.detail}</Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            </Link>
          ))}
        </View>
      </Panel>

      <Panel>
        <SectionHeading eyebrow="WHERE THIS CAME FROM" title="The video behind this" />
        <Text style={styles.blurb}>
          The whole game — the board, the three pieces, what beats what — comes out of one
          video. It is worth ten minutes.
        </Text>
        <Pressable
          accessibilityLabel="Watch the video this game is based on"
          accessibilityRole="link"
          onPress={() => Linking.openURL(YOUTUBE_URL)}
          style={({ pressed }) => [styles.video, pressed && styles.pressed]}
        >
          <Text style={styles.videoMark}>▶</Text>
          <Text style={styles.videoText}>Watch on YouTube</Text>
        </Pressable>
      </Panel>

      <Pressable
        accessibilityLabel="Read the privacy policy and online play agreement"
        accessibilityRole="button"
        onPress={() => router.push(links.policy())}
        style={({ pressed }) => [styles.policy, pressed && styles.pressed]}
      >
        <Text style={styles.policyText}>
          Playing online stores every game against your account. Be nice, do not cheat —{' '}
          <Text style={styles.policyLink}>Privacy & play agreement</Text>
        </Text>
      </Pressable>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: space.medium },
  row: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  copy: { flex: 1 },
  title: { ...type.bodyStrong, color: colors.textStrong, fontWeight: '900' },
  detail: { ...type.meta, color: colors.textFaint, marginTop: space.hair },
  chevron: { color: colors.textFaint, fontSize: 20, paddingHorizontal: space.tight },

  blurb: { ...type.body, color: colors.textMuted, marginTop: space.small },
  video: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.snug,
    minHeight: 42,
    marginTop: space.medium,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurfaceQuiet,
  },
  videoMark: { color: colors.dangerSoft, fontSize: 11 },
  videoText: { ...type.label, color: colors.textSubtle },

  policy: { paddingVertical: space.small, paddingHorizontal: space.tight },
  policyText: { ...type.meta, color: colors.textFaint, textAlign: 'center' },
  policyLink: { color: colors.textMuted, fontWeight: '900' },

  pressed: { opacity: 0.7 },
});
