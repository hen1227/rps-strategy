import { useEffect, useRef } from 'react';

import { useGameStore } from '@/store/gameStore';

import { appearanceFromJson, hasStoredAppearance } from './preference';
import { adoptAppearance } from './store';

// Carrying a look between a browser and a phone.
//
// The rule is that **the device wins on the device**. What you picked here is
// what you see here, and an account arriving with a different answer does not
// overrule it — otherwise signing in on a phone you had already set up would
// silently repaint it, and there would be no way to have two devices look
// different on purpose.
//
// So the account's look is adopted in exactly one case: a device that has never
// been told what to look like. That covers what the sync is actually for — a new
// phone, a second browser, a cleared cache — and nothing else. It is also why
// adopting does *not* write to device storage: the account stays the source of
// truth here until somebody makes a choice on this device, at which point that
// choice is written and this stops firing.
export const useAccountAppearanceSync = () => {
  const fromAccount = useGameStore((state) => state.account?.appearance);
  // Once per launch. The account object is republished on every `account_updated`
  // frame — including the one this player's own save causes — and re-adopting on
  // each of those would fight with a choice being made on this device right now.
  const settled = useRef(false);

  useEffect(() => {
    if (settled.current || !fromAccount) return;
    settled.current = true;
    if (hasStoredAppearance()) return;
    adoptAppearance(appearanceFromJson(fromAccount));
  }, [fromAccount]);
};
