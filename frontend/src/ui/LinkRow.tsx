import { Link } from 'expo-router';
import type { Href } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import ListRow from './ListRow';
import { colors, space } from '@/theme';

// One row that goes somewhere.
//
// A page that has been split into smaller pages needs a way back into the parts
// it no longer shows, and "a title, a line about it, a chevron" is that way in
// four places now. Built on `ListRow` so it lines up with the tables around it,
// and on `Link` so it is a real anchor on the web — right-clickable, and
// crawlable, which matters for two pages of documentation.

export interface LinkRowProps {
  href: Href;
  title: string;
  /** One line on what is over there. */
  detail?: string;
  divided?: boolean;
}

export default function LinkRow({ href, title, detail, divided = true }: LinkRowProps) {
  return (
    <Link asChild href={href}>
      <Pressable
        accessibilityLabel={title}
        accessibilityRole="link"
        // One resolved style object: see the note in SidebarNav.
        style={styles.pressable}
      >
        <ListRow
          divided={divided}
          meta={detail}
          title={title}
          trailing={<Text style={styles.chevron}>›</Text>}
        />
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  pressable: { width: '100%' },
  chevron: { color: colors.textFaint, fontSize: 18, paddingHorizontal: space.tight },
});
