import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import ScreenShell from '@/ui/ScreenShell';
import {
  Badge,
  Banner,
  Checkbox,
  EmptyState,
  GhostButton,
  LabeledInput,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';
import { failureMessage } from '@/errors';
import { useAdminToken } from '@/hooks/useAdminToken';
import {
  accountDetail,
  anonymizeAccount,
  deleteGame,
  grantAccountTitle,
  listAccounts,
  listAdminGames,
  purgeAccount,
  purgeBot,
  revokeAccountTitle,
  updateAccountFlags,
  type AccountDetail,
  type AccountSummary,
} from '@/store/api/bots';
import { getTitleCatalogue } from '@/store/api/accounts';
import type { Account, GameRecord, Title, TitleID } from '@/types/protocol';
import { colors, contentWidth, radius, space, type } from '@/theme';

// Account administration.
//
// Its own screen rather than another panel, because a table of accounts wants
// the width, and because everything here is destructive enough that it should
// take a deliberate navigation to reach.
//
// The screen is built around one distinction, and it is worth stating plainly
// because every button below is on one side of it:
//
//   - *Anonymize* removes the person and keeps the games. It is the right
//     answer for a privacy request, and it is what PRIVACY.md promises.
//   - *Delete* removes the rows. It is for the account, bot, or game that
//     should never have existed, where a placeholder name in somebody's
//     history preserves nothing anyone wanted.
//
// Both are offered, the destructive one is red, and every one of them asks
// twice.

/** How a row's confirmation is keyed, so two armed buttons cannot be confused. */
type ConfirmKey = string;

/**
 * A destructive button that arms on the first press and fires on the second.
 *
 * The confirmation lives in the parent rather than in here because pressing
 * anything else on the screen should disarm it: an armed delete that stays
 * armed while the host goes off to search for something else is a trap.
 */
function ConfirmButton({
  armed,
  busy,
  label,
  onArm,
  onConfirm,
  tone = 'danger',
}: {
  armed: boolean;
  busy: boolean;
  label: string;
  onArm: () => void;
  onConfirm: () => void;
  tone?: 'danger' | 'quiet';
}) {
  return (
    <Pressable
      accessibilityLabel={armed ? `Confirm: ${label}` : label}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={armed ? onConfirm : onArm}
      style={({ pressed }) => [
        styles.actionButton,
        tone === 'danger' && styles.actionButtonDanger,
        armed && styles.actionButtonArmed,
        busy && styles.actionButtonDisabled,
        pressed && styles.actionButtonPressed,
      ]}
    >
      <Text
        style={[
          styles.actionButtonText,
          tone === 'danger' && styles.actionButtonTextDanger,
          armed && styles.actionButtonTextArmed,
        ]}
      >
        {armed ? 'CONFIRM?' : label}
      </Text>
    </Pressable>
  );
}

/**
 * The titles an account holds, and every other title in the catalogue.
 *
 * One list rather than a picker and a list: which titles somebody has is the
 * question being asked, and the answer to "can I give them GM" is the same row
 * pressed from the other side. Held ones are gold and take them away; the rest
 * are grey and hand them over.
 *
 * Granting is not confirmed twice the way the buttons around it are. Nothing
 * here is destructive — the worst outcome is a tag on the wrong name, undone by
 * pressing the same row again.
 */
function TitleEditor({
  account,
  busy,
  catalogue,
  onGrant,
  onRevoke,
}: {
  account: Account;
  busy: boolean;
  catalogue: Title[];
  onGrant: (title: TitleID) => void;
  onRevoke: (title: TitleID) => void;
}) {
  const held = new Map((account.titles ?? []).map((award) => [award.id, award]));
  if (catalogue.length === 0) {
    return <Text style={styles.detailNote}>Loading titles…</Text>;
  }
  return (
    <View style={styles.titleRow}>
      {catalogue.map((title) => {
        const award = held.get(title.id);
        return (
          <Pressable
            accessibilityLabel={
              award ? `Revoke ${title.name}` : `Grant ${title.name} to ${account.username}`
            }
            accessibilityRole="button"
            accessibilityState={{ selected: Boolean(award), disabled: busy }}
            disabled={busy}
            key={title.id}
            onPress={() => (award ? onRevoke(title.id) : onGrant(title.id))}
            style={({ pressed }) => [
              styles.titleChip,
              award && styles.titleChipHeld,
              busy && styles.actionButtonDisabled,
              pressed && styles.actionButtonPressed,
            ]}
          >
            <Text style={[styles.titleChipText, award && styles.titleChipTextHeld]}>
              {title.id}
            </Text>
            <Text style={styles.titleChipName}>
              {award?.source === 'granted' ? 'granted' : award ? 'earned' : title.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** One game, as a line an administrator can identify it from and delete. */
function GameRow({
  armed,
  busy,
  game,
  onArm,
  onDelete,
}: {
  armed: boolean;
  busy: boolean;
  game: GameRecord;
  onArm: () => void;
  onDelete: () => void;
}) {
  const played = new Date(game.finishedAtUnixMs);
  const outcome =
    game.outcome === 'draw'
      ? 'draw'
      : `${game.outcome === 'red_win' ? game.redPlayer.username : game.bluePlayer.username} won`;
  return (
    <View style={styles.subRow}>
      <View style={styles.rowCopy}>
        <Text numberOfLines={1} style={styles.subRowName}>
          {game.redPlayer.username} vs {game.bluePlayer.username}
        </Text>
        <Text numberOfLines={1} style={styles.rowMeta}>
          {game.modeName} · {outcome} · {game.endReason} ·{' '}
          {Number.isFinite(played.valueOf()) ? played.toLocaleDateString() : 'undated'} ·{' '}
          {game.gameId}
        </Text>
      </View>
      {game.ranked ? <Badge label="RANKED" tone="neutral" /> : null}
      <ConfirmButton
        armed={armed}
        busy={busy}
        label="DELETE"
        onArm={onArm}
        onConfirm={onDelete}
      />
    </View>
  );
}

export default function AdminScreen() {
  const admin = useAdminToken();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Nothing here can be undone, so everything asks once. The value is the key
  // of the button that has been pressed but not confirmed.
  const [confirming, setConfirming] = useState<ConfirmKey | null>(null);
  // The account whose bots and games are open below its row, and what they are.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  // The game browser is its own search: a game is often the thing being looked
  // for, and finding it through whichever of its two players happens to be
  // memorable is a detour.
  const [gameQuery, setGameQuery] = useState('');
  const [games, setGames] = useState<GameRecord[]>([]);
  // Deleting a game hands its rating back by default, because the usual reason
  // to delete one is that the result should not stand. The exception — a game
  // removed for being unwatchable, whose result was fair — is a toggle rather
  // than a second button, since it applies to whichever row is pressed next.
  const [revertRatings, setRevertRatings] = useState(true);
  // The whole catalogue, fetched once: the title editor below needs the titles
  // an account does *not* hold as much as the ones it does.
  const [titles, setTitles] = useState<Title[]>([]);

  const refresh = useCallback(
    async (searchText = query) => {
      if (!admin.token) return;
      try {
        setAccounts((await listAccounts(admin.token, searchText)) ?? []);
      } catch (caught) {
        setError(failureMessage(caught));
      }
    },
    [admin.token, query],
  );

  const refreshGames = useCallback(
    async (searchText = gameQuery) => {
      if (!admin.token) return;
      try {
        setGames((await listAdminGames(admin.token, searchText)) ?? []);
      } catch (caught) {
        setError(failureMessage(caught));
      }
    },
    [admin.token, gameQuery],
  );

  const refreshDetail = useCallback(
    async (userId: string | null) => {
      if (!admin.token || !userId) {
        setDetail(null);
        return;
      }
      try {
        setDetail(await accountDetail(admin.token, userId));
      } catch (caught) {
        // A detail that fails to load must not leave the previous account's
        // bots on screen under a different name.
        setDetail(null);
        setError(failureMessage(caught));
      }
    },
    [admin.token],
  );

  useEffect(() => {
    refresh();
    refreshGames();
    getTitleCatalogue()
      .then(setTitles)
      .catch((caught) => setError(failureMessage(caught)));
  }, [refresh, refreshGames]);

  const run = async <Result,>(action: () => Promise<Result>, successNotice?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (successNotice) setNotice(successNotice);
      await Promise.all([refresh(), refreshGames(), refreshDetail(expanded)]);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  /** Deleting a game is offered from two lists, and does the same thing in both. */
  const removeGame = (gameId: string) =>
    run(
      () => deleteGame(admin.token, gameId, revertRatings),
      revertRatings
        ? 'Game deleted. Both players have their rating back.'
        : 'Game deleted. The ratings it moved were left alone.',
    );

  const toggleExpanded = (userId: string) => {
    const next = expanded === userId ? null : userId;
    setExpanded(next);
    setConfirming(null);
    setDetail(null);
    refreshDetail(next);
  };

  const header = (
    <SectionHeading
      eyebrow="ADMINISTRATION"
      title="Accounts"
      // Nothing to lock when the credential is who you are rather than
      // something you pasted.
      trailing={
        admin.unlocked && !admin.bySession ? (
          <GhostButton compact label="LOCK" onPress={admin.lock} />
        ) : null
      }
    />
  );

  if (!admin.unlocked) {
    return (
      <ScreenShell width={contentWidth.reading}>
        <Panel>
          <SectionHeading eyebrow="PRIVATE" title="Host controls" />
          <Text style={styles.help}>
            Sign in with an administrator account and these tools open by themselves. This
            form is the other door, for a host running the server without one.
          </Text>
          {admin.error ? <Banner message={admin.error} tone="error" /> : null}
          <LabeledInput
            label="ADMIN TOKEN"
            onChangeText={setDraft}
            secureTextEntry
            value={draft}
          />
          <PrimaryButton
            disabled={admin.verifying}
            label="UNLOCK COMMANDS"
            onPress={() => admin.unlock(draft).then((ok) => ok && setDraft(''))}
          />
        </Panel>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell width={contentWidth.wide}>
      <>
        <Panel style={styles.adminPanel}>
          {header}
          {error ? <Banner message={error} onDismiss={() => setError(null)} tone="error" /> : null}
          {notice ? <Banner message={notice} onDismiss={() => setNotice(null)} /> : null}
          <View style={styles.searchRow}>
            <View style={styles.searchField}>
              <LabeledInput
                autoCapitalize="none"
                label="SEARCH"
                onChangeText={setQuery}
                onSubmitEditing={() => refresh()}
                placeholder="username or user id"
                value={query}
              />
            </View>
            <GhostButton label="SEARCH" onPress={() => refresh()} />
          </View>

          {accounts.length === 0 ? (
            <EmptyState detail="Nothing matched that search." title="No accounts" />
          ) : (
            <View style={styles.list}>
              {accounts.map((account) => (
                <View key={account.userId}>
                  <View style={styles.row}>
                    <View style={styles.rowCopy}>
                      <Text numberOfLines={1} style={styles.rowName}>
                        {account.title ? `${account.title} ` : ''}
                        {account.username}{' '}
                        <Text style={styles.rowElo}>({account.elo})</Text>
                      </Text>
                      <Text numberOfLines={1} style={styles.rowMeta}>
                        {account.userId} · {account.gamesPlayed} games
                        {account.botCount ? ` · ${account.botCount} bots` : ''}
                      </Text>
                    </View>
                    {account.kind === 'bot' ? <Badge label="BOT" tone="neutral" /> : null}
                    {account.isAdmin ? <Badge label="ADMIN" tone="accent" /> : null}
                    {account.disabled ? <Badge label="DISABLED" tone="live" /> : null}
                    {/*
                      Only for people. A bot has no credential of its own
                      either, but calling it anonymous alongside its BOT badge
                      says the wrong thing: it has an owner, and that is the
                      opposite of anonymous.
                    */}
                    {account.kind === 'bot' || account.registered ? null : (
                      <Badge label="ANON" tone="neutral" />
                    )}
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
                    <View style={styles.detail}>
                      {detail === null ? (
                        <Text style={styles.detailNote}>Loading…</Text>
                      ) : (
                        <>
                          <Text style={styles.detailHeading}>TITLES</Text>
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

                          <Text style={styles.detailHeading}>BOTS</Text>
                          {detail.bots.length === 0 ? (
                            <Text style={styles.detailNote}>This account owns no bots.</Text>
                          ) : (
                            detail.bots.map((bot) => (
                              <View key={bot.botId} style={styles.subRow}>
                                <View style={styles.rowCopy}>
                                  <Text numberOfLines={1} style={styles.subRowName}>
                                    {bot.name || 'Unclaimed slot'}
                                  </Text>
                                  <Text numberOfLines={1} style={styles.rowMeta}>
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

                          <Text style={styles.detailHeading}>RECENT GAMES</Text>
                          {detail.games.length === 0 ? (
                            <Text style={styles.detailNote}>
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
                                onDelete={() => removeGame(game.gameId)}
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
          <Text style={styles.help}>
            Anonymizing removes the person, not their games: an account that has played is
            stripped and disabled rather than deleted, because the games belong to both
            players. Its name is also rewritten inside every stored record. Deleting removes
            the rows instead — the account, its bots, its games, and its tournament entries —
            and hands every opponent their rating back.
          </Text>
        </Panel>

        <Panel style={styles.adminPanel}>
          <SectionHeading eyebrow="ADMINISTRATION" title="Games" />
          <View style={styles.searchRow}>
            <View style={styles.searchField}>
              <LabeledInput
                autoCapitalize="none"
                label="SEARCH"
                onChangeText={setGameQuery}
                onSubmitEditing={() => refreshGames()}
                placeholder="username, user id, or game id"
                value={gameQuery}
              />
            </View>
            <GhostButton label="SEARCH" onPress={() => refreshGames()} />
          </View>
          <Checkbox
            checked={revertRatings}
            label="Give both players their rating back"
            onToggle={() => setRevertRatings((current) => !current)}
          />

          {games.length === 0 ? (
            <EmptyState detail="Nothing matched that search." title="No games" />
          ) : (
            <View style={styles.list}>
              {games.map((game) => (
                <GameRow
                  armed={confirming === `game:${game.gameId}`}
                  busy={busy}
                  game={game}
                  key={game.gameId}
                  onArm={() => setConfirming(`game:${game.gameId}`)}
                  onDelete={() => removeGame(game.gameId)}
                />
              ))}
            </View>
          )}
          <Text style={styles.help}>
            A deleted game leaves the history, the archive, and any review of it. With the box
            above ticked — which is the default, since the usual reason to delete a game is
            that its result should not stand — the Elo and the win counts it moved are
            reversed for both players. That reversal is exact for the last game somebody
            played and an approximation for an older one, because the games since were rated
            against a number that has now changed.
          </Text>
        </Panel>
      </>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  titleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.snug,
    paddingVertical: space.snug,
  },
  titleChip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.tight,
    paddingHorizontal: space.small,
    paddingVertical: space.tight,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
  },
  titleChipHeld: { borderColor: colors.goldBorder, backgroundColor: colors.goldSurfaceDeep },
  titleChipText: { ...type.label, color: colors.textMuted },
  titleChipTextHeld: { color: colors.goldBright },
  titleChipName: { fontSize: 8, color: colors.textFaint },

  adminPanel: {
    borderColor: colors.goldBorder,
    backgroundColor: colors.goldSurfaceDeep,
    borderRadius: radius.large,
  },
  searchRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  searchField: { flex: 1 },
  list: { gap: 1, marginTop: 8 },
  row: {
    minHeight: 54,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingVertical: 6,
  },
  rowCopy: { flex: 1, minWidth: 180 },
  rowName: { color: colors.text, fontSize: 12, fontWeight: '800' },
  rowElo: { color: colors.textFaint, fontSize: 10, fontWeight: '600' },
  rowMeta: { color: colors.textFaint, fontSize: 10, marginTop: 2 },
  // The expanded block is inset and darker so that a delete button inside it
  // reads as belonging to the account above rather than to the list.
  detail: {
    marginLeft: space.medium,
    marginBottom: space.small,
    paddingLeft: space.medium,
    borderLeftWidth: 2,
    borderLeftColor: colors.goldBorder,
  },
  detailHeading: {
    color: colors.textFaint,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: space.small,
  },
  detailNote: { color: colors.textFaint, fontSize: 10, paddingVertical: 6 },
  subRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 5,
  },
  subRowName: { color: colors.text, fontSize: 11, fontWeight: '700' },
  // Matched to GhostButton, so the quiet destructive action beside it reads as
  // a button rather than as a disabled one.
  actionButton: {
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceRaised,
  },
  actionButtonDanger: {
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurfaceQuiet,
  },
  // An armed button is filled rather than merely relabelled: the difference
  // between "delete" and "yes, really" should be visible from across the row.
  actionButtonArmed: {
    borderColor: colors.dangerStrong,
    backgroundColor: colors.dangerSurface,
  },
  actionButtonDisabled: { opacity: 0.45 },
  actionButtonPressed: { opacity: 0.7 },
  actionButtonText: {
    color: colors.textSubtle,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  actionButtonTextDanger: { color: colors.dangerSoft },
  actionButtonTextArmed: { color: colors.dangerText },
  help: { ...type.body, color: colors.textFaint, marginTop: space.medium },
});
