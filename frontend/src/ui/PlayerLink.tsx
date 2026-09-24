import { Link } from 'expo-router';
import { Text, type StyleProp, type TextStyle } from 'react-native';

import { links } from '@/navigation/links';
import { useStackProps } from '@/navigation/stack';
import { HOVER_UNDERLINE_CLASS } from './hover';

// A name that goes to whoever owns it.
//
// The site had player pages and almost no way into them: the ladder's rows were
// the only names on it that led anywhere, so an engine on the Bots page, an
// entrant in a tournament, the two bots down the side of a series table and the
// opponent in your own game history were all dead ends. Every one of them is a
// name somebody wants to know more about at exactly the moment they read it.
//
// One component for all of them, rather than a `Link` wrapped by hand each
// time, because three things have to be got right every time and none of them
// is obvious:
//
//   - **It has to look like a link.** Underlined on hover and nothing before
//     that: a name is usually the most prominent thing in its row, and a name
//     permanently underlined or recoloured turns a page of them into a page of
//     links. See `./hover` for why the underline is CSS rather than state.
//   - **Not every name has a page.** An anonymous player is called Guest, which
//     is a placeholder rather than an account, and colour words like `Red` stand
//     in for one. Those render as the plain text they were, so the rule can be
//     applied everywhere without each caller checking.
//   - **A link inside a link is not a link.** Several rows here already navigate
//     as a whole — the ladder, the lobby's live games — and nesting anchors has
//     no defined meaning on the web. `plain` is how such a row keeps this
//     component's typography without the anchor.
//
// It renders a `Text` either way, so it drops into a row in place of the `Text`
// that was there without moving anything: on the web expo-router's `Link` is a
// real anchor, which middle-clicks into a new tab and right-clicks to copy an
// address worth having.
//
// And there is a fourth thing, which is why this asks `useStackProps`: names
// are read in a game's chat, on a board's player bar and down the side of a
// review as much as they are read in a list, and every one of those is a
// full-screen page that following the name has to put down. Left as a plain
// push, tapping an opponent's name mid-review slid a whole second lobby over
// the review and kept the review under it. See `navigation/stack`.

export interface PlayerLinkProps {
  /** The name as it should read on screen. */
  name: string;
  /**
   * What to address the page by, when that is not the name shown.
   *
   * A tournament entrant is displayed under the `ign` they chose while the
   * account behind it is a user id, and `links.player` resolves either — see
   * the note there. Defaults to the name, which is the ordinary case: a
   * username and a bot name are both addresses.
   */
  handle?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /**
   * Render as plain text: no anchor, no hover.
   *
   * For a name inside something that is already a link, and for a name shown
   * while its owner is sitting across the board — a live game is not the moment
   * to invite either player off the page.
   */
  plain?: boolean;
  /**
   * Read out in place of the name. Worth setting where the row has more to say
   * than the name does — a rank and a rating, say.
   */
  accessibilityLabel?: string;
}

/**
 * Whether a name is an address or a stand-in for the absence of one.
 *
 * `Guest` is the per-browser identity the server hands anybody who has not
 * linked Discord, and it is deliberately the same string for all of them, so
 * it names no page. Everything else is offered: player pages exist for
 * vouched-for accounts and for engines, and a name with no page says so on
 * arrival rather than failing, which is what lets this link optimistically.
 *
 * Applied to the name shown as well as to the address, because a guest does
 * have a user id and it does not lead anywhere: reading the address alone would
 * turn every `Guest` in a game history into a link to a 404.
 */
const namesAnAccount = (handle: string) => {
  const trimmed = handle.trim();
  return trimmed !== '' && trimmed.toLowerCase() !== 'guest';
};

export default function PlayerLink({
  name,
  handle,
  style,
  numberOfLines,
  plain,
  accessibilityLabel,
}: PlayerLinkProps) {
  const address = handle ?? name;
  // Before the early return, because a hook cannot be called after one — and
  // harmless for the names that do not link, since the href is only read to
  // work out which page it names.
  const stack = useStackProps(links.player(address));
  if (plain || !namesAnAccount(address) || !namesAnAccount(name)) {
    return (
      <Text numberOfLines={numberOfLines} style={style}>
        {name}
      </Text>
    );
  }
  return (
    <Link
      accessibilityLabel={accessibilityLabel ?? `${name}. Open their page.`}
      className={HOVER_UNDERLINE_CLASS}
      href={links.player(address)}
      numberOfLines={numberOfLines}
      style={style}
      {...stack}
    >
      {name}
    </Link>
  );
}
