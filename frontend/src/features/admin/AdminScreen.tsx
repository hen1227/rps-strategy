import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import AccountsPanel from './AccountsPanel';
import AnalyticsPanel from './AnalyticsPanel';
import BotBenchPanel from './BotBenchPanel';
import BotControlPanel from './BotControlPanel';
import GamesPanel from './GamesPanel';
import ReportsPanel from './ReportsPanel';
import ServerControlsPanel from './ServerControlsPanel';
import WeekendAdminPanel from './WeekendAdminPanel';
import TournamentAdminPanel from './TournamentAdminPanel';
import { adminStyles } from './adminStyles';
import { useAdminToken } from '@/hooks/useAdminToken';
import { links } from '@/navigation/links';
import { colors, contentWidth, space, themedSheet, type } from '@/theme';
import ScreenShell from '@/ui/ScreenShell';
import TabBar from '@/ui/TabBar';
import { Banner, LabeledInput, Panel, PrimaryButton, SectionHeading } from '@/ui/primitives';

// The host's screen.
//
// It used to be one page: server controls, an account table, and a game table,
// stacked. That worked when there were three things on it. There are six now —
// the overview, players, games, tournaments, engines, and the server itself —
// and a single column of them is a page nobody can find anything on, where the
// panel you want is four screens down and the one above it is a delete button.
//
// So it is tabbed, and two decisions about that are worth stating:
//
//   - **The tab is in the URL** (`/admin?tab=bots`). It costs nothing and it
//     means a host can bookmark the engines, and that a link in a message can
//     point at the tab being talked about. A tab held only in state cannot do
//     either.
//   - **Only the current tab is mounted.** Each panel fetches on mount, and
//     several of them are reading live server state. Mounting all six would
//     fire six requests on every visit to look at one of them — and worse, the
//     five you are not looking at would go stale while showing numbers.
//
// Everything on every tab is behind the same credential, which is either an
// administrator's own session or the shared host token. See `useAdminToken`.

/** The tabs, in the order a host wants them. */
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'players', label: 'Players' },
  // Beside the players rather than under the server, because acting on a report
  // means opening an account and the two tabs are used together.
  { id: 'reports', label: 'Reports' },
  { id: 'games', label: 'Games' },
  { id: 'tournaments', label: 'Tournaments' },
  { id: 'weekend', label: 'Weekend' },
  { id: 'bots', label: 'Engines' },
  { id: 'server', label: 'Server' },
] as const;

export type AdminTab = (typeof TABS)[number]['id'];

/** Whether a string off the URL is a tab. */
const isTab = (value: string | undefined): value is AdminTab =>
  TABS.some((tab) => tab.id === value);

export interface AdminScreenProps {
  /** The tab from the URL, if it named one. */
  tab?: string;
}

export default function AdminScreen({ tab }: AdminScreenProps) {
  const admin = useAdminToken();
  const router = useRouter();
  // Unknown or absent falls back to the overview rather than to nothing, so a
  // hand-typed or stale `?tab=` lands on a page rather than a blank.
  const current: AdminTab = isTab(tab) ? tab : 'overview';

  if (!admin.unlocked) {
    return <AdminUnlock admin={admin} />;
  }

  return (
    <ScreenShell width={contentWidth.wide}>
      <View style={styles.tabBar}>
        <TabBar
          accessibilityLabel="Host controls"
          // `replace`, so six tab presses do not leave six entries in the back
          // stack between the host and the page they came from.
          onChange={(next) => router.replace(links.admin(next))}
          options={TABS.map((entry) => ({ value: entry.id, label: entry.label }))}
          value={current}
        />
      </View>

      {current === 'overview' ? <AnalyticsPanel admin={admin} /> : null}
      {current === 'players' ? <AccountsPanel admin={admin} /> : null}
      {current === 'reports' ? <ReportsPanel admin={admin} /> : null}
      {current === 'games' ? <GamesPanel admin={admin} /> : null}
      {current === 'tournaments' ? <TournamentAdminPanel admin={admin} /> : null}
      {current === 'weekend' ? <WeekendAdminPanel admin={admin} /> : null}
      {/*
        Two panels on one tab, which is the exception to the rule above. They are
        the same subject read at two timescales — what the engines are doing now,
        and when they are scheduled to stand down — and a host looking at one
        wants the other in the same glance. Both fetch on mount; that is two
        requests for a tab nobody opens by accident.
      */}
      {current === 'bots' ? (
        <>
          <BotControlPanel admin={admin} />
          <BotBenchPanel admin={admin} />
        </>
      ) : null}
      {current === 'server' ? <ServerControlsPanel admin={admin} /> : null}
    </ScreenShell>
  );
}

/**
 * The other door.
 *
 * An administrator never sees this: their session is accepted on every admin
 * route and `account.isAdmin` says so before any request is made. This is for a
 * host running the server without an account — or with one they have locked
 * themselves out of.
 */
function AdminUnlock({ admin }: { admin: ReturnType<typeof useAdminToken> }) {
  // Its own component rather than a branch inside AdminScreen, which is what
  // lets that one return early without declaring any state: a hook after a
  // conditional return is the one rule of hooks.
  const [draft, setDraft] = useState('');
  return (
    <ScreenShell width={contentWidth.reading}>
      <Panel style={adminStyles.panel}>
        <SectionHeading eyebrow="PRIVATE" title="Host controls" />
        <Text style={styles.help}>
          Sign in as an administrator or enter the server admin token.
        </Text>
        {admin.error ? <Banner message={admin.error} tone="error" /> : null}
        <LabeledInput
          autoCapitalize="none"
          autoCorrect={false}
          label="ADMIN TOKEN"
          onChangeText={setDraft}
          secureTextEntry
          value={draft}
        />
        <PrimaryButton
          disabled={admin.verifying || !draft.trim()}
          label="UNLOCK COMMANDS"
          onPress={() => admin.unlock(draft).then((ok) => ok && setDraft(''))}
        />
      </Panel>
    </ScreenShell>
  );
}

const styles = themedSheet(() => ({
  tabBar: { paddingBottom: space.tight },

  help: { ...type.body, color: colors.textFaint, marginBottom: space.small },
}));
