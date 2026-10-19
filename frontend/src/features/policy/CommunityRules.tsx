import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { agreeToCommunityRules, hasAgreedToCommunityRules } from '@/store/communityRules';
import { colors, space, themedSheet, type } from '@/theme';
import ModalCard from '@/ui/ModalCard';
import { GhostButton, PrimaryButton } from '@/ui/primitives';

// The rules, shown the first time somebody posts something other people read:
// a chat message, a name, a feedback post, an opening's name. See
// `store/communityRules.ts` for why then and not at launch.
//
// The rules are written out here rather than linked to the policy page, because
// this opens on a live board, and the app holds a player at their board: a link
// out of it would bounce straight back.

const RULES = [
  'No harassment, slurs, threats, or bigotry, in chat, names, or anything else you post.',
  'There is no tolerance for objectionable content or abusive players. Breaking these rules can cost you your account.',
  'Report or block anyone who does, from the ⋯ beside their message or from their page.',
];

/**
 * `requireAgreement(post)` runs `post` straight away for a player who has
 * agreed, and otherwise asks first and runs it on agreeing. Render
 * `rulesDialog` once, anywhere in the screen.
 */
export function useCommunityRules() {
  const [pending, setPending] = useState<(() => void) | null>(null);

  const requireAgreement = useCallback((post: () => void) => {
    if (hasAgreedToCommunityRules()) {
      post();
      return;
    }
    // Wrapped, because a bare function handed to a state setter is called as
    // an updater rather than stored.
    setPending(() => post);
  }, []);

  const agree = () => {
    agreeToCommunityRules();
    const post = pending;
    setPending(null);
    post?.();
  };

  const rulesDialog = (
    <ModalCard
      closeLabel="Close the community rules"
      eyebrow="BEFORE YOU POST"
      footer={
        <>
          <GhostButton label="NOT NOW" onPress={() => setPending(null)} />
          <PrimaryButton label="I AGREE" onPress={agree} />
        </>
      }
      maxWidth={440}
      onClose={() => setPending(null)}
      title="Community rules"
      visible={pending !== null}
    >
      <View style={styles.rules}>
        {RULES.map((rule) => (
          <View key={rule} style={styles.rule}>
            <Text style={styles.bullet}>•</Text>
            <Text style={styles.ruleText}>{rule}</Text>
          </View>
        ))}
      </View>
    </ModalCard>
  );

  return { requireAgreement, rulesDialog };
}

const styles = themedSheet(() => ({
  rules: { gap: space.small, marginTop: space.medium },
  rule: { flexDirection: 'row', gap: space.small },
  bullet: { ...type.body, color: colors.textMuted },
  // `minWidth: 0` so a long rule wraps rather than pushing the card wide.
  ruleText: { ...type.body, color: colors.text, flex: 1, minWidth: 0 },
}));
