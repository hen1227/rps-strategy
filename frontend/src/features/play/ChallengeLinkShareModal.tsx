import { useEffect } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { OwnLinkActions } from './ChallengeLinkActions';
import SetupPreview from '@/features/game/SetupPreview';
import { useNow } from '@/hooks/useNow';
import { useLobbyGate } from '@/hooks/useQueueCall';
import { challengeLinkURL } from '@/navigation/links';
import { linkStatusLine } from '@/store/challengeLinkSelectors';
import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, themedSheet, type } from '@/theme';
import ModalCard from '@/ui/ModalCard';
import { PrimaryButton } from '@/ui/primitives';

// The moment a link is made: here it is, and here is how to send it.
//
// The game it offers is drawn above the address, for the reason the challenge
// form draws it — this is what the other person will be looking at when they
// open it. Closing the dialog leaves the link out: it is in the Right now rail,
// and in the lobby's strip on a phone, until somebody plays it or it expires.

export interface ChallengeLinkShareModalProps {
  visible: boolean;
  onClose: () => void;
}

export default function ChallengeLinkShareModal({ visible, onClose }: ChallengeLinkShareModalProps) {
  const link = useGameStore((state) => state.ownLink);
  const creating = useGameStore((state) => state.creatingLink);
  const mode = useGameStore(
    (state) => state.modes.find((candidate) => candidate.id === link?.setup?.modeId) ?? null,
  );
  const defaultTimeControl = useGameStore((state) => state.defaultTimeControl);
  // Signed out, every game is casual, so casual is not a change worth counting
  // — the same reading the challenge form's own preview gives it.
  const casualOnly = useLobbyGate().needsAccount;
  const now = useNow(30_000);

  // Nothing to hand over: the server refused to make one — its reason is in the
  // banner — or the link has already become a game.
  useEffect(() => {
    if (visible && !link && !creating) onClose();
  }, [creating, link, onClose, visible]);

  return (
    <ModalCard
      closeLabel="Close the challenge link"
      eyebrow="CHALLENGE LINK"
      footer={<PrimaryButton label="DONE" onPress={onClose} />}
      maxWidth={560}
      onClose={onClose}
      title="Send it to your opponent"
      visible={visible}
    >
      {link?.setup ? (
        <View style={styles.body}>
          <SetupPreview
            casualOnly={casualOnly}
            defaultTimeControl={defaultTimeControl}
            mode={mode}
            setup={link.setup}
            size="banner"
          />
          {/*
            The address itself, selectable, for a device whose clipboard the
            button cannot reach and for anybody who wants to see what they are
            sending before they send it.
          */}
          <View style={styles.address}>
            <Text numberOfLines={2} selectable style={styles.url}>
              {challengeLinkURL(link.code)}
            </Text>
          </View>
          <Text style={styles.rule}>The first to open it plays you. Anyone after watches.</Text>
          <View style={styles.actions}>
            <Text numberOfLines={1} style={styles.status}>
              {now ? linkStatusLine(link, 'author', now) : ''}
            </Text>
            <OwnLinkActions link={link} />
          </View>
        </View>
      ) : (
        <View style={styles.making}>
          <ActivityIndicator color={colors.textMuted} size="small" />
          <Text style={styles.rule}>Making your link…</Text>
        </View>
      )}
    </ModalCard>
  );
}

const styles = themedSheet(() => ({
  body: { gap: space.medium, marginTop: space.medium },
  address: {
    paddingHorizontal: space.medium,
    paddingVertical: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSunken,
  },
  url: { ...type.bodyStrong, color: colors.textStrong, fontVariant: ['tabular-nums'] },
  rule: { ...type.body, color: colors.textMuted },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.small,
  },
  status: { ...type.meta, color: colors.textFaint, flexShrink: 1 },
  making: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    marginTop: space.medium,
    minHeight: 64,
  },
}));
