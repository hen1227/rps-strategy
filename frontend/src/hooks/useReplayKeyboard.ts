import { useEffect } from 'react';
import { Platform } from 'react-native';

/** Whether a key belongs to whatever the viewer is typing into. */
const isEditingTarget = (target: EventTarget | null) => {
  const element = target as (HTMLElement & { tagName?: string }) | null;
  return Boolean(
    element?.isContentEditable ||
      element?.tagName === 'INPUT' ||
      element?.tagName === 'TEXTAREA' ||
      element?.tagName === 'SELECT',
  );
};

export interface ReplayKeyboardOptions {
  enabled?: boolean;
  onFirst: () => void;
  onLast: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

// Shared browser keyboard navigation for analysis history, game review, and
// the live bot-battle timeline.
export function useReplayKeyboard({
  enabled = true,
  onFirst,
  onLast,
  onNext,
  onPrevious,
}: ReplayKeyboardOptions) {
  useEffect(() => {
    // React Native defines `window` as the global object, so its presence says
    // nothing about there being a DOM to listen to: off the web this hook has
    // no keyboard to bind and `window.addEventListener` is not a function.
    if (!enabled || Platform.OS !== 'web' || typeof window === 'undefined') return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isEditingTarget(event.target)
      ) {
        return;
      }

      const actions: Record<string, (() => void) | undefined> = {
        ArrowLeft: onPrevious,
        ArrowRight: onNext,
        ArrowUp: onFirst,
        ArrowDown: onLast,
        Home: onFirst,
        End: onLast,
      };
      const action = actions[event.key];
      if (!action) return;
      event.preventDefault();
      action();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, onFirst, onLast, onNext, onPrevious]);
}

export default useReplayKeyboard;
