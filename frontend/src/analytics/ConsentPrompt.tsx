import { Text, View } from 'react-native';

import { useSettled } from '@/hooks/useSettled';
import { colors, radius, space, themedSheet, type } from '@/theme';
import { GhostButton } from '@/ui/primitives';

import { consentPromptOwed, setAnalyticsChoice, useAnalyticsConsent } from './consent';

// The one-time question, for a device in Europe.
//
// The same floating card as the queue and tournament call-outs, in the same
// layer, so it never moves the page — and it waits behind both of them, since
// nothing is sent while it is unanswered. The two answers are the same size
// and the same weight: a yes that is easier to press than the no is not
// consent. Either one is final until changed under Your account.

/**
 * Whether the prompt is owed and may be drawn.
 *
 * Behind `useSettled`, because the answer depends on the device's time zone
 * and storage, which the pre-rendered page could not know.
 */
export const useConsentPromptOwed = (): boolean => {
  const settled = useSettled();
  const owed = useAnalyticsConsent(consentPromptOwed);
  return settled && owed;
};

export default function ConsentPrompt() {
  return (
    <View style={styles.card}>
      <View style={styles.copy}>
        <Text style={styles.title}>Share anonymous usage stats?</Text>
        <Text style={styles.detail}>
          Google Analytics counts visits and games. No names or messages. Change it any
          time under Your account.
        </Text>
      </View>
      <View style={styles.actions}>
        <GhostButton compact label="No thanks" onPress={() => setAnalyticsChoice('denied')} />
        <GhostButton compact label="Allow" onPress={() => setAnalyticsChoice('granted')} />
      </View>
    </View>
  );
}

const styles = themedSheet(() => ({
  card: {
    width: '100%',
    maxWidth: 620,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.medium,
    padding: space.medium,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.surfaceRaised,
    shadowColor: colors.surfaceDeep,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  // Wide enough to keep the copy beside the buttons on a desktop, and to put
  // the buttons on their own line on a phone.
  copy: { flexGrow: 1, flexBasis: 260, minWidth: 0 },
  title: { ...type.rowTitle, color: colors.textStrong, fontWeight: '900' },
  detail: { ...type.meta, color: colors.textMuted, marginTop: 2 },
  actions: { flexDirection: 'row', gap: space.small },
}));
