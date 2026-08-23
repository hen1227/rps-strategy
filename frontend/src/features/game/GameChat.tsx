import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, players, radius } from '@/theme';
import type { GameStatus } from '@/types/game';
import type { ChatMessage } from '@/types/protocol';

const senderLabel = (message: ChatMessage, accountId: string) => {
  const name = message.senderName?.trim() || 'Guest';
  return message.senderUserId === accountId ? `${name} (you)` : name;
};

export interface GameChatProps {
  accountId: string;
  chatVisible: boolean;
  /** Whether the socket can still carry a message. */
  connected: boolean;
  gameStatus: GameStatus;
  isSpectating: boolean;
  messages: ChatMessage[];
  /** Returns false when the message could not be sent, so the draft is kept. */
  onSend: (text: string) => boolean;
  onToggleChat: () => void;
  onToggleSpectatorMessages: () => void;
  /**
   * Whether this room spans a bot series rather than a single game. Worth
   * saying: the conversation carries across the run's boards, so a message
   * sent from the game that just finished still reaches the one now being
   * played, and the header would otherwise read as a room about to close.
   */
  series?: boolean;
  showSpectatorMessages: boolean;
  spectatorCount: number;
  /** Laid out beside the board rather than under it. */
  wide?: boolean;
}

export default function GameChat({
  accountId,
  chatVisible,
  connected,
  gameStatus,
  isSpectating,
  messages,
  onSend,
  onToggleChat,
  onToggleSpectatorMessages,
  series,
  showSpectatorMessages,
  spectatorCount,
  wide,
}: GameChatProps) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<ScrollView | null>(null);
  const visibleMessages = useMemo(
    () =>
      isSpectating || showSpectatorMessages
        ? messages
        : messages.filter((message) => message.senderRole !== 'spectator'),
    [isSpectating, messages, showSpectatorMessages],
  );
  const hiddenCount = messages.length - visibleMessages.length;
  // The room outlives the result, so the composer stays open after the game
  // ends and closes only when the server stops accepting messages.
  const isFinished = gameStatus === 'Finished';
  const title = series ? 'SERIES CHAT' : 'GAME CHAT';
  // A finished board in a series is not a finished conversation: the run is
  // still going and this room is where it is being talked about.
  const finishedLabel = series ? 'Between games' : 'Game over';
  const canSend = connected && draft.trim().length > 0;
  const spectatorLabel =
    spectatorCount === 1 ? '1 spectator' : `${spectatorCount} spectators`;

  useEffect(() => {
    if (!chatVisible) return;
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [chatVisible, visibleMessages.length]);

  const send = () => {
    const text = draft.trim();
    if (!text || !onSend(text)) return;
    setDraft('');
  };

  if (!chatVisible) {
    return (
      <View style={styles.closedCard}>
        <View>
          <Text style={styles.eyebrow}>{title}</Text>
          <Text style={styles.closedCopy}>
            Chat hidden · {isFinished ? finishedLabel.toLowerCase() : spectatorLabel}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Show game chat"
          accessibilityRole="button"
          onPress={onToggleChat}
          style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
        >
          <Text style={styles.headerButtonText}>SHOW</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.chatCard, wide ? styles.chatCardWide : styles.chatCardCompact]}>
      <View style={styles.header}>
        <View style={styles.headerIdentity}>
          <View style={[styles.statusDot, connected && styles.statusDotConnected]} />
          <View>
            <Text style={styles.eyebrow}>{title}</Text>
            <Text style={styles.messageCount}>
              {isFinished ? finishedLabel : spectatorLabel} ·{' '}
              {messages.length === 1 ? '1 message' : `${messages.length} messages`}
            </Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          {!isSpectating && (
            <Pressable
              accessibilityLabel={`${showSpectatorMessages ? 'Hide' : 'Show'} spectator messages`}
              accessibilityRole="switch"
              accessibilityState={{ checked: showSpectatorMessages }}
              onPress={onToggleSpectatorMessages}
              style={({ pressed }) => [
                styles.spectatorToggle,
                showSpectatorMessages && styles.spectatorToggleOn,
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.spectatorToggleText,
                  showSpectatorMessages && styles.spectatorToggleTextOn,
                ]}
              >
                SPECTATORS {showSpectatorMessages ? 'ON' : 'OFF'}
              </Text>
            </Pressable>
          )}
          <Pressable
            accessibilityLabel="Hide game chat"
            accessibilityRole="button"
            onPress={onToggleChat}
            style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
          >
            <Text style={styles.headerButtonText}>HIDE</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.messageList}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
      >
        {visibleMessages.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No messages yet</Text>
            <Text style={styles.emptyCopy}>
              {isFinished
                ? 'The room stays open until everyone leaves.'
                : 'Say hello to everyone watching the game.'}
            </Text>
          </View>
        ) : (
          visibleMessages.map((message) => (
            <View key={message.id} style={styles.messageRow}>
              <View style={styles.messageMeta}>
                <Text style={styles.senderName} numberOfLines={1}>
                  {senderLabel(message, accountId)}
                </Text>
                <View
                  style={[
                    styles.roleBadge,
                    message.senderRole === 'spectator'
                      ? styles.spectatorBadge
                      : message.senderColor === 'Red'
                        ? styles.redBadge
                        : styles.blueBadge,
                  ]}
                >
                  <Text style={styles.roleText}>
                    {message.senderRole === 'spectator' ? 'SPECTATOR' : message.senderColor}
                  </Text>
                </View>
              </View>
              <Text style={styles.messageText}>{message.text}</Text>
            </View>
          ))
        )}
        {hiddenCount > 0 && (
          <Text style={styles.hiddenNotice}>
            {hiddenCount} spectator {hiddenCount === 1 ? 'message' : 'messages'} hidden
          </Text>
        )}
      </ScrollView>

      <View style={styles.composer}>
        <TextInput
          accessibilityLabel="Game chat message"
          blurOnSubmit
          editable={connected}
          enterKeyHint="send"
          maxLength={300}
          multiline
          onChangeText={setDraft}
          onSubmitEditing={send}
          placeholder={
            isFinished ? 'Message everyone still here…' : 'Message players and spectators…'
          }
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.accent}
          style={styles.input}
          submitBehavior="submit"
          value={draft}
        />
        <Pressable
          accessibilityLabel="Send chat message"
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          onPress={send}
          style={({ pressed }) => [
            styles.sendButton,
            !canSend && styles.sendButtonDisabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.sendText}>SEND</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chatCard: {
    width: '100%',
    overflow: 'hidden',
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceWell,
  },
  chatCardWide: { flex: 1, minHeight: 190 },
  chatCardCompact: { height: 180 },
  closedCard: {
    width: '100%',
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  header: {
    minHeight: 43,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 7,
    paddingHorizontal: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerIdentity: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.textFaint },
  statusDotConnected: { backgroundColor: colors.accent },
  eyebrow: { color: colors.textSoft, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  messageCount: { color: colors.textFaint, fontSize: 7, marginTop: 1 },
  closedCopy: { color: colors.textFaint, fontSize: 8, marginTop: 2 },
  headerButton: {
    paddingHorizontal: 7,
    paddingVertical: 6,
    borderRadius: radius.small,
    backgroundColor: colors.surfaceMuted,
  },
  headerButtonText: {
    color: colors.textMuted,
    fontSize: 7,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  spectatorToggle: {
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: radius.small,
    backgroundColor: colors.surfaceRaised,
  },
  spectatorToggleOn: { backgroundColor: colors.accentSurfaceRaised },
  spectatorToggleText: {
    color: colors.textFaint,
    fontSize: 6,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  spectatorToggleTextOn: { color: colors.accentSoft },
  messageList: { flexGrow: 1, paddingHorizontal: 10, paddingVertical: 8 },
  messageRow: { marginBottom: 8 },
  messageMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  senderName: { maxWidth: '72%', color: colors.textSoft, fontSize: 9, fontWeight: '900' },
  roleBadge: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  spectatorBadge: { backgroundColor: colors.surfaceMuted },
  redBadge: { backgroundColor: players.Red.surface },
  blueBadge: { backgroundColor: players.Blue.surface },
  roleText: { color: colors.textSubtle, fontSize: 5, fontWeight: '900', letterSpacing: 0.5 },
  messageText: { color: colors.textMuted, fontSize: 10, lineHeight: 14, marginTop: 3 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  emptyTitle: { color: colors.textMuted, fontSize: 10, fontWeight: '800' },
  emptyCopy: { color: colors.textFaint, fontSize: 8, marginTop: 3, textAlign: 'center' },
  hiddenNotice: { color: colors.textFaint, fontSize: 7, fontWeight: '700', textAlign: 'center' },
  composer: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 7,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    maxHeight: 58,
    minHeight: 32,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSunken,
    color: colors.text,
    fontSize: 10,
  },
  sendButton: {
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: radius.small,
    backgroundColor: colors.accent,
  },
  sendButtonDisabled: { opacity: 0.34 },
  sendText: { color: colors.textStrong, fontSize: 7, fontWeight: '900', letterSpacing: 0.7 },
  pressed: { opacity: 0.7 },
});
