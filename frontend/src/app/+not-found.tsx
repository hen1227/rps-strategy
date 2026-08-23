import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { links } from '@/navigation/links';
import PageTitle from '@/navigation/PageTitle';
import { colors, radius } from '@/theme';

export default function NotFoundScreen() {
  return (
    <>
      <PageTitle title="Not found" />
      <Stack.Screen options={{ title: 'Not found' }} />
      <View style={styles.screen}>
        <Text style={styles.title}>There is no page here</Text>
        <Text style={styles.detail}>
          The address you followed does not match anything on the site.
        </Text>
        <Link href={links.lobby()} style={styles.link}>
          Go to the lobby
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
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
});
