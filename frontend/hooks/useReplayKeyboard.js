import { useEffect } from 'react';

const isEditingTarget = (target) =>
  target?.isContentEditable ||
  target?.tagName === 'INPUT' ||
  target?.tagName === 'TEXTAREA' ||
  target?.tagName === 'SELECT';

// Shared browser keyboard navigation for analysis history, game review, and
// the live bot-battle timeline.
export default function useReplayKeyboard({
  enabled = true,
  onFirst,
  onLast,
  onNext,
  onPrevious,
}) {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    const handleKeyDown = (event) => {
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

      const actions = {
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
