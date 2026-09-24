import { useState } from 'react';
import { Linking, Text, View } from 'react-native';

import HostControls from './HostControls';
import VoteButton from './VoteButton';
import { timeAgo } from './relativeTime';
import { statusTone } from './statusTone';
import ConfirmButton from '@/features/admin/ConfirmButton';
import { feedbackItemURL, links } from '@/navigation/links';
import type { FeedbackAnswer } from '@/store/api/feedback';
import { colors, radius, space, themedSheet, type } from '@/theme';
import CopyLinkButton from '@/ui/CopyLinkButton';
import {
  Badge,
  GhostButton,
  GhostLink,
  LabeledInput,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';
import type { Account, FeedbackItem, FeedbackPolicy } from '@/types/protocol';

// One item, open: what was reported, what the host said, and the conversation.
//
// This is what an item's address leads to, and the reason items have addresses
// at all — a bug worth discussing is a bug somebody links to from Discord. So
// the share button is on the item rather than only on the board, and the page
// stands on its own for a reader arriving cold with no idea what the board is.

export interface FeedbackThreadProps {
  item: FeedbackItem;
  policy: FeedbackPolicy | null;
  account: Account | null;
  now: number | null;
  onBack: () => void;
  onOpenItem: (itemId: string) => void;
  onVote: (voted: boolean) => void;
  onReply: (body: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onDeleteComment: (commentId: string) => Promise<boolean>;
  onAnswer: (answer: FeedbackAnswer) => Promise<boolean>;
  onHideComment: (commentId: string, hidden: boolean) => Promise<boolean>;
}

export default function FeedbackThread({
  item,
  policy,
  account,
  now,
  onBack,
  onOpenItem,
  onVote,
  onReply,
  onDelete,
  onDeleteComment,
  onAnswer,
  onHideComment,
}: FeedbackThreadProps) {
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  // One key names whichever destructive button is armed, so pressing any other
  // disarms it. See `ConfirmButton`.
  const [armed, setArmed] = useState<string | null>(null);

  const isHost = Boolean(account?.isAdmin);
  const mine = Boolean(item.authorUserId) && item.authorUserId === account?.userId;
  const mayPost = Boolean(policy?.mayPost);
  const tone = statusTone(item.status);

  const send = async () => {
    const body = reply.trim();
    if (!body) return;
    setSending(true);
    const posted = await onReply(body);
    setSending(false);
    if (posted) setReply('');
  };

  return (
    <View style={styles.page}>
      {/*
        Wrapped, because the page stretches its children so the panels below
        fill the column — and a back button that fills the column is a target
        the width of the screen sitting where a link should be.
      */}
      <View style={styles.back}>
        <GhostButton compact label="‹ ALL FEEDBACK" onPress={onBack} />
      </View>

      <Panel>
        <View style={styles.item}>
          <View style={styles.badges}>
            <Badge
              label={item.kind === 'bug' ? 'BUG' : 'SUGGESTION'}
              tone={item.kind === 'bug' ? 'warm' : 'cool'}
            />
            {tone ? <Badge label={item.statusLabel.toUpperCase()} tone={tone} /> : null}
            {item.pinned ? <Badge label="PINNED" tone="gold" /> : null}
            {item.hidden ? <Badge label="HIDDEN" tone="neutral" /> : null}
          </View>

          <View style={styles.headline}>
            <VoteButton
              large
              onPress={mayPost ? () => onVote(!item.youVoted) : null}
              refusal={policy?.postRefusal}
              title={item.title}
              votes={item.votes}
              youVoted={item.youVoted}
            />
            <View style={styles.headlineCopy}>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={styles.meta}>
                {[
                  item.fromHost ? `${item.authorName} (host)` : item.authorName,
                  now === null ? null : timeAgo(item.createdAtUnixMs, now),
                  item.appVersion ? `v${item.appVersion}` : null,
                  item.platform,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
          </View>

          {item.body ? <Text style={styles.body}>{item.body}</Text> : null}

          {item.statusNote ? (
            <View style={styles.answer}>
              <Text style={styles.answerLabel}>{item.statusLabel.toUpperCase()}</Text>
              <Text style={styles.answerText}>{item.statusNote}</Text>
            </View>
          ) : null}

          <View style={styles.actions}>
            {/* The whole reason an item has an address. */}
            <CopyLinkButton
              accessibilityLabel={`Copy a link to ${item.title}`}
              url={feedbackItemURL(item.itemId)}
            />
            {item.linkUrl ? (
              <GhostButton
                accessibilityLabel={`Open the link on ${item.title}`}
                compact
                label="OPEN LINK ↗"
                onPress={() => void Linking.openURL(item.linkUrl ?? '')}
              />
            ) : null}
            {item.gameId ? (
              // The game it happened in, which is what makes a report
              // reproducible rather than a description of one.
              <GhostLink
                compact
                href={links.review(item.gameId)}
                label="THE GAME"
              />
            ) : null}
            {item.duplicateOf ? (
              <GhostButton
                compact
                label="SEE THE ORIGINAL"
                onPress={() => onOpenItem(item.duplicateOf ?? '')}
              />
            ) : null}
            {mine && !isHost ? (
              <ConfirmButton
                armed={armed === 'item'}
                busy={false}
                label="DELETE MINE"
                onArm={() => setArmed('item')}
                onConfirm={() => {
                  setArmed(null);
                  void onDelete();
                }}
                tone="quiet"
              />
            ) : null}
          </View>
        </View>
      </Panel>

      <Panel>
        <View style={styles.thread}>
          <SectionHeading
            title={
              item.comments === 0
                ? 'No replies yet'
                : `${item.comments} ${item.comments === 1 ? 'reply' : 'replies'}`
            }
          />

          {(item.thread ?? []).map((comment) => {
            const ownComment =
              Boolean(comment.authorUserId) && comment.authorUserId === account?.userId;
            return (
              <View
                key={comment.commentId}
                style={[styles.comment, comment.hidden && styles.commentHidden]}
              >
                <View style={styles.commentHead}>
                  <Text style={styles.commentAuthor}>{comment.authorName}</Text>
                  {comment.fromHost ? <Badge label="HOST" tone="accent" /> : null}
                  {comment.hidden ? <Badge label="HIDDEN" tone="neutral" /> : null}
                  <Text style={styles.commentTime}>
                    {now === null ? '' : timeAgo(comment.createdAtUnixMs, now)}
                  </Text>
                </View>
                <Text style={styles.commentBody}>{comment.body}</Text>
                {ownComment || isHost ? (
                  <View style={styles.commentActions}>
                    {isHost ? (
                      <GhostButton
                        compact
                        label={comment.hidden ? 'SHOW' : 'HIDE'}
                        onPress={() =>
                          void onHideComment(comment.commentId, !comment.hidden)
                        }
                      />
                    ) : null}
                    <ConfirmButton
                      armed={armed === comment.commentId}
                      busy={false}
                      label="DELETE"
                      onArm={() => setArmed(comment.commentId)}
                      onConfirm={() => {
                        setArmed(null);
                        void onDeleteComment(comment.commentId);
                      }}
                      tone="quiet"
                    />
                  </View>
                ) : null}
              </View>
            );
          })}

          {mayPost ? (
            <View style={styles.composer}>
              <LabeledInput
                label="REPLY"
                maxLength={policy?.maxComment ?? 2000}
                multiline
                onChangeText={setReply}
                placeholder={
                  item.kind === 'bug'
                    ? 'Seeing this too, on the web build.'
                    : 'What this would let me do…'
                }
                style={styles.replyInput}
                value={reply}
              />
              <PrimaryButton
                disabled={sending || reply.trim().length === 0}
                label="Post reply"
                loading={sending}
                onPress={send}
              />
            </View>
          ) : (
            <Text style={styles.refusal}>{policy?.postRefusal}</Text>
          )}
        </View>
      </Panel>

      {isHost ? (
        <HostControls item={item} onAnswer={onAnswer} onDelete={onDelete} policy={policy} />
      ) : null}
    </View>
  );
}

const styles = themedSheet(() => ({
  page: { gap: space.medium, alignItems: 'stretch' },
  back: { alignSelf: 'flex-start' },
  item: { gap: space.medium },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: space.tight },
  headline: { flexDirection: 'row', alignItems: 'flex-start', gap: space.medium },
  // `minWidth: 0` so a long title wraps rather than pushing the tally off the
  // panel — a flex child's default minimum is the width of its content.
  headlineCopy: { flex: 1, minWidth: 0, gap: space.tight },
  title: { ...type.sectionTitle, color: colors.textStrong },
  meta: { ...type.meta, color: colors.textFaint },
  body: { ...type.body, color: colors.text, fontSize: 12, lineHeight: 19 },
  answer: {
    gap: space.tight,
    padding: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurfaceQuiet,
  },
  answerLabel: { ...type.eyebrow, color: colors.accentText },
  answerText: { ...type.body, color: colors.accentTextStrong },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.small },
  thread: { gap: space.medium },
  comment: {
    gap: space.tight,
    paddingTop: space.small,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  commentHidden: { opacity: 0.55 },
  commentHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.small },
  commentAuthor: { ...type.rowTitle, color: colors.text },
  commentTime: { ...type.meta, color: colors.textFaint },
  commentBody: { ...type.body, color: colors.textSoft },
  commentActions: { flexDirection: 'row', gap: space.small, paddingTop: space.tight },
  composer: { gap: space.small },
  replyInput: { minHeight: 72, textAlignVertical: 'top' },
  refusal: { ...type.meta, color: colors.textMuted },
}));
