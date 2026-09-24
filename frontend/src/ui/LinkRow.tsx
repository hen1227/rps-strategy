import { Link } from 'expo-router';
import type { Href } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import ListRow from './ListRow';
import { useStackProps } from '@/navigation/stack';
import { colors, space, themedSheet } from '@/theme';

// One row that goes somewhere.
//
// A page that has been split into smaller pages needs a way back into the parts
// it no longer shows, and "a title, a line about it, a chevron" is that way in
// four places now. Built on `ListRow` so it lines up with the tables around it,
// and on `Link` so it is a real anchor on the web — right-clickable, and
// crawlable, which matters for two pages of documentation.
//
// `useStackProps` because these rows are drawn on pages of both kinds: inside
// the lobby shell, where a row leads deeper and the stack is left alone, and on
// a full-screen page, where following one has to put that page down rather than
// cover it over. See `navigation/stack`.

export interface LinkRowProps {
  href: Href;
  title: string;
  /**
   * A line on what is over there. Allowed two, because a phone gives it about
   * 232 points and every one of these is a sentence — "Register an engine, take
   * its token, and run it from your own machine." wants 331 and was arriving as
   * "…and run it fr…" on every phone. See `metaLines` on `ListRow`.
   */
  detail?: string;
  divided?: boolean;
}

export default function LinkRow({ href, title, detail, divided = true }: LinkRowProps) {
  const stack = useStackProps(href);

  return (
    <Link asChild href={href} {...stack}>
      <Pressable
        accessibilityLabel={title}
        accessibilityRole="link"
        // One resolved style object: see the note in SidebarNav.
        style={styles.pressable}
      >
        <ListRow
          divided={divided}
          meta={detail}
          metaLines={2}
          title={title}
          trailing={<Text style={styles.chevron}>›</Text>}
        />
      </Pressable>
    </Link>
  );
}

const styles = themedSheet(() => ({
  pressable: { width: '100%' },
  chevron: { color: colors.textFaint, fontSize: 18, paddingHorizontal: space.tight },
}));
