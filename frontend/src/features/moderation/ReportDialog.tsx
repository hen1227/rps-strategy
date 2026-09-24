import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { failureMessage } from '@/errors';
import { fileReport, getReportPolicy, type NewReport } from '@/store/api/moderation';
import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, themedSheet, type } from '@/theme';
import ModalCard from '@/ui/ModalCard';
import { Banner, PrimaryButton } from '@/ui/primitives';
import type { ChatMessage, ReportCategory, ReportCategoryID } from '@/types/protocol';

// The report form, shared by everywhere somebody can be reported from.
//
// One dialog rather than one per surface, because the *thing being reported*
// differs between them and nothing else does: a chat line brings its own text
// along, a player page brings only a name. Both end up in the same queue, with
// the same categories, and a second copy of this form is how the two drift into
// asking different questions about the same incident.
//
// # Why the evidence travels with the report
//
// Chat here is never written to the database — it lives in server memory for
// the length of a game and then it is gone. So a report that named a message
// would be a report about something that no longer exists by the time the host
// reads it. `contextFrom` below copies the surrounding lines out of the room and
// sends them as text. See backend/internal/persistence/reports.go.

/** How many chat lines around the incident are attached as evidence. */
const CONTEXT_LINES = 12;

/**
 * The evidence, as text, from the room the reporter is sitting in.
 *
 * The tail rather than a window around the reported line: a conversation reads
 * forwards, and the argument that led somewhere is nearly always the last thing
 * said. Timestamps are left out — the report carries its own — and the sender's
 * name is kept, because the whole point is who said what.
 */
export const contextFrom = (messages: ChatMessage[], focus?: ChatMessage): string => {
  const relevant = messages.slice(-CONTEXT_LINES);
  const lines = relevant.map(
    (message) => `${message.senderName?.trim() || 'Guest'}: ${message.text}`,
  );
  // The reported line itself, when it is older than the tail. A report about
  // something said twenty messages ago must not arrive with twenty messages
  // that do not include it.
  if (focus && !relevant.some((message) => message.id === focus.id)) {
    lines.unshift(`${focus.senderName?.trim() || 'Guest'}: ${focus.text}`, '…');
  }
  return lines.join('\n');
};

export interface ReportDialogProps {
  visible: boolean;
  onClose: () => void;
  /** Who is being reported. The id when the caller has one — a chat line does. */
  targetUserId?: string;
  targetName: string;
  /** Where it happened, when it happened at a board. */
  gameId?: string;
  /** The evidence. Built with `contextFrom` at the call site that has a room. */
  context?: string;
}

