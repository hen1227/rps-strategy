import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { failureMessage } from '@/errors';
import { sendTestPush } from '@/store/api/push';
import { getOrCreateProfileKey, getOrCreateUserId } from '@/store/localIdentity';
import { useGameStore } from '@/store/gameStore';
import { usePushStore, type PushStatus } from '@/store/push';
import { colors, space, type } from '@/theme';
import { Panel, PrimaryButton, SectionHeading } from '@/ui/primitives';

// Match alerts, in the two places they are talked about.
//
// `offer` is the invitation, and it renders only when there is something
// actionable to say: a card reading "notifications: on" is exactly the clutter
// this feature promised not to add, so once alerts are working the offer
// disappears from the lobby entirely.
//
// `settings` is the opposite, and it is always here. The account screen is
// where somebody goes when they want to change this, or when it is not working
// and they want to know why — and a settings page that shows nothing at all
// unless the setting is already on is a settings page that cannot answer either
// question. So every state has an entry, including the two the player cannot do
// anything about, because "your browser is refusing these" is a far better
// answer than an empty panel.

type PanelCopy = { eyebrow: string; title: string; body: string; action: string | null };

const COPY: Record<PushStatus | 'server-off', PanelCopy> = {
  unasked: {
    eyebrow: 'MATCH ALERTS',
    title: 'Wait for a game with the tab closed',
    body:
      'Right now, closing this tab takes you out of the queue. Let the site send you one notification — only ever "your game has started", never anything else — and your place is held until somebody turns up.',
    action: 'TURN ON ALERTS ▶',
  },
  error: {
    eyebrow: 'MATCH ALERTS',
    title: 'Alerts could not be turned on',
    body:
      'Something went wrong the last time this browser tried. The reason is below; trying again is safe.',
    action: 'TRY AGAIN ▶',
  },
  enabling: {
    eyebrow: 'MATCH ALERTS',
    title: 'Turning alerts on…',
    body: 'Registering this browser with the notification service.',
    action: null,
  },
  denied: {
    eyebrow: 'MATCH ALERTS',
    title: 'Notifications are blocked',
    body:
      'Your browser is refusing them for this site, so there is no button here that could help. If you change your mind it is in the padlock menu beside the address bar — allow notifications, then reload this page. Until then, staying in the queue means leaving a tab open.',
    action: null,
  },
  'needs-home-screen': {
    eyebrow: 'MATCH ALERTS',
    title: 'Add RPS to your Home Screen first',
    body:
      'iPhones and iPads only allow notifications from a site you have installed. Tap Share, then Add to Home Screen, and open RPS from the icon — the button appears there.',
    action: null,
  },
  unsupported: {
    eyebrow: 'MATCH ALERTS',
    title: 'This browser cannot receive alerts',
    body:
      'It has no service worker or no push support, which is usually a private window or an older browser. Everything else works; the queue just cannot outlive this tab.',
    action: null,
  },
  granted: {
    eyebrow: 'MATCH ALERTS',
    title: 'Match notifications are on',
    body:
      'You get one notification when a game starts, and nothing else — no reminders, no "somebody is waiting", no news. Your place in the queue is held while the tab is closed.',
    action: 'TURN OFF',
  },
  'server-off': {
    eyebrow: 'MATCH ALERTS',
    title: 'This server is not sending notifications',
    body:
      'No notification keys are configured, so nobody can be called back and the offer is switched off everywhere. Matchmaking works exactly as it did before alerts existed: your place in the queue lasts as long as the tab.',
    action: null,
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

  if (variant === 'settings') {
    const copy = pushEnabled ? COPY[status] : COPY['server-off'];
    return (
      <AlertsCard
        copy={copy}
        error={error}
        onPress={
          status === 'granted'
            ? () => void disable(sessionToken ?? null)
            : copy.action
              ? () => void enable(sessionToken ?? null)
              : undefined
        }
        showTest={pushEnabled && status === 'granted'}
      />
    );
  }

  // A server with no keys cannot call anybody back, so there is nothing here
  // worth saying at all — the account screen says it once, and that is enough.
  if (!pushEnabled) return null;
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
      error={error}
      onPress={copy.action ? () => void enable(sessionToken ?? null) : undefined}
    />
  );
}

function AlertsCard({
  copy,
  error,
  onPress,
  showTest,
}: {
  copy: PanelCopy;
  error: string | null;
  onPress?: () => void;
  /** Offer the one button that proves the whole chain works end to end. */
  showTest?: boolean;
}) {
  return (
    <Panel>
      <SectionHeading eyebrow={copy.eyebrow} title={copy.title} />
      <Text style={styles.body}>{copy.body}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        {copy.action && onPress ? (
          <PrimaryButton
            accessibilityLabel={copy.action.replace(' ▶', '')}
            label={copy.action}
            onPress={onPress}
            tone={copy.action === 'TURN OFF' ? 'quiet' : 'accent'}
          />
        ) : null}
        {showTest ? <TestAlertButton /> : null}
      </View>
    </Panel>
  );
}

/**
 * Prove it works, from this browser all the way back.
 *
 * A subscription that stores cleanly and then silently delivers nothing looks
 * exactly like one that works — until somebody misses a game. Pressing this is
 * the only way to tell the difference, so it is here rather than in a
 * troubleshooting guide nobody reads.
 */
function TestAlertButton() {
  const sessionToken = useGameStore((state) => state.sessionToken);
  const [state, setState] = useState<{ busy: boolean; result: string | null }>({
    busy: false,
    result: null,
  });

  const send = async () => {
    setState({ busy: true, result: null });
    try {
      const { delivered } = await sendTestPush({
        userId: getOrCreateUserId(),
        profileKey: getOrCreateProfileKey(),
        sessionToken: sessionToken ?? null,
      });
      setState({
        busy: false,
        result:
          delivered > 0
            ? `Sent to ${delivered} ${delivered === 1 ? 'browser' : 'browsers'}. If nothing appeared, check this device's notification settings for your browser.`
            : 'This account has no registered browsers. Turn alerts off and on again here.',
      });
    } catch (requestError) {
      setState({ busy: false, result: failureMessage(requestError) });
    }
  };

  return (
    <View style={styles.test}>
      <PrimaryButton
        accessibilityLabel="Send a test notification to this browser"
        label="SEND A TEST"
        loading={state.busy}
        onPress={() => void send()}
        tone="quiet"
      />
      {state.result ? <Text style={styles.testResult}>{state.result}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { ...type.body, color: colors.textMuted, marginTop: space.small },
  error: { ...type.meta, color: colors.danger, marginTop: space.snug },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: space.small,
    marginTop: space.medium,
  },
  test: { gap: space.snug },
  testResult: { ...type.meta, color: colors.textMuted, maxWidth: 360 },
});
