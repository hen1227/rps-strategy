import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  canPlayRankedNow,
  enteredSummary,
  ownedEntries,
  ownedStatus,
  type OwnedEntry,
} from './roundsView';
import { failureMessage } from '@/errors';
import BotIcon from '@/features/bots/BotIcon';
import { links } from '@/navigation/links';
import {
  botIconUrl,
  listMyBots,
  setBotSwitch,
  startRankedMatch,
  type OwnedBot,
} from '@/store/api/bots';
import { ApiError } from '@/store/api/http';
import type { LadderFieldEngine } from '@/store/api/ladderPool';
import { useGameStore } from '@/store/gameStore';
import { colors, space, themedSheet, type } from '@/theme';
import ListRow from '@/ui/ListRow';
import {
  Badge,
  Banner,
  EmptyState,
  GhostLink,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';

// Entering and withdrawing your own engines, on the page about the rounds.
//
// The switch itself is not new — it has always been a checkbox in the registry
// on `/account/bots`, between "Challengeable" and "Tournaments". What was
// missing is that the checkbox is three pages away from anything that says what
// it does, so the only way to find out whether ticking it worked was to wait an
// hour and see. Here it sits directly under the field it changes: press ENTER
// and your engine appears in the list above, with the round it will be in.
//
// The same one call the registry makes, through `setBotSwitch` rather than
// `updateBot`, which matters more than it looks: the endpoint is a whole-record
// write despite its verb, so a body that omits the other two switches turns
// them off. A second copy of "remember to send the other two" is exactly the
// bug that helper exists to prevent.

export interface YourEnginesPanelProps {
  /** The published field, so a row can say what the round will do with it. */
  field: LadderFieldEngine[];
  /** Called after a switch takes, so the field above redraws with it. */
  onChanged: () => void;
}

export default function YourEnginesPanel({ field, onChanged }: YourEnginesPanelProps) {
  const router = useRouter();
  const token = useGameStore((state) => state.sessionToken);
  const clearSession = useGameStore((state) => state.clearSession);
  const [bots, setBots] = useState<OwnedBot[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Which engine is mid-press, and at which of the two buttons.
  //
  // The action half is not decoration: both buttons live on one row and both
  // read this, so a bare bot id would spin the pair of them every time either
  // was pressed.
  const [busy, setBusy] = useState<{ botId: string; action: 'toggle' | 'play' } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) {
      setBots([]);
      setLoaded(true);
      return;
    }
    try {
      const mine = await listMyBots(token);
      setBots(mine.bots ?? []);
      setError(null);
    } catch (caught) {
      // An expired session is the common case, and signing somebody out quietly
      // is friendlier than an error they cannot act on — the registry panel
      // makes the same call for the same reason. A server that merely could not
      // be reached is not grounds for throwing them out.
      if (caught instanceof ApiError && caught.status === 401) clearSession();
      else setError(failureMessage(caught));
    } finally {
      setLoaded(true);
    }
  }, [clearSession, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (entry: OwnedEntry) => {
    if (!token) return;
    setBusy({ botId: entry.bot.botId, action: 'toggle' });
    setError(null);
    try {
      await setBotSwitch(token, entry.bot, 'enterLadder', !entry.entered);
      await refresh();
      // The field is the server's answer to a question this just changed, so it
      // is re-read rather than patched here. Patching it would mean deciding
      // locally whether the round would now seat the engine, which is the one
      // judgement this page deliberately does not make.
      onChanged();
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  // Press, then go and watch it.
  //
  // Straight to the run's own page rather than a banner saying it started,
  // because what somebody wants after pressing this is the two games — and the
  // series page is already the place that draws them live and keeps the score
  // table afterwards. `push` rather than `replace`: coming back to the rounds
  // page is the other half of the trip.
  const playNow = async (entry: OwnedEntry) => {
    if (!token) return;
    setBusy({ botId: entry.bot.botId, action: 'play' });
    setError(null);
    try {
      const series = await startRankedMatch(token, entry.bot.botId);
      // The field above says who is free, and a press has just taken two of
      // them out of it. Re-read before leaving so the list is right when this
      // page comes back rather than a screen-length of stale rows.
      onChanged();
      router.push(links.series(series.seriesId));
    } catch (caught) {
      // The server's own words. A 409 here is "your engine is in a game" or
      // "nobody else is free", both of which are written to be read as they
      // stand and neither of which is worth a second translation.
      setError(failureMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  // Signed out there is nothing to draw and nothing to offer: a bot hangs off an
  // account, and the way to get one is a page of its own.
  if (!token) {
    return (
      <Panel>
        <SectionHeading eyebrow="YOUR ENGINES" title="Enter your own bot" />
        <Text style={styles.help}>
          Sign in, register a bot, and run the client to join.
        </Text>
        <View style={styles.actions}>
          <GhostLink href={links.account()} label="SIGN IN" tone="accent" />
          <GhostLink href={links.botGuide()} label="HOW TO CONNECT A BOT" />
        </View>
      </Panel>
    );
  }

  const entries = ownedEntries(bots, field);
  const summary = enteredSummary(entries);

  return (
    <Panel>
      <SectionHeading
        eyebrow="YOUR ENGINES"
        title="Enter and play"
        trailing={
          summary ? <Badge label={summary.toUpperCase()} tone="accent" /> : undefined
        }
      />
      {/*
        What entering costs, on the screen where somebody decides. It is the one
        switch on a bot that spends its owner's machine on a schedule, so what
        the pool will do with it belongs next to the button rather than in a
        document — including that PLAY NOW makes the cost the owner's own to
        choose, which is the half the old copy could promise a ceiling for and
        this one cannot.

        What has not changed is the sentence that matters, so it is still here:
        the server picks the opponent and the conditions. That is the whole of
        why these games count and a hand-started series does not.
      */}
      <Text style={styles.help}>
        Keep your engine connected for hourly pairings, or choose PLAY NOW for an extra pair. The server picks opponents and settings for both.
      </Text>
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}

      {entries.length === 0 ? (
        loaded ? (
          <EmptyState
            detail="Register a bot and run the client to join."
            title="You have no bots yet"
          />
        ) : (
          <Text style={styles.help}>Loading…</Text>
        )
      ) : (
        <View style={styles.list}>
          {entries.map((entry, index) => (
            <ListRow
              divided={index > 0}
              key={entry.bot.botId}
              leading={
                <BotIcon
                  name={entry.bot.name ?? '?'}
                  size={34}
                  uri={botIconUrl(entry.bot.botId, entry.bot.iconSha256)}
                />
              }
              meta={ownedStatus(entry)}
              metaLines={2}
              title={entry.bot.name || 'Unclaimed slot'}
              trailing={
                // Nothing to press on a slot that has never connected. Its
                // switch is on by default and the button would say WITHDRAW,
                // which is a strange thing to offer about an engine that has
                // never been in anything — and it would not even hold: the
                // client sends its own `ladder` setting when it claims the
                // slot, so whatever is set here is overwritten by rpsbot.conf
                // the first time the bot connects. The line beside it says
                // what to do instead.
                //
                // One button whose label flips, rather than a checkbox. The two
                // states are not equally weighted — entering costs the owner's
                // machine time on a schedule — so the press that does that says
                // what it does, and the quiet tone on WITHDRAW keeps a row of
                // entered engines from reading as a row of things to press.
                // Both are the same control, so the row does not change shape
                // when it is pressed: `GhostButton` cannot take a spinner, and
                // a toggle with no pending state is a toggle people press
                // twice.
                !entry.bot.claimed ? null : (
                  <View style={styles.rowActions}>
                    {/*
                      PLAY NOW only once the engine is in, because the round is
                      what it plays: an unentered bot has consented to nothing
                      and there would be nothing for the press to bring forward.
                      Disabled rather than hidden while it is busy or offline —
                      the row already says which, and a button that comes and
                      goes as an engine finishes a game is a row that moves
                      under the finger.
                    */}
                    {entry.entered ? (
                      <PrimaryButton
                        accessibilityLabel={`Play a ranked match with ${
                          entry.bot.name ?? 'this bot'
                        } now`}
                        compact
                        disabled={busy !== null || !canPlayRankedNow(entry)}
                        label="PLAY NOW"
                        loading={busy?.botId === entry.bot.botId && busy.action === 'play'}
                        onPress={() => void playNow(entry)}
                        tone="accent"
                      />
                    ) : null}
                    <PrimaryButton
                      accessibilityLabel={
                        entry.entered
                          ? `Withdraw ${entry.bot.name ?? 'this bot'} from the hourly rounds`
                          : `Enter ${entry.bot.name ?? 'this bot'} in the hourly rounds`
                      }
                      compact
                      disabled={busy !== null}
                      label={entry.entered ? 'WITHDRAW' : 'ENTER'}
                      loading={busy?.botId === entry.bot.botId && busy.action === 'toggle'}
                      onPress={() => void toggle(entry)}
                      tone={entry.entered ? 'quiet' : 'accent'}
                    />
                  </View>
                )
              }
            />
          ))}
        </View>
      )}

      {entries.length > 0 ? (
        <Text style={styles.note}>
          Changes apply next round. Update `ladder` in rpsbot.conf too; restarting the client restores that setting.
        </Text>
      ) : null}
    </Panel>
  );
}

const styles = themedSheet(() => ({
  help: { ...type.body, color: colors.textMuted, marginTop: space.small },
  // Two buttons where there was one. Wrapping rather than shrinking, because
  // PLAY NOW and WITHDRAW are both words rather than icons and a narrow phone
  // would otherwise squeeze one of them to an ellipsis; `flex-end` keeps the
  // pair against the right edge whether they sit on one line or two.
  rowActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space.snug,
  },
  list: { marginTop: space.small },
  note: { ...type.meta, color: colors.textFaint, marginTop: space.small },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.snug,
    marginTop: space.medium,
  },
}));
