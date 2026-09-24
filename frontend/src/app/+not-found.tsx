import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { links } from '@/navigation/links';
import PageTitle from '@/navigation/PageTitle';
import { colors, radius, themedSheet } from '@/theme';
import { useAppearanceGeneration } from '@/appearance/store';

export default function NotFoundScreen() {
  // Re-render this page when the look changes.
  //
  // A route file is the seam because every one of them is behind its own
  // `StaticContainer` — expo-router renders each route through a `React.memo`
  // whose comparator skips `children`, so a re-render above never reaches in.
  // Subscribing here does, and because the page's element is created inline
  // below rather than handed in as a prop, the whole subtree follows.
  useAppearanceGeneration();
  return (
    <>
      <PageTitle title="Not found" />
      <Stack.Screen options={{ title: 'Not found' }} />
      <View style={styles.screen}>
        <Text style={styles.title}>There is no page here</Text>
        <Text style={styles.detail}>
          This page does not exist.
        </Text>
        {/*
          `dismissTo`, because this page is not a place: a mistyped or dead
          address is one the app should not keep underneath the lobby it sends
          people to. See `navigation/stack`.
        */}
        <Link dismissTo href={links.lobby()} style={styles.link}>
          Go to the lobby
        </Link>
      </View>
    </>
  );
}

const styles = themedSheet(() => ({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 24,
    backgroundColor: colors.background,
  },
  title: { color: colors.textStrong, fontSize: 20, fontWeight: '900' },
  detail: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
  link: {
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: radius.medium,
    backgroundColor: colors.accent,
    color: colors.textStrong,
    fontSize: 11,
    fontWeight: '900',
  },
}));
