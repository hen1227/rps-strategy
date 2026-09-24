import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import AccountFilters from './AccountFilters';
import ConfirmButton from './ConfirmButton';
import GameRow from './GameRow';
import ModerationControls from './ModerationControls';
import TitleEditor from './TitleEditor';
import { adminStyles } from './adminStyles';
import { failureMessage } from '@/errors';
import { relativeTime } from '@/features/bots/relativeTime';
import type { AdminToken } from '@/hooks/useAdminToken';
import { links } from '@/navigation/links';
import { getTitleCatalogue } from '@/store/api/accounts';
import {
  liftRestriction,
  listRestrictions,
  restrictAccount,
  type AdminRestriction,
} from '@/store/api/admin';
import {
  accountDetail,
  anonymizeAccount,
  deleteGame,
  grantAccountTitle,
  listAccounts,
  purgeAccount,
  purgeBot,
  revokeAccountTitle,
  updateAccountFlags,
  type AccountDetail,
  type AccountQuery,
  type AccountSummary,
} from '@/store/api/bots';
import type { RestrictionKind, Title } from '@/types/protocol';
import {
  Badge,
  Banner,
  EmptyState,
  GhostButton,
  GhostLink,
  Panel,
  SectionHeading,
} from '@/ui/primitives';

// Account administration.
//
// The panel is built around one distinction, and it is worth stating plainly
// because every button below is on one side of it:
//
//   - *Anonymize* removes the person and keeps the games. It is the right
//     answer for a privacy request, and it is what PRIVACY.md promises.
//   - *Delete* removes the rows. It is for the account, bot, or game that
//     should never have existed, where a placeholder name in somebody's history
//     preserves nothing anyone wanted.
//
// Both are offered, the destructive one is red, and every one of them asks
// twice.
//
// The middle ground between them and doing nothing is the moderation block
// inside an expanded row — mute, no ranked, no tournaments — which is where
// almost every actual incident should be resolved. See ModerationControls.

/** How a row's confirmation is keyed, so two armed buttons cannot be confused. */
type ConfirmKey = string;

export interface AccountsPanelProps {
  admin: AdminToken;
}

