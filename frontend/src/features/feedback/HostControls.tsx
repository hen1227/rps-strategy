import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import ConfirmButton from '@/features/admin/ConfirmButton';
import type { FeedbackAnswer } from '@/store/api/feedback';
import { space, themedSheet, colors, type } from '@/theme';
import { GhostButton, LabeledInput, OptionChips, Panel, SectionHeading } from '@/ui/primitives';
import type { FeedbackItem, FeedbackPolicy, FeedbackStatus } from '@/types/protocol';

// The host's controls, on the item they are about.
//
// Not a tab of the admin screen, which is where every other host tool lives,
// and the difference is worth stating. Those tools are a queue: a list of
// things to work through, each of which you act on once and never see again.
// This is not a queue — it is a public conversation the host is part of — and
// answering a bug means reading the thread under it. A separate admin screen
// would mean reading it in one place and answering it in another, with the
// vote count and the replies out of sight at the moment of deciding.
//
// So: the same page everybody else reads, with the controls appearing on it for
// the one account that has them.
//
// # What is immediate and what is staged
//
// The status, the pin and the hide take effect on the press. They are single
// choices with nothing to type, and a Save button for a chip is a second press
// to confirm something the first press already said.
//
// The note, the link and the duplicate pointer are typed, so they are staged
// and saved together. Anything else would write to the board on every
// keystroke.

export interface HostControlsProps {
  item: FeedbackItem;
  policy: FeedbackPolicy | null;
  onAnswer: (answer: FeedbackAnswer) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}

export default function HostControls({ item, policy, onAnswer, onDelete }: HostControlsProps) {
  const [note, setNote] = useState(item.statusNote ?? '');
  const [linkUrl, setLinkUrl] = useState(item.linkUrl ?? '');
  const [duplicateOf, setDuplicateOf] = useState(item.duplicateOf ?? '');
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);

  // Re-seed when the host moves to another item, or when the server's answer
  // differs from what was typed. Keyed on the id as well as the values so that
  // opening a second thread does not carry the first one's draft into it.
  useEffect(() => {
    setNote(item.statusNote ?? '');
    setLinkUrl(item.linkUrl ?? '');
    setDuplicateOf(item.duplicateOf ?? '');
    setArmed(false);
  }, [item.itemId, item.statusNote, item.linkUrl, item.duplicateOf]);

  const apply = async (answer: FeedbackAnswer) => {
    setBusy(true);
    await onAnswer(answer);
    setBusy(false);
  };

  const edited =
    note !== (item.statusNote ?? '') ||
    linkUrl !== (item.linkUrl ?? '') ||
    duplicateOf !== (item.duplicateOf ?? '');

  // The wording of each status depends on the kind — see `statusLabel` — so the
  // picker asks the server's table for the words rather than keeping its own.
  const statusOptions =
    policy?.statuses.map((status) => ({
      value: status.id,
      label: item.kind === 'bug' ? status.bugLabel : status.suggestionLabel,
    })) ?? [];

  return (
    <Panel tone="accent">
      <View style={styles.controls}>
        <SectionHeading eyebrow="HOST" title="Answer this" />

        {statusOptions.length > 0 ? (
          <OptionChips
            disabled={busy}
            label="STATUS"
            onChange={(status: FeedbackStatus) => void apply({ status })}
            options={statusOptions}
            value={item.status}
          />
        ) : null}

        <LabeledInput
          hint="One sentence, shown beside the status on the board."
          label="NOTE"
          maxLength={400}
          multiline
          onChangeText={setNote}
          placeholder="Reproduced. Fixed in the next build."
          value={note}
        />
        <LabeledInput
          autoCapitalize="none"
          hint="An issue, a thread, or anywhere else this is being tracked."
          label="LINK"
          keyboardType="url"
          onChangeText={setLinkUrl}
          placeholder="https://"
          value={linkUrl}
        />
        <LabeledInput
          autoCapitalize="none"
          hint="The item this one duplicates, by id. Shown as a link on the board."
          label="DUPLICATE OF"
          onChangeText={setDuplicateOf}
          placeholder=""
          value={duplicateOf}
        />
        <GhostButton
          disabled={!edited || busy}
          label="SAVE"
          onPress={() => void apply({ statusNote: note, linkUrl, duplicateOf })}
        />

        <View style={styles.row}>
          <GhostButton
            disabled={busy}
            label={item.pinned ? 'UNPIN' : 'PIN TO TOP'}
            onPress={() => void apply({ pinned: !item.pinned })}
          />
          <GhostButton
            disabled={busy}
            label={item.hidden ? 'SHOW AGAIN' : 'HIDE'}
            onPress={() => void apply({ hidden: !item.hidden })}
          />
          <GhostButton
            disabled={busy}
            // "Make a suggestion" reads as composing a new one. This button
            // reclassifies the item it is on, which is what "file as" says.
            label={item.kind === 'bug' ? 'FILE AS SUGGESTION' : 'FILE AS BUG'}
            onPress={() => void apply({ kind: item.kind === 'bug' ? 'suggestion' : 'bug' })}
          />
        </View>

        <View style={styles.row}>
          <ConfirmButton
            armed={armed}
            busy={busy}
            label="DELETE"
            onArm={() => setArmed(true)}
            onConfirm={() => {
              setArmed(false);
              void onDelete();
            }}
          />
          <Text style={styles.deleteHint}>
            Hide to keep the record for moderation. Delete to remove the thread and its votes.
          </Text>
        </View>
      </View>
    </Panel>
  );
}

const styles = themedSheet(() => ({
  controls: { gap: space.medium },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.small },
  deleteHint: { ...type.meta, color: colors.textFaint, flex: 1, minWidth: 180 },
}));
