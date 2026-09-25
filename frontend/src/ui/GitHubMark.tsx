import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { themedSheet } from '@/theme';

// GitHub's mark, for the button that links to this project's repository.
//
// The one drawing in this app that is not ours. The path is `mark-github-16`
// from GitHub's Octicons, copied unchanged. Octicons are MIT, so REUSE.toml
// gives this file a table of its own and the licences page carries their
// notice.
//
// The licence covers the drawing, not the mark. The mark is GitHub's trademark
// too, and its logo guidelines (github.com/logos) are the stricter rule. They
// allow it as a social button linking to a project, which is this, but only in
// white, black or grey, and never recoloured, stretched or merged into another
// design. So the caller passes the colour, and the colour it should pass is the
// theme's `textStrong`, which is pure white or pure black on every theme.

/** The mark, drawn on a 16-unit square. */
const MARK =
  'M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656';

export interface GitHubMarkProps {
  /** White, black or grey only. See the note above. */
  color: string;
  /** Width and height, in points. The mark is square and has to stay square. */
  size: number;
}

export default function GitHubMark({ color, size }: GitHubMarkProps) {
  return (
    // Inert, for the reason the board's arrow layers are. On iOS an `Svg`
    // claims every touch inside its box, whatever its own `pointerEvents`
    // says, and this one sits in the middle of the button it would take the
    // press from.
    <View style={styles.inert}>
      <Svg height={size} viewBox="0 0 16 16" width={size}>
        <Path d={MARK} fill={color} />
      </Svg>
    </View>
  );
}

const styles = themedSheet(() => ({
  inert: { pointerEvents: 'none' },
}));
