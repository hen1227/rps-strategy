import { Linking, Modal, Platform, Text, View } from 'react-native';

import { useGameStore } from '@/store/gameStore';
import { SITE_URL } from '@/store/serverConfig';
import { colors, radius, space, themedSheet, type } from '@/theme';
import { PrimaryButton } from '@/ui/primitives';

// The server has said this build is too old to play online.
//
// Over everything, with no way past it: what an older build would do next is
// exactly what the server has just declined to answer, and a lobby that looks
// fine and then fails is the thing this exists to prevent. Hung beside the
// stack in the root layout, like the other app-wide cards.
//
// The store's own listing when the server names it, and the website when it
// does not, since the site links to both stores. A browser is told to reload,
// which is all a page ever needs to be current.

export default function UpdateRequired() {
  const update = useGameStore((state) => state.updateRequired);
  if (!update) return null;

  const onWeb = Platform.OS === 'web';
  const act = () => {
    if (onWeb) {
      window.location.reload();
      return;
    }
    void Linking.openURL(update.storeUrl || SITE_URL);
  };

  return (
    // Nothing to close, so a back press is answered with nothing.
    <Modal animationType="fade" onRequestClose={() => {}} visible>
      <View style={styles.root}>
        <View accessibilityViewIsModal style={styles.card}>
          <Text style={styles.eyebrow}>UPDATE REQUIRED</Text>
          <Text style={styles.title}>{onWeb ? 'Reload RPS Strategy' : 'Update RPS Strategy'}</Text>
          <Text style={styles.line}>{update.message}</Text>
          <View style={styles.footer}>
            <PrimaryButton
              accessibilityLabel={onWeb ? 'Reload the page' : 'Open the store to update'}
              label={onWeb ? 'RELOAD' : 'UPDATE'}
              onPress={act}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = themedSheet(() => ({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.large,
    backgroundColor: colors.background,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    padding: space.large,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  eyebrow: { ...type.eyebrow, color: colors.textFaint },
  title: { ...type.screenTitle, color: colors.textStrong, marginTop: space.tight },
  line: { ...type.bodyStrong, color: colors.textSoft, marginTop: space.medium },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: space.medium },
}));
