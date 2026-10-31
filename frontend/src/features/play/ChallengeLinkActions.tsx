import { View } from 'react-native';

import { contentTypeOf } from '@/analytics/pagePath';
import { track } from '@/analytics/track';
import { challengeLinkURL } from '@/navigation/links';
import { useGameStore } from '@/store/gameStore';
import { space, themedSheet } from '@/theme';
import CopyLinkButton from '@/ui/CopyLinkButton';
import { GhostButton, TextButton } from '@/ui/primitives';
import { shareLink, useCanShareLinks } from '@/ui/shareLink';
import type { ChallengeLink } from '@/types/protocol';

// What can be done with a challenge link, from either end of it.
//
// One component for every place a link is drawn — the dialog that hands it
// over, the Right now rail, the lobby's strip and the link's own page — so the
// four cannot drift into four sets of buttons that do slightly different
// things.

export interface ChallengeLinkActionsProps {
  link: ChallengeLink;
  /**
   * Room for one way to send it rather than two. Where there is a share sheet
   * it already offers copying, so SHARE alone is both; elsewhere it is COPY.
   */
  narrow?: boolean;
}

/** The author's: send it, or take it back. */
export function OwnLinkActions({ link, narrow }: ChallengeLinkActionsProps) {
  const cancel = useGameStore((state) => state.cancelChallengeLink);
  const canShare = useCanShareLinks();
  const url = challengeLinkURL(link.code);
  // Somebody has taken it and is waiting: there is nothing left to send.
  const sending = link.state === 'open';

  return (
    <View style={styles.row}>
      {sending && !(narrow && canShare) ? (
        <CopyLinkButton accessibilityLabel="Copy your challenge link" url={url} />
      ) : null}
      {sending && canShare ? (
        <GhostButton
          accessibilityLabel="Share your challenge link"
          compact
          label="SHARE"
          onPress={() => {
            void shareLink(url, 'Play me at RPS Strategy').then((shared) => {
              if (shared) track('share', { content_type: contentTypeOf(url), method: 'share' });
            });
          }}
        />
      ) : null}
      <TextButton
        accessibilityLabel="Cancel your challenge link"
        label="Cancel"
        onPress={() => cancel(link.code)}
      />
    </View>
  );
}

/** The taker's: stop waiting. */
export function AwaitedLinkActions({ link }: ChallengeLinkActionsProps) {
  const leave = useGameStore((state) => state.leaveChallengeLink);
  const name = link.challenger?.username || 'them';
  return (
    <View style={styles.row}>
      <GhostButton
        accessibilityLabel={`Stop waiting for ${name}`}
        compact
        label="LEAVE"
        onPress={() => leave(link.code)}
      />
    </View>
  );
}

const styles = themedSheet(() => ({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.small },
}));
