import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import AccountsPanel from './AccountsPanel';
import AnalyticsPanel from './AnalyticsPanel';
import BotControlPanel from './BotControlPanel';
import GamesPanel from './GamesPanel';
import ServerControlsPanel from './ServerControlsPanel';
import TournamentAdminPanel from './TournamentAdminPanel';
import { adminStyles } from './adminStyles';
import { useAdminToken } from '@/hooks/useAdminToken';
import { links } from '@/navigation/links';
import { colors, contentWidth, radius, space, type } from '@/theme';
import ScreenShell from '@/ui/ScreenShell';
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
  { id: 'games', label: 'Games' },
  { id: 'tournaments', label: 'Tournaments' },
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
        {TABS.map((entry) => {
          const selected = entry.id === current;
          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              key={entry.id}
              // `replace`, so six tab presses do not leave six entries in the
              // back stack between the host and the page they came from.
              onPress={() => router.replace(links.admin(entry.id))}
              style={({ pressed }) => [
                styles.tab,
                selected && styles.tabSelected,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.tabLabel, selected && styles.tabLabelSelected]}>
                {entry.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {current === 'overview' ? <AnalyticsPanel admin={admin} /> : null}
      {current === 'players' ? <AccountsPanel admin={admin} /> : null}
      {current === 'games' ? <GamesPanel admin={admin} /> : null}
      {current === 'tournaments' ? <TournamentAdminPanel admin={admin} /> : null}
      {current === 'bots' ? <BotControlPanel admin={admin} /> : null}
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
          Sign in with an administrator account and these tools open by themselves. This form
          is the other door, for a host running the server without one.
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

const styles = StyleSheet.create({
  tabBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.snug,
    paddingBottom: space.tight,
  },
  tab: {
    paddingHorizontal: space.medium,
    paddingVertical: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
  },
  tabSelected: {
    borderColor: colors.goldBorder,
    backgroundColor: colors.goldSurfaceDeep,
  },
  tabLabel: { ...type.label, color: colors.textMuted },
  tabLabelSelected: { color: colors.goldBright },
  pressed: { opacity: 0.7 },

  help: { ...type.body, color: colors.textFaint, marginBottom: space.small },
});
