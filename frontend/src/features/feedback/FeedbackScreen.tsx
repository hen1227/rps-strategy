import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import FeedbackCard from './FeedbackCard';
import FeedbackComposer from './FeedbackComposer';
import FeedbackThread from './FeedbackThread';
import { useFeedbackBoard, type BoardQuery } from './useFeedbackBoard';
import { useNow } from '@/hooks/useNow';
import { links } from '@/navigation/links';
import { useGameStore } from '@/store/gameStore';
import { colors, contentWidth, space, themedSheet, type } from '@/theme';
import ScreenShell from '@/ui/ScreenShell';
import PageHeading from '@/ui/PageHeading';
import TabBar from '@/ui/TabBar';
import {
  Banner,
  EmptyState,
  LabeledInput,
  OptionChips,
  Panel,
  PrimaryButton,
} from '@/ui/primitives';
import type { FeedbackKind, FeedbackSort, FeedbackStatus } from '@/types/protocol';

// The feedback board.
//
// One page in three states, chosen by the address rather than by internal
// state: the list, one thread (`?item=`), and the form (`?compose=`). That is
// what makes all three linkable — a bug thread pasted into Discord, and a
// "report a bug" link on the finished-game card that opens the form already
// set to a bug with the game attached.
//
// # Why the filters are not in the address
//
// The address names *what you are looking at*, and a filter is how you found
// it. Keeping "bugs, sorted by newest, matching 'clock'" in the URL would mean
// every chip press is a history entry between somebody and the page they came
// from, for a state nobody links to. The three things worth linking to are
// above; the rest is a chip.

/** The one tab row: everything, or one kind of thing. */
type KindTab = 'all' | FeedbackKind;

const SORTS: readonly { value: FeedbackSort; label: string }[] = [
  { value: 'top', label: 'Most wanted' },
  { value: 'new', label: 'Newest' },
];

export interface FeedbackScreenProps {
  /** The thread to open, from `?item=`. */
  item?: string;
  /** Open the form on this kind, from `?compose=`. */
  compose?: string;
  /** The game a report is about, from `?gameId=`. */
  gameId?: string;
}

