// The visual tones a badge, panel, or banner can take.
//
// Named here rather than in the component that renders them, because they
// travel: a tournament selector decides that a status reads as "warm", and the
// badge that eventually draws it should not be the only thing that knows the
// word is allowed.

//
// What each one means, since the colours no longer say it on their own:
// `neutral` is metadata; `accent` is emphasis, drawn in the strongest letters
// rather than the accent green, which is kept for buttons; `live` is something
// happening right now and the only tone with a colour of its own; `danger` is
// something wrong that somebody should look at; `gold` is a prize. `warm` and
// `cool` are kept so older call sites still compile, and draw as neutral.
export type BadgeTone = 'neutral' | 'accent' | 'live' | 'danger' | 'gold' | 'warm' | 'cool';

export type PanelTone = 'default' | 'accent' | 'live';

export type BannerTone = 'notice' | 'error';

// `discord` is the one tone borrowed from outside the app: a button that signs
// into someone else's service is expected to look like that service.
export type ButtonTone = 'accent' | 'quiet' | 'discord';
