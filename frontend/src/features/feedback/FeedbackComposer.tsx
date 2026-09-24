import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { appVersion, platformName } from './clientInfo';
import { getFeedback, type NewFeedbackItem } from '@/store/api/feedback';
import { colors, radius, space, themedSheet, type } from '@/theme';
import { Banner, GhostButton, LabeledInput, OptionChips, Panel, PrimaryButton, SectionHeading } from '@/ui/primitives';
import type { FeedbackItem, FeedbackKind, FeedbackPolicy } from '@/types/protocol';

// The form.
//
// # The part that matters: the check before you post
//
// Most of what arrives on a board like this is already on it. A second copy of
// a bug splits its votes, splits its thread, and makes the host answer the same
// question twice — so as soon as there is something to search for, this looks.
// Not as a blocker: somebody who has read the three matches and still thinks
// theirs is different is very often right, and a form that refuses to submit
// until you prove otherwise is a form people stop using.
//
// The search runs against the same route the board is drawn from, so a match
// shown here is an item that exists, on the board, with a thread on it.
//
// # What the client fills in for you
//
// The build and the platform, always, and the game id when the composer was
// opened from a finished game. All three are the difference between a report
// somebody can act on and one that needs a conversation first — see
// `clientInfo.ts`.

/** How long a pause in typing counts as "finished typing", for the search. */
const SEARCH_DEBOUNCE_MS = 400;
/** How many possible duplicates are worth showing. Three is a glance. */
const MATCH_LIMIT = 3;

export interface FeedbackComposerProps {
  policy: FeedbackPolicy | null;
  /** Preset by the address: the finished-game card opens this on `bug`. */
  initialKind: FeedbackKind;
  /** The game it happened in, when the composer was opened from a board. */
  gameId?: string;
  onSubmit: (item: NewFeedbackItem) => Promise<FeedbackItem | null>;
  onCancel: () => void;
  onOpenItem: (itemId: string) => void;
}

