import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, themedSheet, type } from '@/theme';
import ModalCard from '@/ui/ModalCard';
import { Banner } from '@/ui/primitives';
import type { ChatMessage } from '@/types/protocol';

import ReportDialog, { contextFrom } from './ReportDialog';
import { useBlocking } from './useBlocking';

// What you can do about a message somebody else sent.
//
// A sheet rather than two buttons on every line. A chat room is mostly people
// saying "gg", and hanging a report control off each of those turns an ordinary
// conversation into a page of accusations waiting to be made. The affordance is
// one small mark on the row; the decision lives here.
//
// The room's recent lines travel with a report from this sheet — see
// `contextFrom` — because chat is never written to the database and would
// otherwise be gone by the time the host reads the report.

export interface ChatMessageActionsProps {
  visible: boolean;
  onClose: () => void;
  /** The message the sheet was opened from. Its sender is the subject. */
  message: ChatMessage;
  /** The room as the reporter has it, for the evidence a report carries. */
  roomMessages: ChatMessage[];
}

export default function ChatMessageActions({
  visible,
  onClose,
  message,
  roomMessages,
}: ChatMessageActionsProps) {
  const [reporting, setReporting] = useState(false);
  const blocking = useBlocking();

  const name = message.senderName?.trim() || 'this player';
  const blocked = blocking.isBlocked(message.senderUserId);

  const toggleBlock = async () => {
    const done = blocked
      ? await blocking.unblock(message.senderUserId)
      : await blocking.block({ userId: message.senderUserId, username: message.senderName });
    if (done) onClose();
  };

  if (reporting) {
    return (
      <ReportDialog
        context={contextFrom(roomMessages, message)}
        gameId={message.gameId}
        onClose={() => {
          setReporting(false);
          onClose();
        }}
        targetName={name}
        targetUserId={message.senderUserId}
        visible={visible}
      />
    );
  }

  return (
    <ModalCard
      eyebrow="THIS PLAYER"
      maxWidth={380}
      onClose={onClose}
      subtitle={message.text}
      title={name}
      visible={visible}
    >
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel={`Report ${name}`}
          accessibilityRole="button"
          onPress={() => setReporting(true)}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text style={styles.actionLabel}>Report to the host</Text>
          <Text style={styles.actionCopy}>
            Send this conversation to the host for review within 24 hours.
          </Text>
        </Pressable>

        <Pressable
          accessibilityLabel={blocked ? `Unblock ${name}` : `Block ${name}`}
          accessibilityRole="button"
          disabled={blocking.busy || !blocking.canBlock}
          onPress={toggleBlock}
          style={({ pressed }) => [
            styles.action,
            !blocking.canBlock && styles.actionDisabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.actionLabel}>{blocked ? 'Unblock' : 'Block'}</Text>
          <Text style={styles.actionCopy}>
            {!blocking.canBlock
              ? "Sign in to block players."
              : blocked
                ? 'You will start seeing their messages again, and either of you can challenge the other.'
                : 'Their messages stop reaching you, yours stop reaching them, and neither of you can challenge the other. Matchmaking can still pair you.'}
          </Text>
        </Pressable>
      </View>

      <Banner message={blocking.error} onDismiss={blocking.clearError} tone="error" />
    </ModalCard>
  );
}

const styles = themedSheet(() => ({
  actions: { gap: space.small, marginTop: space.medium },
  action: {
    padding: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSunken,
  },
  actionDisabled: { opacity: 0.6 },
  actionLabel: { ...type.rowTitle, color: colors.textStrong },
  actionCopy: { ...type.meta, color: colors.textMuted, marginTop: space.tight },
  pressed: { opacity: 0.7 },
}));
