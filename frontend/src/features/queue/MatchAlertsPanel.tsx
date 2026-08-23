import { StyleSheet, Text, View } from 'react-native';

import { useGameStore } from '@/store/gameStore';
import { usePushStore } from '@/store/push';
import { colors, space, type } from '@/theme';
import { Panel, PrimaryButton, SectionHeading } from '@/ui/primitives';

// The standing home for match alerts, as opposed to the offer the queue bar
// makes in the moment.
//
// It renders only when there is something actionable to say. A settings row
// reading "notifications: on" is exactly the clutter this feature promised not
// to add, so once alerts are working the panel disappears from the lobby
// entirely and lives only on the account screen, where somebody who wants to
// turn it off will go looking.

type PanelCopy = { eyebrow: string; title: string; body: string; action: string | null };

const COPY: Record<string, PanelCopy> = {
  unasked: {
    eyebrow: 'MATCH ALERTS',
    title: 'Wait for a game with the tab closed',
    body:
      'Right now, closing this tab takes you out of the queue. Let the site send you one notification — only ever "your game is ready", never anything else — and your place is held until somebody turns up.',
    action: 'TURN ON ALERTS ▶',
  },
  denied: {
    eyebrow: 'MATCH ALERTS',
    title: 'Notifications are blocked',
    body:
      'Your browser is refusing them for this site, so there is no button here that could help. If you change your mind it is in the padlock menu beside the address bar. Until then, staying in the queue means leaving this tab open.',
    action: null,
  },
  'needs-home-screen': {
    eyebrow: 'MATCH ALERTS',
    title: 'Add RPS to your Home Screen first',
    body:
      'iPhones and iPads only allow notifications from a site you have installed. Tap Share, then Add to Home Screen, and open RPS from the icon — the button appears there.',
    action: null,
  },
  granted: {
    eyebrow: 'ALERTS',
    title: 'Match notifications are on',
    body:
      'You will get one notification when a game is found, and nothing else — no reminders, no "somebody is waiting", no news.',
    action: 'TURN OFF',
  },
};

export default function MatchAlertsPanel({
  variant = 'offer',
}: {
  /** `offer` invites; `settings` is the standing switch on the account screen. */
  variant?: 'offer' | 'settings';
}) {
  const pushEnabled = useGameStore((state) => state.pushEnabled);
  const sessionToken = useGameStore((state) => state.sessionToken);
  const isSearching = useGameStore((state) => state.queue.isSearching);
  const status = usePushStore((state) => state.status);
  const snoozedUntil = usePushStore((state) => state.snoozedUntil);
  const error = usePushStore((state) => state.error);
  const enable = usePushStore((state) => state.enable);
  const disable = usePushStore((state) => state.disable);

  // A server with no keys cannot call anybody back, so there is nothing here
  // worth saying at all.
  if (!pushEnabled) return null;

  if (variant === 'settings') {
    if (status !== 'granted') return null;
    return (
      <AlertsCard
        copy={COPY.granted}
        onPress={() => void disable(sessionToken ?? null)}
        error={error}
      />
    );
  }

  if (status === 'granted' || status === 'unsupported' || status === 'enabling') return null;
  // While a search is running the floating bar is already making this offer, at
  // the better moment and in fewer words. Asking twice on one screen is how one
  // polite offer becomes nagging, so the bar wins and this stands down.
  if (isSearching) return null;
  // Dismissing it in either place buys a week of quiet in both.
  if (status === 'unasked' && Date.now() < snoozedUntil) return null;

  const copy = COPY[status === 'error' ? 'unasked' : status];
  if (!copy) return null;
  return (
    <AlertsCard
      copy={copy}
      onPress={copy.action ? () => void enable(sessionToken ?? null) : undefined}
      error={error}
    />
  );
}

function AlertsCard({
  copy,
  error,
  onPress,
}: {
  copy: PanelCopy;
  error: string | null;
  onPress?: () => void;
}) {
  return (
    <Panel>
      <SectionHeading eyebrow={copy.eyebrow} title={copy.title} />
      <Text style={styles.body}>{copy.body}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {copy.action && onPress ? (
        <View style={styles.action}>
          <PrimaryButton
            accessibilityLabel={copy.action.replace(' ▶', '')}
            label={copy.action}
            onPress={onPress}
            tone={copy.action === 'TURN OFF' ? 'quiet' : 'accent'}
          />
        </View>
      ) : null}
    </Panel>
  );
}

const styles = StyleSheet.create({
  body: { ...type.body, color: colors.textMuted, marginTop: space.small },
  error: { ...type.meta, color: colors.danger, marginTop: space.snug },
  action: { alignSelf: 'flex-start', marginTop: space.medium },
});
