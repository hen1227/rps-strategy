import { failureMessage } from '@/errors';
import { useCallback, useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import {
  Badge,
  Banner,
  Checkbox,
  EmptyState,
  GhostButton,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';
import {
  botClientScriptUrl,
  createBot,
  exampleEngineUrl,
  listMyBots,
  retireBot,
  rotateBotToken,
  updateBot,
  type Bot,
} from '@/store/api/bots';
import { ApiError } from '@/store/api/http';
import { useGameStore } from '@/store/gameStore';
import { colors, radius } from '@/theme';

/** The message an API failure should show, whatever kind of failure it was. */


// The engine bots hanging off a signed-in account.
//
// Its own component because it is a registry with its own failure states, and
// because it has now lived on two different screens. The session it works from
// is the one the store holds, which is the same one the lobby socket connects
// with, so it takes no props at all.

export default function BotManagerPanel() {
  const token = useGameStore((state) => state.sessionToken);
  const clearSession = useGameStore((state) => state.clearSession);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  // A freshly minted token, shown once. Never fetched again.
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const refresh = useCallback(async (sessionToken: string | null) => {
    if (!sessionToken) {
      setBots([]);
      return;
    }
    try {
      const mine = await listMyBots(sessionToken);
      setBots(mine.bots ?? []);
      setRemaining(mine.remaining ?? null);
    } catch (caught) {
      // An expired session is the common case, and signing the person out
      // quietly is friendlier than an error they cannot act on. A server that
      // merely could not be reached is not grounds for throwing them out.
      if (caught instanceof ApiError && caught.status === 401) clearSession();
      else setError(failureMessage(caught));
    }
  }, [clearSession]);

  useEffect(() => {
    refresh(token);
  }, [token, refresh]);

  const run = async <Result,>(action: () => Promise<Result>, successNotice?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (successNotice) setNotice(successNotice);
      return result;
    } catch (caught) {
      setError(failureMessage(caught));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const addBot = () =>
    run(async () => {
      if (!token) return null;
      const created = await createBot(token);
      setFreshToken(created.token);
      await refresh(token);
      return created;
    });

  const toggle = (bot: Bot, field: 'allowPublicPlay' | 'enterTournaments') =>
    run(async () => {
      if (!token) return;
      await updateBot(token, bot.botId, {
        description: bot.description ?? '',
        allowPublicPlay: field === 'allowPublicPlay' ? !bot.allowPublicPlay : bot.allowPublicPlay,
        enterTournaments:
          field === 'enterTournaments' ? !bot.enterTournaments : bot.enterTournaments,
      });
      await refresh(token);
    }, 'Updated. Note that rpsbot.conf re-applies its own settings when the bot restarts.');

  const rotate = (bot: Bot) =>
    run(async () => {
      if (!token) return;
      const rotated = await rotateBotToken(token, bot.botId);
      setFreshToken(rotated.token);
      await refresh(token);
    }, 'New token issued. The bot keeps its rating and history.');

  const retire = (bot: Bot) =>
    run(async () => {
      if (!token) return;
      await retireBot(token, bot.botId);
      await refresh(token);
    }, 'Bot retired and its name released.');

  // Bots hang off a real account, so there is nothing to show without one. The
  // account screen offers registration in this panel's place.
  if (!token) return null;

  return (
    <Panel>
      {/* No link to the guide: the guide is on this page, under this panel. */}
      <SectionHeading eyebrow="BOTS" title="Your bots" />
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
      {notice ? <Banner message={notice} onDismiss={() => setNotice(null)} /> : null}

      {freshToken ? (
        <View style={styles.tokenBox}>
          <Text style={styles.tokenLabel}>YOUR BOT TOKEN — SHOWN ONCE</Text>
          <Text selectable style={styles.tokenValue}>
            {freshToken}
          </Text>
          <Text style={styles.tokenHelp}>
            {'Download the client, then run it and paste this when it asks:\n\n'}
            {'  curl -O '}
            {botClientScriptUrl}
            {'\n  pip install websockets'}
            {'\n  python3 rpsbot.py -- ./your-engine'}
          </Text>
          <View style={styles.actions}>
            <GhostButton
              label="GET THE CLIENT"
              onPress={() => Linking.openURL(botClientScriptUrl)}
            />
            <GhostButton
              label="GET AN EXAMPLE BOT"
              onPress={() => Linking.openURL(exampleEngineUrl)}
            />
            <GhostButton label="HIDE" onPress={() => setFreshToken(null)} />
          </View>
        </View>
      ) : null}

      {bots.length === 0 ? (
        <EmptyState
          detail="Add one to get a token, then run the client on your own machine."
          title="No bots yet"
        />
      ) : (
        <View style={styles.list}>
          {bots.map((bot) => (
            <View key={bot.botId} style={styles.row}>
              <View style={styles.rowCopy}>
                <Text style={styles.rowName}>
                  {bot.name || 'Unclaimed slot'}{' '}
                  <Badge
                    label={bot.claimed ? 'CONNECTED ONCE' : 'AWAITING FIRST RUN'}
                    tone={bot.claimed ? 'accent' : 'neutral'}
                  />
                </Text>
                {bot.engineName ? (
                  <Text style={styles.rowMeta}>
                    {bot.engineName}
                    {bot.engineModes?.length ? ` · ${bot.engineModes.join(' · ')}` : ''}
                  </Text>
                ) : null}
              </View>
              <Checkbox
                checked={bot.allowPublicPlay}
                label="Challengeable"
                onToggle={() => toggle(bot, 'allowPublicPlay')}
              />
              <Checkbox
                checked={bot.enterTournaments}
                label="Tournaments"
                onToggle={() => toggle(bot, 'enterTournaments')}
              />
              <GhostButton compact label="NEW TOKEN" onPress={() => rotate(bot)} />
              <GhostButton compact label="RETIRE" onPress={() => retire(bot)} />
            </View>
          ))}
        </View>
      )}

      <View style={styles.actions}>
        <PrimaryButton
          disabled={busy || remaining === 0}
          label={remaining === 0 ? 'BOT LIMIT REACHED' : 'ADD A BOT'}
          onPress={addBot}
        />
        {remaining !== null ? (
          <Text style={styles.help}>{remaining} of 5 slots left</Text>
        ) : null}
      </View>
      <Text style={styles.help}>
        These switches take effect immediately, but rpsbot.conf on your machine re-applies
        its own values the next time the bot restarts. Edit the file for a lasting change.
      </Text>
    </Panel>
  );
}

const styles = StyleSheet.create({
  help: { color: colors.textFaint, fontSize: 11, lineHeight: 16, marginTop: 8 },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  tokenBox: {
    marginTop: 10,
    padding: 12,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurfaceQuiet,
  },
  tokenLabel: { color: colors.accentText, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  tokenValue: {
    color: colors.textStrong,
    fontFamily: 'monospace',
    fontSize: 12,
    marginTop: 6,
  },
  tokenHelp: {
    color: colors.textFaint,
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 15,
    marginTop: 10,
  },
  list: { gap: 1, marginTop: 8 },
  row: {
    minHeight: 54,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingVertical: 6,
  },
  rowCopy: { flex: 1, minWidth: 160 },
  rowName: { color: colors.text, fontSize: 12, fontWeight: '800' },
  rowMeta: { color: colors.textFaint, fontSize: 10, marginTop: 2 },
});