export default function FeedbackScreen({ item, compose, gameId }: FeedbackScreenProps) {
  const router = useRouter();
  const now = useNow();
  const account = useGameStore((state) => state.account);

  const [tab, setTab] = useState<KindTab>('all');
  const [status, setStatus] = useState<FeedbackStatus | 'any'>('any');
  const [sort, setSort] = useState<FeedbackSort>('top');
  const [search, setSearch] = useState('');

  const query: BoardQuery = useMemo(
    () => ({
      kind: tab === 'all' ? undefined : tab,
      status: status === 'any' ? undefined : status,
      search: search.trim() || undefined,
      sort,
    }),
    [tab, status, search, sort],
  );

  const openItemId = item ?? '';
  const board = useFeedbackBoard(query, openItemId);
  const { page, policy } = board;

  // `?compose=` names a kind; anything else opens the form on a bug, which is
  // what somebody arriving from a broken game almost always means.
  const composing = Boolean(compose);
  const composeKind: FeedbackKind = compose === 'suggestion' ? 'suggestion' : 'bug';

  const openBoard = () => router.replace(links.feedback());
  const openItem = (itemId: string) => router.replace(links.feedback({ item: itemId }));
  const openComposer = (kind: FeedbackKind) =>
    router.replace(links.feedback({ compose: kind, gameId }));

  const statusOptions = useMemo(
    () => [
      { value: 'any' as const, label: 'Everything' },
      ...(policy?.statuses ?? []).map((entry) => ({
        value: entry.id,
        // The tab decides the wording: on the Bugs tab `accepted` reads "Known
        // issue", on Suggestions it reads "Planned". With both kinds on screen
        // there is no right single word, so the bug's is used — it is the
        // majority of what a filter like this is reached for.
        label: tab === 'suggestion' ? entry.suggestionLabel : entry.bugLabel,
      })),
    ],
    [policy, tab],
  );

  /* ------------------------------------------------------------ one thread -- */

  if (openItemId) {
    return (
      <ScreenShell width={contentWidth.reading}>
        <Banner message={board.error} onDismiss={() => board.setError(null)} tone="error" />
        {board.item ? (
          <FeedbackThread
            account={account}
            item={board.item}
            now={now}
            onAnswer={(answer) => board.answer(board.item?.itemId ?? '', answer)}
            onBack={openBoard}
            onDelete={async () => {
              const removed = await board.removeItem(board.item?.itemId ?? '');
              if (removed) openBoard();
              return removed;
            }}
            onDeleteComment={(commentId) =>
              board.removeComment(board.item?.itemId ?? '', commentId)
            }
            onHideComment={(commentId, hidden) =>
              board.hideComment(board.item?.itemId ?? '', commentId, hidden)
            }
            onOpenItem={openItem}
            onReply={(body) => board.reply(board.item?.itemId ?? '', body)}
            onVote={(voted) => void board.vote(board.item?.itemId ?? '', voted)}
            policy={policy}
          />
        ) : board.loadingItem ? (
          <ActivityIndicator color={colors.accent} />
        ) : (
          <Panel>
            <EmptyState
              detail="It may have been removed, or the link may be wrong."
              title="That item is not on the board"
            />
            <PrimaryButton label="Back to the board" onPress={openBoard} tone="quiet" />
          </Panel>
        )}
      </ScreenShell>
    );
  }

  /* -------------------------------------------------------------- the board -- */

  return (
    <ScreenShell width={contentWidth.standard}>
      <PageHeading
        detail="Report bugs, suggest changes, and vote for what matters to you."
        eyebrow="FEEDBACK"
        title="Bugs & suggestions"
      />

      <Banner message={board.error} onDismiss={() => board.setError(null)} tone="error" />

      {composing ? (
        <FeedbackComposer
          gameId={gameId}
          initialKind={composeKind}
          onCancel={openBoard}
          onOpenItem={openItem}
          onSubmit={board.post}
          policy={policy}
        />
      ) : (
        <View style={styles.callToAction}>
          <PrimaryButton
            label="Report a bug"
            onPress={() => openComposer('bug')}
            tone="accent"
          />
          <PrimaryButton
            label="Suggest something"
            onPress={() => openComposer('suggestion')}
            tone="quiet"
          />
        </View>
      )}

      <TabBar
        accessibilityLabel="What to show"
        fill
        onChange={setTab}
        options={[
          { value: 'all' as KindTab, label: 'Everything' },
          {
            value: 'bug' as KindTab,
            label: 'Bugs',
            eyebrow: page ? `${page.openBugs} OPEN` : undefined,
          },
          {
            value: 'suggestion' as KindTab,
            label: 'Suggestions',
            eyebrow: page ? `${page.openSuggestions} OPEN` : undefined,
          },
        ]}
        value={tab}
      />

      <Panel>
        <View style={styles.filters}>
          <OptionChips
            label="SORT"
            onChange={setSort}
            options={SORTS}
            value={sort}
          />
          <OptionChips
            label="STATUS"
            onChange={setStatus}
            options={statusOptions}
            value={status}
          />
          <LabeledInput
            autoCapitalize="none"
            label="SEARCH"
            onChangeText={setSearch}
            placeholder="clock, rematch, Discord…"
            value={search}
          />
        </View>
      </Panel>

      {board.loading && !page ? (
        <ActivityIndicator color={colors.accent} />
      ) : page && page.items.length > 0 ? (
        <View style={styles.list}>
          {page.items.map((entry) => (
            <FeedbackCard
              item={entry}
              key={entry.itemId}
              now={now}
              onOpen={() => openItem(entry.itemId)}
              onVote={
                policy?.mayPost ? () => void board.vote(entry.itemId, !entry.youVoted) : null
              }
              voteRefusal={policy?.postRefusal}
            />
          ))}
          {page.total > page.items.length ? (
            <Text style={styles.more}>
              Showing {page.items.length} of {page.total}. Narrow it with the search above.
            </Text>
          ) : null}
        </View>
      ) : (
        <Panel>
          <EmptyState
            detail={
              search.trim()
                ? 'Nothing here matches that. Try fewer words, or post it.'
                : 'Nothing has been posted under this filter yet.'
            }
            title="Nothing to show"
          />
        </Panel>
      )}

      {policy?.contactName ? (
        <Text style={styles.footnote}>
          Posts are public. Report players from their profile. For private account help, message{' '}
          {policy.contactName}.
        </Text>
      ) : null}
    </ScreenShell>
  );
}

const styles = themedSheet(() => ({
  callToAction: { flexDirection: 'row', flexWrap: 'wrap', gap: space.small },
  filters: { gap: space.medium },
  list: { gap: space.small },
  more: { ...type.meta, color: colors.textFaint, paddingTop: space.tight },
  footnote: { ...type.meta, color: colors.textFaint },
}));
