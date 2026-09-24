import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  Badge,
  Banner,
  EmptyState,
  GhostButton,
  LabeledInput,
  OptionChips,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';
import { failureMessage } from '@/errors';
import type { AdminToken } from '@/hooks/useAdminToken';
import {
  beginServerDrain,
  cancelServerDrain,
  clearServerNotice,
  postServerNotice,
  readServerDrain,
} from '@/store/api/serverAdmin';
import { useGameStore } from '@/store/gameStore';
import { useNow } from '@/hooks/useNow';
import { noticeRemaining, standingNotice } from '@/store/noticeSelectors';
import type { ServerUpdate } from '@/types/protocol';
import { colors, radius, space, themedSheet, type } from '@/theme';

// The two controls that act on the server rather than on anything in it.
//
// Both are here rather than only in `deploy-backend.sh` because the script
// covers the deploy that goes to plan, and this panel is for the rest of them:
// a drain that has to be called off, a restart that cannot wait for a
// twelve-minute series, an apology owed to whoever was mid-game when it
// happened. A host at a laptop with the site open should not have to go and find
// a terminal to say sorry.
//
// The panel shows what the drain is waiting on, and that list is the whole
// point of showing anything at all. "Restarting" with no explanation is the
// state somebody stares at for a minute and then reaches for `systemctl
// restart` anyway, taking the games with them — which is exactly what this
// feature exists to stop.
//
// The announcement half shows the standing notice for the same reason, and it
// took a real mistake to notice it was missing. A host posts a notice, reads
// it, and closes the banner exactly as any player would — and until now that
// was the last they saw of it, so a "back in a minute" could sit in front of
// every visitor for the full fifteen. The fix is that the panel reads
// `standingNotice`, which local dismissal deliberately does not touch. See its
// note in gameStore.

