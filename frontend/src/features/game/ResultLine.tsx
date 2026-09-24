import { Text, type StyleProp, type TextStyle } from 'react-native';

import { recordResultSegments } from './resultLabels';
import type { GameRecord } from '@/types/protocol';
import PlayerLink from '@/ui/PlayerLink';
import { rowTitleText } from '@/ui/ListRow';

// "Alpha beat Beta by territory", with both names leading to their pages.
//
// The one line a row about a finished game carries is also the only place two
// names appear on it, and both of them are worth following: a history row that
// says somebody beat you is exactly where you go looking for who they were.
// The sentence is cut into pieces by `recordResultSegments` so that the names
// can be elements rather than substrings — see the note there.
//
// One `Text` with the links nested inside it, and deliberately not a flex row
// of pieces. A row was the first attempt and it wraps in the wrong place: the
// spacing lives inside the words (" beat ", " by territory"), React Native Web
// renders text as `pre-wrap`, and a piece that lands at the start of a wrapped
// line therefore begins with a visible space — the reason a game ended arrived
// indented by one character. Nested text is one continuous flow, so it breaks
// at the spaces the way a sentence should.
//
// It styles its own first line. `ListRow` styles a `title` handed in as a
// string and leaves a node alone, so this takes `rowTitleText` from that
// component: a row with a link in its title has to be a node, and it should
// not look like a different kind of row for that reason.
//
// No `numberOfLines`. `ListRow` clips a string title to one line, which on a
// phone spent the whole row on two long engine names and lost the result — the
// half of the sentence the row exists for. This wraps instead.

export interface ResultLineProps {
  record: GameRecord;
  /** Added to the row-title styling, rather than replacing it. */
  style?: StyleProp<TextStyle>;
  /**
   * Draw the names as plain text. For a line inside something that is already
   * a link, where a nested anchor would mean nothing on the web.
   */
  plain?: boolean;
}

export default function ResultLine({ record, style, plain }: ResultLineProps) {
  return (
    <Text style={[rowTitleText(), style]}>
      {recordResultSegments(record).map((segment, index) =>
        segment.isName ? (
          <PlayerLink key={index} name={segment.text} plain={plain} />
        ) : (
          segment.text
        ),
      )}
    </Text>
  );
}
