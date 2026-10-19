import { deviceStorage } from './deviceStorage';

// Whether the player on this device has agreed to the rules for what they post.
//
// App Review wants anyone who can post where others read to have agreed to
// terms that make plain abuse is not tolerated (guideline 1.2). Asked once per
// device, the first time somebody posts, rather than at launch: most players
// never chat, and the rules mean more beside the message they are about to
// send than on a screen in the way of the first game.
//
// Kept in memory as well, so a device with no storage asks once a session
// rather than before every message.

const AGREED_KEY = 'rps.communityRulesAgreed.v1';

let agreedThisSession = false;

export const hasAgreedToCommunityRules = (): boolean => {
  if (agreedThisSession) return true;
  try {
    return Boolean(deviceStorage()?.getItem(AGREED_KEY));
  } catch {
    return false;
  }
};

export const agreeToCommunityRules = () => {
  agreedThisSession = true;
  try {
    deviceStorage()?.setItem(AGREED_KEY, new Date().toISOString());
  } catch {
    // Agreed for this session, which is the most a device with no storage
    // can remember.
  }
};