export default function ServerControlsPanel({ admin }: { admin: AdminToken }) {
  // The banner everyone else sees is driven by the socket, and the host is
  // connected to the same socket. So the live half of this panel needs no
  // polling: the broadcast that updates every player's banner updates this too.
  const broadcast = useGameStore((state) => state.serverUpdate);
  // The server's own copy, not this browser's banner: closing the banner must
  // not hide the fact that a notice is up. See the header note.
  const posted = useGameStore((state) => state.standingNotice);
  // A notice lapses on a clock rather than on a message, so the panel has to
  // re-read the time to stop showing one. A minute is fine: the countdown it
  // drives is rounded to minutes.
  const now = useNow();
  const [update, setUpdate] = useState<ServerUpdate | null>(null);
  const [note, setNote] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [tone, setTone] = useState<'notice' | 'warning'>('notice');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const drain = broadcast ?? update;

  // Read once on open, because a host arriving at this screen mid-drain has not
  // received the broadcast that started it — that went out before they got here,
  // and `connection_ready` only carries it if they reconnected since.
  const refresh = useCallback(async () => {
    if (!admin.unlocked) return;
    try {
      setUpdate(await readServerDrain(admin.token));
    } catch (caught) {
      setError(failureMessage(caught));
    }
  }, [admin.token, admin.unlocked]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await action();
      setDone(message);
      await refresh();
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const restarting = drain?.updating && (drain.settled || drain.gamesRemaining === 0);
  // Null before the clock settles on a pre-rendered page — see `useNow` — which
  // reads as "nothing standing" and resolves a render later. That is the right
  // way round: briefly not mentioning a notice beats briefly inventing one.
  const standing = now === null ? null : standingNotice(posted, now);

  return (
    <Panel style={styles.panel} tone={drain?.updating ? 'live' : 'default'}>
      <SectionHeading
        eyebrow="ADMINISTRATION"
        title="The server"
        trailing={
          drain?.updating ? (
            <Badge label={restarting ? 'RESTARTING' : 'DRAINING'} tone="live" />
          ) : null
        }
      />
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
      {done ? <Banner message={done} onDismiss={() => setDone(null)} /> : null}

      {drain?.updating ? (
        <View style={styles.block}>
          <Text style={styles.status}>
            {restarting
              ? 'Nothing left to play. The server is stopping now, and systemd will bring up whatever binary is on disk.'
              : 'No new games are being started. The server stops as soon as these finish:'}
          </Text>
          {drain.waitingOn.length > 0 ? (
            <View style={styles.list}>
              {drain.waitingOn.map((line) => (
                <Text key={line} style={styles.waiting}>
                  · {line}
                </Text>
              ))}
            </View>
          ) : null}
          <GhostButton
            disabled={busy || restarting}
            label="CALL IT OFF"
            onPress={() =>
              void run(() => cancelServerDrain(admin.token), 'Restart called off. Games are open again.')
            }
          />
          <Text style={styles.help}>
            Cancel to restore matchmaking and existing searches. You cannot cancel after the final game ends and the server stops.
          </Text>
        </View>
      ) : (
        <View style={styles.block}>
          <LabeledInput
            hint="Shown to everybody, and to anybody who arrives while it lasts."
            label="WHAT TO TELL PEOPLE"
            onChangeText={setNote}
            placeholder="Back in about a minute."
            value={note}
          />
          <PrimaryButton
            disabled={busy}
            label="RESTART WHEN THE GAMES FINISH"
            onPress={() =>
              void run(
                () => beginServerDrain(admin.token, note),
                'The server is draining. It restarts when the last game ends.',
              )
            }
          />
        </View>
      )}

      <View style={styles.block}>
        <SectionHeading
          eyebrow="EVERYBODY ONLINE"
          title="Say something"
          trailing={standing ? <Badge label="NOTICE UP" tone="live" /> : null}
        />

        {/*
          What is actually in front of people, before the form that would
          replace it. There is one notice board, so posting overwrites whatever
          is up — worth seeing rather than discovering.
        */}
        {standing ? (
          <View
            style={[
              styles.standing,
              standing.tone === 'warning' && styles.standingWarning,
            ]}
          >
            <Text style={styles.standingLabel}>
              UP NOW · {noticeRemaining(standing, now ?? Date.now()).toUpperCase()}
            </Text>
            <Text style={styles.standingText}>{standing.text}</Text>
            <GhostButton
              compact
              disabled={busy}
              label="TAKE IT DOWN"
              onPress={() =>
                void run(
                  () => clearServerNotice(admin.token),
                  'Announcement cleared. It has gone from every open page.',
                )
              }
            />
          </View>
        ) : (
          <Text style={styles.help}>
            No announcement. Post a message for everyone online and anyone who joins.
          </Text>
        )}

        <LabeledInput
          label="ANNOUNCEMENT"
          onChangeText={setAnnouncement}
          placeholder="Restarting to fix the clock bug."
          value={announcement}
        />
        <OptionChips
          onChange={setTone}
          options={[
            { label: 'NOTICE', value: 'notice' as const },
            { label: 'WARNING', value: 'warning' as const },
          ]}
          value={tone}
        />
        <View style={styles.buttons}>
          <PrimaryButton
            disabled={busy || !announcement.trim()}
            label={standing ? 'REPLACE IT' : 'POST IT'}
            onPress={() =>
              void run(
                () => postServerNotice(admin.token, { text: announcement, tone }),
                'Posted. Everybody online has it now.',
              ).then(() => setAnnouncement(''))
            }
          />
        </View>
      </View>
    </Panel>
  );
}

// Only reachable with the panel open on a locked screen, which the admin screen
// does not do — kept so the component is honest on its own.
export function LockedServerControls() {
  return <EmptyState detail="Unlock host controls to reach these." title="The server" />;
}

const styles = themedSheet(() => ({
  panel: { gap: space.medium },
  block: { gap: space.small },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.small },
  status: { ...type.body, color: colors.text },
  list: { gap: space.hair, paddingLeft: space.small },
  // minWidth: 0 so a long pair of names wraps rather than stretching the panel.
  waiting: { ...type.meta, minWidth: 0, color: colors.textSubtle },
  help: { ...type.body, color: colors.textFaint },
  // Framed like the banner everybody else is looking at, so a host recognises
  // it as the same object rather than as a summary of one.
  standing: {
    gap: space.snug,
    padding: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurfaceQuiet,
    alignItems: 'flex-start',
  },
  standingWarning: {
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurfaceQuiet,
  },
  standingLabel: { ...type.label, color: colors.textMuted },
  standingText: { ...type.bodyStrong, color: colors.text },
}));
