import { links } from '@/navigation/links';
import { GhostLink } from '@/ui/primitives';

// The way from one game of a run to the whole run.
//
// Three places need it and they are three different surroundings — a card in the
// history feed, the record card beside a review, and the rail over a board being
// spectated — so what is shared is the wording and the address rather than a
// layout. Somebody who arrives on game four of six from a pasted link should not
// have to work out for themselves that there were six.

export interface SeriesLinkProps {
  seriesId: string;
  /** Shortened where the surroundings already say the word "series". */
  label?: string;
  compact?: boolean;
}

export default function SeriesLink({
  seriesId,
  label = 'FULL SERIES RESULTS ›',
  compact = true,
}: SeriesLinkProps) {
  return (
    <GhostLink
      accessibilityLabel="See every game of this series"
      compact={compact}
      href={links.series(seriesId)}
      label={label}
      tone="accent"
    />
  );
}
