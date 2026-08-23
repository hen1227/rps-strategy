import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import ScreenShell from '@/ui/ScreenShell';
import {
  Badge,
  Banner,
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
  anonymizeAccount,
  listAccounts,
  updateAccountFlags,
  type AccountSummary,
} from '@/store/api/bots';
import { colors, contentWidth, radius, space, type } from '@/theme';

// Account administration.
//
// Its own screen rather than another panel, because a table of accounts wants
// the width, and because everything here is destructive enough that it should
// take a deliberate navigation to reach.

export default function AdminScreen() {
  const admin = useAdminToken();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Anonymizing cannot be undone, so it asks once. The confirmation is the id
  // of the account whose delete button has been pressed but not confirmed.
  const [confirming, setConfirming] = useState<string | null>(null);

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

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async <Result,>(action: () => Promise<Result>, successNotice?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (successNotice) setNotice(successNotice);
      await refresh();
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
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
                <View key={account.userId} style={styles.row}>
                  <View style={styles.rowCopy}>
                    <Text numberOfLines={1} style={styles.rowName}>
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
                    Only for people. A bot has no password either, but calling
                    it anonymous alongside its BOT badge says the wrong thing:
                    it has an owner, and that is the opposite of anonymous.
                  */}
                  {account.kind === 'bot' || account.registered ? null : (
                    <Badge label="ANON" tone="neutral" />
                  )}
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
                  <GhostButton
                    compact
                    disabled={busy}
                    label={confirming === account.userId ? 'CONFIRM?' : 'ANONYMIZE'}
                    onPress={() =>
                      confirming === account.userId
                        ? run(
                            () => anonymizeAccount(admin.token, account.userId),
                            'Account anonymized. Its games stay in the archive under a placeholder name.',
                          )
                        : setConfirming(account.userId)
                    }
                  />
                </View>
              ))}
            </View>
          )}
          <Text style={styles.help}>
            Anonymizing removes the person, not their games: an account that has played is
            stripped and disabled rather than deleted, because the games belong to both
            players. Its name is also rewritten inside every stored record.
          </Text>
        </Panel>
      </>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
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
  help: { ...type.body, color: colors.textFaint, marginTop: space.medium },
});