export default function ReportDialog({
  visible,
  onClose,
  targetUserId,
  targetName,
  gameId,
  context,
}: ReportDialogProps) {
  const accountId = useGameStore((state) => state.accountId);
  const sessionToken = useGameStore((state) => state.sessionToken);
  const profileKey = useGameStore((state) => state.profileKey);

  const [categories, setCategories] = useState<ReportCategory[]>([]);
  const [contactName, setContactName] = useState('');
  // Null rather than a default, and no way for a caller to supply one: the
  // reason is the whole content of a report, and a preselected one is a report
  // filed under whatever the surface assumed. See the note on the submit button.
  const [category, setCategory] = useState<ReportCategoryID | null>(null);
  const [details, setDetails] = useState('');
  const [maxDetails, setMaxDetails] = useState(1000);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState(false);

  // The categories come from the server rather than being restated here, so a
  // reason this form offers is always one the server will accept.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    getReportPolicy()
      .then((policy) => {
        if (cancelled) return;
        setCategories(policy.categories ?? []);
        setMaxDetails(policy.maxDetails ?? 1000);
        setContactName(policy.contactName ?? '');
      })
      .catch((requestError) => {
        if (!cancelled) setError(failureMessage(requestError));
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  // A fresh form each time it opens. Reporting two people in a row must not
  // carry the first one's words into the second one's report.
  useEffect(() => {
    if (visible) return;
    setCategory(null);
    setDetails('');
    setError(null);
    setFiled(false);
  }, [visible]);

  // A session when there is one, and the browser's own key otherwise. A guest
  // can report — see the note in backend/internal/server/reports.go about why
  // the button has to work for the player most likely to need it.
  const credential = sessionToken || profileKey;
  // "Something else" is the one category that says nothing on its own, so it
  // is the one that requires words.
  const needsDetails = category === 'other';
  const canSend =
    !sending && Boolean(category) && Boolean(credential) && (!needsDetails || details.trim().length > 0);

  const send = async () => {
    if (!category || !credential) return;
    setSending(true);
    setError(null);
    try {
      const report: NewReport = {
        targetUserId,
        targetUsername: targetName,
        category,
        details: details.trim(),
        gameId,
        context,
      };
      await fileReport(credential, accountId, report);
      setFiled(true);
    } catch (requestError) {
      setError(failureMessage(requestError));
    } finally {
      setSending(false);
    }
  };

  if (filed) {
    return (
      <ModalCard
        eyebrow="REPORT SENT"
        maxWidth={460}
        onClose={onClose}
        title="Thank you"
        visible={visible}
      >
        <Text style={styles.body}>
          Report sent. The host reviews reports within 24 hours and can restrict or remove accounts.
        </Text>
        <Text style={styles.body}>
          You will not receive an outcome update. Block this player to hide their messages and prevent direct challenges.
        </Text>
        <View style={styles.actions}>
          <PrimaryButton label="DONE" onPress={onClose} />
        </View>
      </ModalCard>
    );
  }

  return (
    <ModalCard
      eyebrow="REPORT A PLAYER"
      maxWidth={460}
      onClose={onClose}
      subtitle={`Reporting ${targetName}`}
      title="What happened?"
      visible={visible}
    >
      <ScrollView
        contentContainerStyle={styles.formBody}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.categoryList}>
          {categories.map((option) => {
            const chosen = option.id === category;
            return (
              <Pressable
                accessibilityLabel={option.label}
                accessibilityRole="radio"
                accessibilityState={{ checked: chosen }}
                key={option.id}
                onPress={() => setCategory(option.id)}
                style={({ pressed }) => [
                  styles.category,
                  chosen && styles.categoryChosen,
                  pressed && styles.pressed,
                ]}
              >
                <View style={[styles.radio, chosen && styles.radioChosen]} />
                <Text style={[styles.categoryText, chosen && styles.categoryTextChosen]}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.fieldLabel}>
          {needsDetails ? 'WHAT HAPPENED' : 'ANYTHING ELSE (OPTIONAL)'}
        </Text>
        <TextInput
          accessibilityLabel="Report details"
          maxLength={maxDetails}
          multiline
          onChangeText={setDetails}
          placeholder={
            needsDetails
              ? 'Describe what happened.'
              : 'Add anything that would not be obvious from the messages.'
          }
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.accent}
          style={styles.input}
          value={details}
        />

        {Boolean(context) && (
          <View style={styles.evidence}>
            <Text style={styles.evidenceLabel}>ATTACHED</Text>
            {/*
              Shown rather than merely sent. The reporter is about to hand this
              conversation to somebody, and a form that attaches a transcript
              without saying so is one that surprises people.
            */}
            <Text numberOfLines={4} style={styles.evidenceText}>
              {context}
            </Text>
            <Text style={styles.evidenceNote}>
              Recent messages are included in the report.
            </Text>
          </View>
        )}

        {!credential && (
          <Banner
            message="This browser has no account yet. Open a game first, or sign in."
            tone="error"
          />
        )}
        <Banner message={error} onDismiss={() => setError(null)} tone="error" />

        {Boolean(contactName) && (
          <Text style={styles.contact}>
            Something urgent, or a problem with the server itself? Message {contactName}{' '}
            on Discord.
          </Text>
        )}
      </ScrollView>

      <View style={styles.actions}>
        <PrimaryButton
          accessibilityLabel="Send this report"
          // Disabled until a reason is picked. Deliberately no default: the
          // reason is what the host sorts the queue by, and a preselected one
          // is a queue full of reports filed under whichever category happened
          // to be first.
          disabled={!canSend}
          label="SEND REPORT"
          loading={sending}
          onPress={send}
        />
      </View>
    </ModalCard>
  );
}

const styles = themedSheet(() => ({
  formBody: { gap: space.small, paddingTop: space.medium },
  body: { ...type.body, color: colors.textMuted, marginTop: space.small },

  categoryList: { gap: 1 },
  category: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    paddingVertical: space.snug,
    paddingHorizontal: space.small,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceMuted,
  },
  categoryChosen: {
    backgroundColor: colors.accentSurface,
    borderWidth: 1,
    borderColor: colors.accentBorder,
  },
  radio: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.borderLight,
  },
  radioChosen: { borderColor: colors.accentBright, backgroundColor: colors.accentBright },
  categoryText: { ...type.body, flex: 1, color: colors.text },
  categoryTextChosen: { color: colors.textStrong, fontWeight: '700' },

  fieldLabel: { ...type.eyebrow, color: colors.textFaint, marginTop: space.small },
  input: {
    minHeight: 74,
    maxHeight: 150,
    padding: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSunken,
    color: colors.text,
    ...type.body,
    textAlignVertical: 'top',
  },

  evidence: {
    padding: space.small,
    borderRadius: radius.medium,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderLight,
    backgroundColor: colors.surfaceSunken,
  },
  evidenceLabel: { ...type.eyebrow, color: colors.textFaint },
  evidenceText: { ...type.meta, color: colors.textMuted, marginTop: space.tight },
  evidenceNote: { ...type.meta, color: colors.textFaint, marginTop: space.tight },

  contact: { ...type.meta, color: colors.textFaint, marginTop: space.tight },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: space.medium },
  pressed: { opacity: 0.7 },
}));
