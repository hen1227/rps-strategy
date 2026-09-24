import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import ConfirmButton from './ConfirmButton';
import { adminStyles } from './adminStyles';
import { failureMessage } from '@/errors';
import BotIcon from '@/features/bots/BotIcon';
import type { AdminToken } from '@/hooks/useAdminToken';
import { links } from '@/navigation/links';
import { disconnectBot, listAdminBots, type AdminBot } from '@/store/api/admin';
import { botIconUrl, shutdownBot } from '@/store/api/bots';
import { colors, space, themedSheet, type } from '@/theme';
import {
  Badge,
  Banner,
  EmptyState,
  GhostButton,
  GhostLink,
  LabeledInput,
  Panel,
  SectionHeading,
} from '@/ui/primitives';

// The engines, as the host sees them.
//
// The public bots page shows what an engine is for; this shows what it is
// doing, which is a different list: sockets held, games in flight, client
// version, and whether it is available to anybody at all.
//
// There are four ways to take an engine out of play and they are not
// interchangeable. In increasing severity:
//
//   1. **Drain** — it finishes what it is playing and then leaves. Almost
//      always the right answer, and the button an owner has too.
//   2. **Bench** — every engine stands down for a scheduled window. Scheduled
//      in the panel below this one rather than pressed here, because it is a
//      window rather than a switch: one declared ahead of time ends by itself,
//      and a switch has to be thrown a second time by somebody who remembers.
//      See `BotBenchPanel` and bot_bench.go.
//   3. **Reserve** — held for a tournament it has entered. Not an action at
//      all; it happens by itself when an event starts and lifts when the event
//      finishes. Shown here so that "why is Fishy refusing challenges" has a
//      visible answer.
//   4. **Disconnect** — the sockets close, now, mid-game. For an engine that has
//      stopped responding or is doing something that has to stop this second.
//
// The owner's process is not killed by (4) and will very likely reconnect,
// which is a feature: the usual next step is for them to fix something and
// restart it. That is why this is not a ban — a ban is a restriction on the
// bot's account, which lives on the Players tab like anybody else's.

export interface BotControlPanelProps {
  admin: AdminToken;
}

export default function BotControlPanel({ admin }: BotControlPanelProps) {
  const [bots, setBots] = useState<AdminBot[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const refresh = useCallback(async () => {
    if (!admin.token) return;
    setLoading(true);
    try {
      setBots((await listAdminBots(admin.token)) ?? []);
      setError(null);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [admin.token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (action: () => Promise<unknown>, successNotice: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successNotice);
      await refresh();
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  return (
    <Panel style={adminStyles.panel}>
      <SectionHeading
        eyebrow="ADMINISTRATION"
        title={bots.length === 1 ? '1 engine connected' : `${bots.length} engines connected`}
        trailing={
          <GhostButton
            compact
            disabled={loading}
            label={loading ? 'LOADING' : 'REFRESH'}
            onPress={refresh}
          />
        }
      />
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
      {notice ? <Banner message={notice} onDismiss={() => setNotice(null)} /> : null}

      {bots.length === 0 ? (
        <EmptyState
          detail="No engine is connected to this server right now."
          title="Nothing online"
        />
      ) : (
        <>
          <LabeledInput
            hint="Optional message to the engine client and owner."
            label="REASON"
            maxLength={200}
            onChangeText={setReason}
            placeholder="not answering prompts"
            value={reason}
          />
          <View style={adminStyles.list}>
            {bots.map((bot) => (
              <View key={bot.botId} style={adminStyles.row}>
                <BotIcon
                  name={bot.name}
                  size={28}
                  uri={botIconUrl(bot.botId, bot.iconSha256)}
                />
                <View style={adminStyles.rowCopy}>
                  <Text numberOfLines={1} style={adminStyles.rowName}>
                    {bot.name}{' '}
                    <Text style={adminStyles.rowMeta}>({bot.elo})</Text>
                  </Text>
                  <Text numberOfLines={1} style={adminStyles.rowMeta}>
                    {/*
                      Sockets rather than the slot count its owner declared.
                      The gap between the two is the number a host needs when an
                      engine is behaving strangely: three declared and one
                      connected is a client that failed to open its slots.
                    */}
                    {bot.activeGames} of {bot.connections} socket
                    {bot.connections === 1 ? '' : 's'} busy
                    {bot.declaredSlots > bot.connections
                      ? ` · ${bot.declaredSlots} declared`
                      : ''}
                    {bot.engineName ? ` · ${bot.engineName}` : ''}
                    {bot.clientVersion ? ` · client ${bot.clientVersion}` : ''}
                  </Text>
                </View>
                {bot.reservedFor ? (
                  <Badge label="RESERVE" tone="warm" />
                ) : null}
                {bot.draining ? <Badge label="DRAINING" tone="live" /> : null}
                {bot.benched ? <Badge label="BENCHED" tone="neutral" /> : null}
                {bot.allowPublicPlay ? null : <Badge label="PRIVATE" tone="neutral" />}
                {bot.enterTournaments ? null : <Badge label="NO EVENTS" tone="neutral" />}
                {bot.restricted?.length ? (
                  <Badge label="RESTRICTED" tone="live" />
                ) : null}
                <GhostLink compact href={links.player(bot.name)} label="PAGE" />
                {/*
                  The gentle one first and next to the severe one, so the choice
                  is in front of a host rather than one of them being the only
                  button on the row.
                */}
                <GhostButton
                  compact
                  disabled={busy || bot.draining}
                  label="DRAIN"
                  onPress={() =>
                    run(
                      () => shutdownBot(admin.token, bot.botId, false),
                      `${bot.name} will leave once it has finished what it is playing.`,
                    )
                  }
                />
                <ConfirmButton
                  armed={confirming === bot.botId}
                  busy={busy}
                  label="DISCONNECT"
                  onArm={() => setConfirming(bot.botId)}
                  onConfirm={() =>
                    run(
                      () => disconnectBot(admin.token, bot.botId, reason.trim()),
                      `Closed ${bot.name}'s sockets. Its process is untouched and may reconnect.`,
                    )
                  }
                />
              </View>
            ))}
          </View>
          {bots.some((bot) => bot.reservedFor) ? (
            <Text style={styles.reserveNote}>
              In reserve:{' '}
              {bots
                .filter((bot) => bot.reservedFor)
                .map((bot) => `${bot.name} (${bot.reservedFor})`)
                .join(', ')}
              . Reserved engines only play scheduled matches until the event ends.
            </Text>
          ) : null}
        </>
      )}
    </Panel>
  );
}

const styles = themedSheet(() => ({
  reserveNote: { ...type.body, color: colors.goldSoft, marginTop: space.small },
}));
