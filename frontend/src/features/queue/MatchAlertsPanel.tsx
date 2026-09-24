import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { failureMessage } from '@/errors';
import { sendTestPush } from '@/store/api/push';
import { getOrCreateProfileKey, getOrCreateUserId } from '@/store/localIdentity';
import { useGameStore } from '@/store/gameStore';
import { usePushStore, type PushStatus } from '@/store/push';
import { colors, space, themedSheet, type } from '@/theme';
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

/**
 * Which noun this build is talking about.
 *
 * The states are the same on a phone; several of the sentences are not, because
 * a browser, a tab, and a padlock menu beside the address bar are all things an
 * app does not have. A panel that told somebody on an iPhone to check their
 * browser settings would be worse than saying nothing.
 */
const IS_NATIVE = Platform.OS !== 'web';
const DEVICE = IS_NATIVE ? 'device' : 'browser';

const COPY: Record<PushStatus | 'server-off', PanelCopy> = {
  unasked: {
    eyebrow: 'MATCH ALERTS',
    title: 'Wait for a game with the tab closed',
    body:
      'Enable notifications so you can stay queued for a game with the tab closed.',
    action: 'TURN ON ALERTS ▶',
  },
  error: {
    eyebrow: 'MATCH ALERTS',
    title: 'Alerts could not be turned on',
    body:
      "Could not enable alerts. Check the error below and try again.",
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
      'Your browser is refusing them for this site. Check your browser settings.',
    action: null,
  },
  'needs-home-screen': {
    eyebrow: 'MATCH ALERTS',
    title: 'Add RPS to your Home Screen first',
    body:
      "On iPhone or iPad, tap Share, then Add to Home Screen. Open RPS from that icon to enable alerts.",
    action: null,
  },
  unsupported: {
    eyebrow: 'MATCH ALERTS',
    title: 'This browser cannot receive alerts',
    body:
      "This browser cannot send alerts. Keep the tab open to stay in the queue.",
    action: null,
  },
  granted: {
    eyebrow: 'MATCH ALERTS',
    title: 'Match notifications are on',
    body:
      "Close the tab and keep your place in the queue. We only notify you when a game starts.",
    action: 'TURN OFF',
  },
  'server-off': {
    eyebrow: 'MATCH ALERTS',
    title: 'This server is not sending notifications',
    body:
      "Alerts are unavailable on this server. Keep the tab open to stay in the queue.",
    action: null,
  },
};

// Only the entries that mention a browser or a tab need saying twice.
// `needs-home-screen` is not one of them: an app is already installed.
const NATIVE_COPY: Partial<Record<PushStatus | 'server-off', PanelCopy>> = {
  unasked: {
    eyebrow: 'MATCH ALERTS',
    title: 'Wait for a game with the app closed',
    body:
      "Enable alerts to stay queued with the app closed. We only notify you when a game starts.",
    action: 'TURN ON ALERTS ▶',
  },
  error: {
    eyebrow: 'MATCH ALERTS',
    title: 'Alerts could not be turned on',
    body:
      "Could not enable alerts. Check the error below and try again.",
    action: 'TRY AGAIN ▶',
  },
  enabling: {
    eyebrow: 'MATCH ALERTS',
    title: 'Turning alerts on…',
    body: 'Registering this device with the Apple notification service.',
    action: null,
  },
  denied: {
    eyebrow: 'MATCH ALERTS',
    title: 'Notifications are switched off',
    body:
      "Enable alerts in Settings › Notifications › RPS Strategy. Until then, keep the app open to stay queued.",
    action: null,
  },
  unsupported: {
    eyebrow: 'MATCH ALERTS',
    title: 'This device cannot receive alerts',
    body:
      "Alerts are unavailable on this device. Keep the app open to stay in the queue.",
    action: null,
  },
  granted: {
    eyebrow: 'MATCH ALERTS',
    title: 'Match notifications are on',
    body:
      "Close the app and keep your place in the queue. We only notify you when a game starts.",
    action: 'TURN OFF',
  },
  'server-off': {
    eyebrow: 'MATCH ALERTS',
    title: 'This server is not sending notifications',
    body:
      "Alerts are unavailable on this server. Keep the app open to stay in the queue.",
    action: null,
  },
};

const copyFor = (status: PushStatus | 'server-off'): PanelCopy =>
  (IS_NATIVE ? NATIVE_COPY[status] : undefined) ?? COPY[status];

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
    const copy = copyFor(pushEnabled ? status : 'server-off');
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

  const copy = copyFor(status === 'error' ? 'unasked' : status);
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
 * Prove it works, from this device all the way back.
 *
 * A registration that stores cleanly and then silently delivers nothing looks
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
            ? `Sent to ${delivered} ${delivered === 1 ? DEVICE : `${DEVICE}s`}. If nothing appeared, ${
                IS_NATIVE
                  ? 'check Settings › Notifications › RPS Strategy.'
                  : "check this device's notification settings for your browser."
              }`
            : `This account has no registered ${DEVICE}s. Turn alerts off and on again here.`,
      });
    } catch (requestError) {
      setState({ busy: false, result: failureMessage(requestError) });
    }
  };

  return (
    <View style={styles.test}>
      <PrimaryButton
        accessibilityLabel={`Send a test notification to this ${DEVICE}`}
        label="SEND A TEST"
        loading={state.busy}
        onPress={() => void send()}
        tone="quiet"
      />
      {state.result ? <Text style={styles.testResult}>{state.result}</Text> : null}
    </View>
  );
}

const styles = themedSheet(() => ({
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
}));
