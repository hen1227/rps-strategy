import type { BadgeTone } from '@/ui/tones';
import type { FeedbackStatus } from '@/types/protocol';

// What each status looks like.
//
// The *words* come from the server, because they depend on the kind — a bug is
// fixed and a suggestion ships. The colour does not: "the host agreed" and "it
// happened" read the same whichever kind they are on, so the mapping lives here
// rather than being a second thing for the server to publish.
//
// `open` gets no badge at all. It is the majority of the board and the default
// state of everything on it, so a badge saying so is a badge on every row,
// which is the same as no badge with extra noise.
export const statusTone = (status: FeedbackStatus): BadgeTone | null => {
  switch (status) {
    case 'open':
      return null;
    case 'accepted':
      return 'accent';
    case 'done':
      return 'live';
    case 'declined':
      return 'warm';
    case 'duplicate':
      return 'neutral';
  }
};
