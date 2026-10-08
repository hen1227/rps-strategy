import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { themedSheet } from '@/theme';

// Apple's logo, for the website's Sign in with Apple button.
//
// The second drawing in this app that is not ours, beside GitHubMark. The path
// is Simple Icons' "apple", which is dedicated to the public domain under CC0,
// so there is no licence to carry and REUSE.toml needs no table for it.
//
// The mark is still Apple's trademark, and that is the rule that matters.
// Apple's Sign in with Apple guidelines are what permit it here: on a button
// that starts Sign in with Apple, beside Apple's own title, in black on white
// or white on black, and nowhere else. The phone does not use this at all —
// it draws Apple's own system button — so this file is only ever reached by
// `AppleSignInButton.web.tsx`.

/** The mark, drawn on a 24-unit square. */
const MARK =
  'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701';

export interface AppleMarkProps {
  /** Black or white only, matched to the button's title. See the note above. */
  color: string;
  /** Width and height, in points. The mark is drawn square. */
  size: number;
}

export default function AppleMark({ color, size }: AppleMarkProps) {
  return (
    // Inert, for the reason GitHubMark's is: an `Svg` would take the press
    // from the button it sits inside.
    <View style={styles.inert}>
      <Svg height={size} viewBox="0 0 24 24" width={size}>
        <Path d={MARK} fill={color} />
      </Svg>
    </View>
  );
}

const styles = themedSheet(() => ({
  inert: { pointerEvents: 'none' },
}));
