import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

const senderLabel = (message, accountId) => {
  const name = message.senderName?.trim() || 'Guest';
  return message.senderUserId === accountId ? `${name} (you)` : name;
};

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
  showSpectatorMessages,
  spectatorCount,
  wide,
}) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef(null);
  const visibleMessages = useMemo(
    () =>
      isSpectating || showSpectatorMessages
        ? messages
        : messages.filter((message) => message.senderRole !== 'spectator'),
    [isSpectating, messages, showSpectatorMessages],
  );
  const hiddenCount = messages.length - visibleMessages.length;
  const canSend = connected && gameStatus === 'InProgress' && draft.trim().length > 0;
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
          <Text style={styles.eyebrow}>GAME CHAT</Text>
          <Text style={styles.closedCopy}>Chat hidden · {spectatorLabel}</Text>
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
            <Text style={styles.eyebrow}>GAME CHAT</Text>
            <Text style={styles.messageCount}>
              {spectatorLabel} ·{' '}
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
            <Text style={styles.emptyCopy}>Say hello to everyone watching the game.</Text>
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
          editable={connected && gameStatus === 'InProgress'}
          enterKeyHint="send"
          maxLength={300}
          multiline
          onChangeText={setDraft}
          onSubmitEditing={send}
          placeholder={gameStatus === 'InProgress' ? 'Message players and spectators…' : 'Game chat has ended'}
          placeholderTextColor="#58636f"
          selectionColor="#72d4bf"
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
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#29313c',
    backgroundColor: '#141920',
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
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#29313c',
    backgroundColor: '#171b22',
  },
  header: {
    minHeight: 43,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 7,
    paddingHorizontal: 9,
    borderBottomWidth: 1,
    borderBottomColor: '#29313c',
    backgroundColor: '#191f27',
  },
  headerIdentity: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#596472' },
  statusDotConnected: { backgroundColor: '#72d4bf' },
  eyebrow: { color: '#cdd4da', fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  messageCount: { color: '#65707d', fontSize: 7, marginTop: 1 },
  closedCopy: { color: '#65707d', fontSize: 8, marginTop: 2 },
  headerButton: {
    paddingHorizontal: 7,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#29313b',
  },
  headerButtonText: { color: '#aab3bc', fontSize: 7, fontWeight: '900', letterSpacing: 0.7 },
  spectatorToggle: {
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#272b31',
  },
  spectatorToggleOn: { backgroundColor: '#213b36' },
  spectatorToggleText: { color: '#77818c', fontSize: 6, fontWeight: '900', letterSpacing: 0.4 },
  spectatorToggleTextOn: { color: '#8edbc9' },
  messageList: { flexGrow: 1, paddingHorizontal: 10, paddingVertical: 8 },
  messageRow: { marginBottom: 8 },
  messageMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  senderName: { maxWidth: '72%', color: '#dce2e7', fontSize: 9, fontWeight: '900' },
  roleBadge: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  spectatorBadge: { backgroundColor: '#3a3345' },
  redBadge: { backgroundColor: '#563238' },
  blueBadge: { backgroundColor: '#293f59' },
  roleText: { color: '#c5ccd3', fontSize: 5, fontWeight: '900', letterSpacing: 0.5 },
  messageText: { color: '#aeb7c0', fontSize: 10, lineHeight: 14, marginTop: 3 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  emptyTitle: { color: '#89939f', fontSize: 10, fontWeight: '800' },
  emptyCopy: { color: '#596472', fontSize: 8, marginTop: 3, textAlign: 'center' },
  hiddenNotice: { color: '#756985', fontSize: 7, fontWeight: '700', textAlign: 'center' },
  composer: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 7,
    borderTopWidth: 1,
    borderTopColor: '#29313c',
    backgroundColor: '#191f27',
  },
  input: {
    flex: 1,
    maxHeight: 58,
    minHeight: 32,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#343d48',
    backgroundColor: '#10141a',
    color: '#eef1f4',
    fontSize: 10,
  },
  sendButton: {
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: 7,
    backgroundColor: '#72d4bf',
  },
  sendButtonDisabled: { opacity: 0.34 },
  sendText: { color: '#10201d', fontSize: 7, fontWeight: '900', letterSpacing: 0.7 },
  pressed: { opacity: 0.7 },
});
