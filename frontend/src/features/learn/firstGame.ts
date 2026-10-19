import type { TutorialSource } from '@/analytics/events';
import { deviceStorage } from '@/store/deviceStorage';
import { isNewDevice } from '@/store/localIdentity';

// The lessons, opened by themselves once: the first time a device that has
// never been here reaches the lobby.
//
// Only a new device. Everybody already playing learned the game without the
// lessons, and opening them over somebody's lobby the day they ship would read
// as the app forgetting who they are. A device that already had an account id
// has been here; one that had to be given one has not.
//
// Once, and written down as the lessons open rather than when they finish,
// because leaving them is an answer too. They stay one press away under How to
// play, so nothing is lost by not insisting.
//
// And never on a device that cannot remember having done it. A browser with
// storage blocked mints a new account id on every visit, so it looks new every
// time, and would otherwise be sent to the lessons on every one of them.

const OFFERED_KEY = 'rps.firstGameOffered.v1';

/** What the decision rests on, apart so the rule can be read and tested alone. */
export interface FirstGameFacts {
  newDevice: boolean;
  alreadyOffered: boolean;
  /** Whether the offer can be written down, so it is only ever made once. */
  canRemember: boolean;
}

export const firstGameDue = ({ newDevice, alreadyOffered, canRemember }: FirstGameFacts) =>
  newDevice && !alreadyOffered && canRemember;

// Kept in memory as well, so the answer is no for the rest of the session
// whatever the storage did.
let offeredThisSession = false;

/**
 * Whether to open the lessons now. True at most once per device, and recorded
 * in the same breath, so two callers in one launch cannot both act on it.
 */
export const takeFirstGameOffer = (): boolean => {
  if (offeredThisSession) return false;
  offeredThisSession = true;
  const storage = deviceStorage();
  let alreadyOffered = false;
  let canRemember = false;
  try {
    alreadyOffered = Boolean(storage?.getItem(OFFERED_KEY));
    if (storage && !alreadyOffered) {
      storage.setItem(OFFERED_KEY, new Date().toISOString());
      canRemember = Boolean(storage.getItem(OFFERED_KEY));
    }
  } catch {
    // A store that cannot be read or written is a store that cannot remember.
  }
  const due = firstGameDue({ newDevice: isNewDevice(), alreadyOffered, canRemember });
  if (due) openLessonsFrom('first_launch');
  return due;
};

// Which door the lessons were opened by, for the one event their screen sends.
// Handed over in memory rather than in the address, which would carry it into
// every refresh and every copied link.
let door: TutorialSource = 'link';

/** Say how the lessons are about to be opened. */
export const openLessonsFrom = (source: TutorialSource) => {
  door = source;
};

/** How the lessons were opened, asked once by their screen as it opens. */
export const takeLessonDoor = (): TutorialSource => {
  const source = door;
  door = 'link';
  return source;
};
