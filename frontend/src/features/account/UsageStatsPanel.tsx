import { Text } from 'react-native';

import { ANALYTICS_AVAILABLE } from '@/analytics/config';
import { analyticsAllowed, setAnalyticsChoice, useAnalyticsConsent } from '@/analytics/consent';
import { useSettled } from '@/hooks/useSettled';
import { colors, space, themedSheet, type } from '@/theme';
import { OptionChips, Panel, SectionHeading } from '@/ui/primitives';

// The standing answer to the consent prompt, and the only place to change it.
//
// Shows what is happening now rather than what was chosen: a device in Europe
// that has not answered reads Off, because nothing is being sent. Per device,
// like match alerts above it, and absent from a build with no analytics.

const OPTIONS = [
  { value: true, label: 'On' },
  { value: false, label: 'Off' },
] as const;

export default function UsageStatsPanel() {
  const settled = useSettled();
  const allowed = useAnalyticsConsent(analyticsAllowed);
  if (!ANALYTICS_AVAILABLE || !settled) return null;
  return (
    <Panel>
      <SectionHeading
        eyebrow="PRIVACY"
        title="Usage stats"
        trailing={
          <OptionChips
            options={OPTIONS}
            value={allowed}
            onChange={(on) => setAnalyticsChoice(on ? 'granted' : 'denied')}
          />
        }
      />
      <Text style={styles.body}>
        Google Analytics counts visits and games from this device. No names or messages.
      </Text>
    </Panel>
  );
}

const styles = themedSheet(() => ({
  body: { ...type.body, color: colors.textMuted, marginTop: space.small },
}));