export default function FeedbackComposer({
  policy,
  initialKind,
  gameId,
  onSubmit,
  onCancel,
  onOpenItem,
}: FeedbackComposerProps) {
  const [kind, setKind] = useState<FeedbackKind>(initialKind);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [sending, setSending] = useState(false);
  const [matches, setMatches] = useState<FeedbackItem[]>([]);

  const maxTitle = policy?.maxTitle ?? 120;
  const maxBody = policy?.maxBody ?? 4000;
  const trimmedTitle = title.trim();

  // Look for what this might be a copy of, once there is enough to look for.
  // Four characters is roughly where a search stops matching half the board.
  useEffect(() => {
    if (trimmedTitle.length < 4) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      getFeedback({ search: trimmedTitle, limit: MATCH_LIMIT })
        .then((page) => {
          if (!cancelled) setMatches(page.items);
        })
        .catch(() => {
          // Silent, and deliberately: this is a courtesy on the way to
          // posting. A board that will not let you report a bug because the
          // duplicate check failed is worse than a duplicate.
          if (!cancelled) setMatches([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmedTitle]);

  // A bug needs details and a suggestion can stand on its title — the same rule
  // the server enforces, stated here so the button says so before the round
  // trip rather than after it.
  const needsBody = kind === 'bug';
  const canSend =
    !sending &&
    Boolean(policy?.mayPost) &&
    trimmedTitle.length > 0 &&
    (!needsBody || body.trim().length > 0);

  const send = async () => {
    setSending(true);
    const created = await onSubmit({
      kind,
      title: trimmedTitle,
      body: body.trim(),
      linkUrl: linkUrl.trim(),
      gameId,
      appVersion: appVersion(),
      platform: platformName(),
    });
    setSending(false);
    if (created) {
      setTitle('');
      setBody('');
      setLinkUrl('');
      onOpenItem(created.itemId);
    }
  };

  return (
    <Panel tone="accent">
      <View style={styles.form}>
        <SectionHeading
          eyebrow="NEW"
          title={kind === 'bug' ? 'Report a bug' : 'Suggest something'}
          trailing={<GhostButton compact label="CANCEL" onPress={onCancel} />}
        />

        {policy && !policy.mayPost ? (
          <Banner message={policy.postRefusal} tone="notice" />
        ) : null}

        <OptionChips
          label="WHAT IS IT"
          onChange={setKind}
          options={
            policy?.kinds.map((entry) => ({ value: entry.id, label: entry.label })) ?? [
              { value: 'bug' as FeedbackKind, label: 'Bug' },
              { value: 'suggestion' as FeedbackKind, label: 'Suggestion' },
            ]
          }
          value={kind}
        />

        <LabeledInput
          hint={
            kind === 'bug'
              ? 'One line: what went wrong.'
              : 'One line: what you would like.'
          }
          label="TITLE"
          maxLength={maxTitle}
          onChangeText={setTitle}
          placeholder={
            kind === 'bug'
              ? 'The clock keeps running after a resign'
              : 'Add a rematch button after a bot game'
          }
          value={title}
        />

        {matches.length > 0 ? (
          <View style={styles.matches}>
            <Text style={styles.matchesLabel}>ALREADY ON THE BOARD?</Text>
            {matches.map((match) => (
              <Pressable
                accessibilityHint="Opens that thread instead"
                accessibilityRole="button"
                key={match.itemId}
                onPress={() => onOpenItem(match.itemId)}
                style={({ pressed }) => [styles.match, pressed && styles.pressed]}
              >
                <Text numberOfLines={1} style={styles.matchTitle}>
                  {match.title}
                </Text>
                <Text style={styles.matchMeta}>
                  {match.votes} {match.votes === 1 ? 'vote' : 'votes'}
                  {match.statusLabel === 'Open' ? '' : ` · ${match.statusLabel}`}
                </Text>
              </Pressable>
            ))}
            <Text style={styles.matchesHint}>
              Already reported? Vote for the existing post.
            </Text>
          </View>
        ) : null}

        <LabeledInput
          hint={
            kind === 'bug'
              ? "For bugs, include steps, what happened, and what you expected."
              : 'Optional. Why it would help.'
          }
          label="DETAILS"
          maxLength={maxBody}
          multiline
          numberOfLines={6}
          onChangeText={setBody}
          placeholder={
            kind === 'bug'
              ? 'Resigned on move 4 in Total War. The board went to the result card but my clock kept counting down.'
              : ''
          }
          style={styles.bodyInput}
          value={body}
        />

        <LabeledInput
          autoCapitalize="none"
          hint="Optional. A screenshot, a video, or a thread about it."
          label="LINK"
          keyboardType="url"
          onChangeText={setLinkUrl}
          placeholder="https://"
          value={linkUrl}
        />

        {gameId ? (
          <Text style={styles.attached}>
            Your last game is attached for review.
          </Text>
        ) : null}

        {/*
          No `fullWidth`: that prop is `flexGrow: 1`, which is what makes a
          button fill a *row* of actions. This one is in a column, where it
          already stretches — and where flexGrow makes it grow downwards until
          it fills the form.
        */}
        <PrimaryButton
          disabled={!canSend}
          label={kind === 'bug' ? 'Post this bug' : 'Post this suggestion'}
          loading={sending}
          onPress={send}
        />
        <Text style={styles.footnote}>
          Posts are public and carry your name. {policy?.contactName
            ? `For anything private, message ${policy.contactName}.`
            : ''}
        </Text>
      </View>
    </Panel>
  );
}

const styles = themedSheet(() => ({
  form: { gap: space.medium },
  // Tall enough to hold a repro without scrolling a six-line field.
  bodyInput: { minHeight: 108, textAlignVertical: 'top' },
  matches: {
    gap: space.snug,
    padding: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.goldBorder,
    backgroundColor: colors.goldSurfaceDeep,
  },
  matchesLabel: { ...type.eyebrow, color: colors.goldBright },
  matchesHint: { ...type.meta, color: colors.textMuted },
  match: {
    paddingVertical: space.tight,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  pressed: { opacity: 0.7 },
  matchTitle: { ...type.rowTitle, color: colors.text },
  matchMeta: { ...type.meta, color: colors.textFaint },
  attached: { ...type.meta, color: colors.textMuted },
  footnote: { ...type.meta, color: colors.textFaint },
}));
