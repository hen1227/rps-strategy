// The visual tones a badge, panel, or banner can take.
//
// Named here rather than in the component that renders them, because they
// travel: a tournament selector decides that a status reads as "warm", and the
// badge that eventually draws it should not be the only thing that knows the
// word is allowed.

export type BadgeTone = 'neutral' | 'accent' | 'live' | 'gold' | 'warm' | 'cool';

export type PanelTone = 'default' | 'accent' | 'live';

export type BannerTone = 'notice' | 'error';

export type ButtonTone = 'accent' | 'quiet';