export default function AccountsPanel({ admin }: AccountsPanelProps) {
  // Opens with the Guests hidden and the most recently active first, which is
  // the answer nearly every time — see AccountFilters for why the unfiltered
  // list is unusable. "Everybody" is one press away.
  const [filter, setFilter] = useState<AccountQuery>({
    registered: true,
    sort: 'active',
  });
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [matched, setMatched] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Nothing here can be undone, so everything asks once. The value is the key
  // of the button that has been pressed but not confirmed.
  const [confirming, setConfirming] = useState<ConfirmKey | null>(null);
  // The account whose bots, games and sanctions are open below its row.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [restrictions, setRestrictions] = useState<AdminRestriction[]>([]);
  // The whole catalogue, fetched once: the title editor needs the titles an
  // account does *not* hold as much as the ones it does.
  const [titles, setTitles] = useState<Title[]>([]);

  const refresh = useCallback(
    async (applied: AccountQuery = filter) => {
      if (!admin.token) return;
      try {
        const page = await listAccounts(admin.token, applied);
        setAccounts(page?.accounts ?? []);
        setMatched(page?.total ?? 0);
      } catch (caught) {
        setError(failureMessage(caught));
      }
    },
    [admin.token, filter],
  );

  const refreshDetail = useCallback(
    async (userId: string | null) => {
      if (!admin.token || !userId) {
        setDetail(null);
        setRestrictions([]);
        return;
      }
      try {
        // Both together: an expanded row shows the account and what is against
        // it, and a half-loaded row that shows one but not the other invites a
        // second sanction on top of an existing one.
        const [loaded, sanctions] = await Promise.all([
          accountDetail(admin.token, userId),
          listRestrictions(admin.token, userId),
        ]);
        setDetail(loaded);
        setRestrictions(sanctions ?? []);
      } catch (caught) {
        // A detail that fails to load must not leave the previous account's
        // bots on screen under a different name.
        setDetail(null);
        setRestrictions([]);
        setError(failureMessage(caught));
      }
    },
    [admin.token],
  );

  useEffect(() => {
    refresh();
    getTitleCatalogue()
      .then(setTitles)
      .catch((caught) => setError(failureMessage(caught)));
  }, [refresh]);

  const run = async <Result,>(action: () => Promise<Result>, successNotice?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (successNotice) setNotice(successNotice);
      await Promise.all([refresh(), refreshDetail(expanded)]);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  const toggleExpanded = (userId: string) => {
    const next = expanded === userId ? null : userId;
    setExpanded(next);
    setConfirming(null);
    setDetail(null);
    setRestrictions([]);
    refreshDetail(next);
  };

  const applyRestriction = (
    userId: string,
    username: string,
    kind: RestrictionKind,
    reason: string,
    durationSeconds: number,
  ) =>
    run(
      () => restrictAccount(admin.token, userId, { kind, reason, durationSeconds }),
      `${username} is now restricted. They are told at once rather than finding out by being refused.`,
    );

  return (
    <Panel style={adminStyles.panel}>
      <SectionHeading
        eyebrow="ADMINISTRATION"
        title="Players"
        // Nothing to lock when the credential is who you are rather than
        // something you pasted.
        trailing={
          admin.unlocked && !admin.bySession ? (
            <GhostButton compact label="LOCK" onPress={admin.lock} />
          ) : null
        }
      />
      {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
      {notice ? <Banner message={notice} onDismiss={() => setNotice(null)} /> : null}
      <AccountFilters
        busy={busy}
        filter={filter}
        matched={matched}
        // The list follows the filter rather than waiting for a Search press:
        // the whole point of a toggle is that pressing it does the thing. The
        // text field is debounced by the same route — a keystroke is a filter
        // change like any other, and the requests are small and indexed.
        onChange={(next) => {
          setFilter(next);
          void refresh(next);
        }}
      />

      {accounts.length === 0 ? (
        <EmptyState
          detail={
            matched === 0 && (filter.query ?? '') === ''
              ? "No matches. Try fewer filters or press Clear."
              : 'Nothing matched that search.'
          }
          title="No accounts"
        />
      ) : (
        <View style={adminStyles.list}>
          {accounts.map((account) => (
            <View key={account.userId}>
              <View style={adminStyles.row}>
                <View style={adminStyles.rowCopy}>
                  <Text numberOfLines={1} style={adminStyles.rowName}>
                    {account.title ? `${account.title} ` : ''}
                    {account.username} <Text style={adminStyles.rowMeta}>({account.elo})</Text>
                  </Text>
                  <Text numberOfLines={1} style={adminStyles.rowMeta}>
                    {account.userId} · {account.gamesPlayed} games
                    {account.botCount ? ` · ${account.botCount} bots` : ''}
                    {/*
                      When they were last here, which is what the activity
                      filters are filtering on. A list filtered by something it
                      does not show is a list a host has to take on trust.
                    */}
                    {account.lastPlayedAtUnixMs
                      ? ` · last played ${relativeTime(account.lastPlayedAtUnixMs)}`
                      : ' · never played'}
                  </Text>
                </View>
                {account.kind === 'bot' ? <Badge label="BOT" tone="neutral" /> : null}
                {account.isAdmin ? <Badge label="ADMIN" tone="accent" /> : null}
                {account.disabled ? <Badge label="DISABLED" tone="live" /> : null}
                {/*
                  Sanctions on the row rather than only inside it, so a host
                  scanning for the person they muted yesterday does not have to
                  expand every name.
                */}
                {account.restrictions?.map((restriction) => (
                  <Badge
                    key={restriction.kind}
                    label={restriction.kind.toUpperCase()}
                    tone="warm"
                  />
                ))}
                {/*
                  Only for people. A bot has no credential of its own either,
                  but calling it anonymous alongside its BOT badge says the
                  wrong thing: it has an owner, and that is the opposite of
                  anonymous.
                */}
                {account.kind === 'bot' || account.registered ? null : (
                  <Badge label="ANON" tone="neutral" />
                )}
                {/*
                  Straight to their public page: the row above is what the host
                  can see, and this is what everybody else sees, which is often
                  the thing being asked about.

                  Only where there is one. Player pages exist for accounts
                  Discord has vouched for and for engines, so offering this on
                  an anonymous guest would be a button that lands on "no such
                  player".
                */}
                {account.registered || account.kind === 'bot' ? (
                  <GhostLink compact href={links.player(account.username)} label="PAGE" />
                ) : null}
                <GhostButton
                  compact
                  disabled={busy}
                  label={expanded === account.userId ? 'CLOSE' : 'MANAGE'}
                  onPress={() => toggleExpanded(account.userId)}
                />
                <GhostButton
                  compact
                  disabled={busy}
                  label={account.disabled ? 'ENABLE' : 'DISABLE'}
                  onPress={() =>
                    run(
                      () =>
                        updateAccountFlags(admin.token, account.userId, {
                          disabled: !account.disabled,
                        }),
                      account.disabled ? 'Account enabled.' : 'Account disabled.',
                    )
                  }
                />
                {account.kind === 'bot' || !account.registered ? null : (
                  <GhostButton
                    compact
                    disabled={busy}
                    label={account.isAdmin ? 'DEMOTE' : 'MAKE ADMIN'}
                    onPress={() =>
                      run(
                        () =>
                          updateAccountFlags(admin.token, account.userId, {
                            isAdmin: !account.isAdmin,
                          }),
                        account.isAdmin ? 'Administrator removed.' : 'Administrator added.',
                      )
                    }
                  />
                )}
                <ConfirmButton
                  armed={confirming === `anonymize:${account.userId}`}
                  busy={busy}
                  label="ANONYMIZE"
                  onArm={() => setConfirming(`anonymize:${account.userId}`)}
                  onConfirm={() =>
                    run(
                      () => anonymizeAccount(admin.token, account.userId),
                      'Account anonymized. Its games stay in the archive under a placeholder name.',
                    )
                  }
                  tone="quiet"
                />
                <ConfirmButton
                  armed={confirming === `purge:${account.userId}`}
                  busy={busy}
                  label="DELETE"
                  onArm={() => setConfirming(`purge:${account.userId}`)}
                  onConfirm={() =>
                    run(async () => {
                      const purge = await purgeAccount(admin.token, account.userId);
                      if (expanded === account.userId) {
                        setExpanded(null);
                        setDetail(null);
                      }
                      setNotice(
                        `Deleted ${purge.username || purge.userId}: ` +
                          `${purge.gamesDeleted} games, ${purge.botsDeleted} bots, ` +
                          `${purge.tournamentEntriesDeleted} tournament entries.`,
                      );
                    })
                  }
                />
              </View>

              {expanded === account.userId ? (
                <View style={adminStyles.detail}>
                  {detail === null ? (
                    <Text style={adminStyles.detailNote}>Loading…</Text>
                  ) : (
                    <>
                      {/*
                        First inside the row, because it is the one block here
                        that is a proportionate response. Everything below it
                        either removes somebody or hands them a title.
                      */}
                      <Text style={adminStyles.detailHeading}>RESTRICTIONS</Text>
                      <ModerationControls
                        busy={busy}
                        onLift={(kind) =>
                          run(
                            () => liftRestriction(admin.token, account.userId, kind),
                            `Lifted the ${kind} restriction on ${account.username}.`,
                          )
                        }
                        onRestrict={(kind, reason, durationSeconds) =>
                          applyRestriction(
                            account.userId,
                            account.username,
                            kind,
                            reason,
                            durationSeconds,
                          )
                        }
                        restrictions={restrictions}
                        username={account.username}
                      />

                      <Text style={adminStyles.detailHeading}>TITLES</Text>
                      <TitleEditor
                        account={detail.account}
                        busy={busy}
                        catalogue={titles}
                        onGrant={(title) =>
                          run(
                            () => grantAccountTitle(admin.token, account.userId, title),
                            `Granted ${title} to ${account.username}.`,
                          )
                        }
                        onRevoke={(title) =>
                          run(
                            () => revokeAccountTitle(admin.token, account.userId, title),
                            `Took ${title} from ${account.username}.`,
                          )
                        }
                      />

                      <Text style={adminStyles.detailHeading}>BOTS</Text>
                      {detail.bots.length === 0 ? (
                        <Text style={adminStyles.detailNote}>This account owns no bots.</Text>
                      ) : (
                        detail.bots.map((bot) => (
                          <View key={bot.botId} style={adminStyles.subRow}>
                            <View style={adminStyles.rowCopy}>
                              <Text numberOfLines={1} style={adminStyles.subRowName}>
                                {bot.name || 'Unclaimed slot'}
                              </Text>
                              <Text numberOfLines={1} style={adminStyles.rowMeta}>
                                {bot.botId}
                                {bot.engineName ? ` · ${bot.engineName}` : ''}
                              </Text>
                            </View>
                            {bot.retired ? <Badge label="RETIRED" tone="neutral" /> : null}
                            {bot.disabled ? <Badge label="DISABLED" tone="live" /> : null}
                            <ConfirmButton
                              armed={confirming === `bot:${bot.botId}`}
                              busy={busy}
                              label="DELETE BOT"
                              onArm={() => setConfirming(`bot:${bot.botId}`)}
                              onConfirm={() =>
                                run(async () => {
                                  const removed = await purgeBot(admin.token, bot.botId);
                                  setNotice(
                                    `Deleted ${removed.name || removed.botId}: ` +
                                      `${removed.gamesDeleted} games, ` +
                                      `${removed.seriesDeleted} series.`,
                                  );
                                })
                              }
                            />
                          </View>
                        ))
                      )}

                      <Text style={adminStyles.detailHeading}>RECENT GAMES</Text>
                      {detail.games.length === 0 ? (
                        <Text style={adminStyles.detailNote}>
                          This account has no recorded games.
                        </Text>
                      ) : (
                        detail.games.map((game) => (
                          <GameRow
                            armed={confirming === `game:${game.gameId}`}
                            busy={busy}
                            game={game}
                            key={game.gameId}
                            onArm={() => setConfirming(`game:${game.gameId}`)}
                            // Ratings handed back, which is the default
                            // everywhere: the usual reason to delete a game is
                            // that its result should not stand. The Games panel
                            // is where that can be turned off.
                            onDelete={() =>
                              run(
                                () => deleteGame(admin.token, game.gameId, true),
                                'Game deleted. Both players have their rating back.',
                              )
                            }
                          />
                        ))
                      )}
                    </>
                  )}
                </View>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </Panel>
  );
}
