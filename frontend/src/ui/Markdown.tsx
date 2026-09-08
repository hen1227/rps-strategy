import { Fragment, type ReactNode } from 'react';
import { Linking, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { colors, radius } from '@/theme';

// A small Markdown renderer, for documents the server ships.
//
// It exists so the bot guide on the website is literally the file in `docs/`
// rather than a retyping of it. That rules out the two of them disagreeing,
// which is the failure that matters — a page telling somebody to run a command
// that changed last month is worse than a plainer page.
//
// It handles what those documents actually use: headings, paragraphs, fenced
// code, bullet lists, tables, horizontal rules, and inline code, bold, and
// links. Anything else renders as its own text, which is the right failure for
// a renderer nobody should have to think about.

import { parseBlocks, tokenizeInline, type InlineToken } from './markdownParse';

/** Turn the parsed inline tokens into views. */
function inline(text: string, keyPrefix: string): ReactNode {
  return renderTokens(tokenizeInline(text), keyPrefix);
}

function renderTokens(tokens: InlineToken[], keyPrefix: string): ReactNode {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.kind) {
      case 'code':
        return (
          <Text key={key} style={styles.code}>
            {token.text}
          </Text>
        );
      case 'bold':
        return (
          <Text key={key} style={styles.bold}>
            {renderTokens(token.children, key)}
          </Text>
        );
      case 'link':
        // Relative links point at files in the repository, which a reader of
        // this page has no way to open. They keep their text and lose the tap
        // rather than leading nowhere.
        if (!/^https?:/.test(token.href)) {
          return (
            <Text key={key} style={styles.bold}>
              {token.text}
            </Text>
          );
        }
        return (
          <Text key={key} onPress={() => Linking.openURL(token.href)} style={styles.link}>
            {token.text}
          </Text>
        );
      default:
        return <Fragment key={key}>{token.text}</Fragment>;
    }
  });
}

export interface MarkdownProps {
  /** The document, as Markdown. */
  source: string | null | undefined;
}

export default function Markdown({ source }: MarkdownProps) {
  const blocks = parseBlocks(source);
  return (
    <View style={styles.document}>
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        switch (block.kind) {
          case 'heading':
            return (
              <Text key={key} style={[styles.heading, headingStyle(block.level)]}>
                {inline(block.text, key)}
              </Text>
            );
          case 'code':
            return (
              <View key={key} style={styles.codeBlock}>
                <Text selectable style={styles.codeBlockText}>
                  {block.text}
                </Text>
              </View>
            );
          case 'rule':
            return <View key={key} style={styles.rule} />;
          case 'list':
            return (
              <View key={key} style={styles.list}>
                {block.items.map((item, itemIndex) => (
                  <View key={`${key}-${itemIndex}`} style={styles.listItem}>
                    <Text style={styles.bullet}>•</Text>
                    <Text style={styles.paragraph}>{inline(item, `${key}-${itemIndex}`)}</Text>
                  </View>
                ))}
              </View>
            );
          case 'table':
            return (
              <View key={key} style={styles.table}>
                <View style={[styles.tableRow, styles.tableHead]}>
                  {block.header.map((cell, cellIndex) => (
                    <Text key={`${key}-h-${cellIndex}`} style={[styles.cell, styles.cellHead]}>
                      {inline(cell, `${key}-h-${cellIndex}`)}
                    </Text>
                  ))}
                </View>
                {block.rows.map((row, rowIndex) => (
                  <View key={`${key}-r-${rowIndex}`} style={styles.tableRow}>
                    {row.map((cell, cellIndex) => (
                      <Text key={`${key}-r-${rowIndex}-${cellIndex}`} style={styles.cell}>
                        {inline(cell, `${key}-r-${rowIndex}-${cellIndex}`)}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            );
          default:
            return (
              <Text key={key} style={styles.paragraph}>
                {inline(block.text, key)}
              </Text>
            );
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  document: { gap: 10 },
  heading: { color: colors.textStrong, fontWeight: '800' },
  heading1: { fontSize: 22, marginTop: 6 },
  heading2: { fontSize: 17, marginTop: 14 },
  heading3: { fontSize: 14, marginTop: 10 },
  heading4: { fontSize: 12, marginTop: 8, letterSpacing: 1 },
  paragraph: { color: colors.text, fontSize: 13, lineHeight: 20, flexShrink: 1 },
  bold: { color: colors.textStrong, fontWeight: '700' },
  link: { color: colors.accentText, textDecorationLine: 'underline' },
  code: { color: colors.accentSoft, fontFamily: 'monospace', fontSize: 12 },
  codeBlock: {
    backgroundColor: colors.surfaceWell,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radius.small,
    padding: 10,
  },
  codeBlockText: { color: colors.textSoft, fontFamily: 'monospace', fontSize: 11, lineHeight: 17 },
  rule: { height: 1, backgroundColor: colors.borderSoft, marginVertical: 6 },
  list: { gap: 4 },
  listItem: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  bullet: { color: colors.textFaint, fontSize: 13, lineHeight: 20 },
  table: {
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.small,
    overflow: 'hidden',
  },
  tableRow: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.borderSoft },
  tableHead: { borderTopWidth: 0, backgroundColor: colors.surfaceRaised },
  cell: {
    flex: 1,
    // `flex: 1` alone is not enough on the web, where a flex item will not
    // shrink below its longest unbreakable word. A cell holding a command like
    // `'eval|exec|pickle|os.system'` was widening its row past the table, and
    // `overflow: hidden` above then cut the next cell's text off entirely.
    minWidth: 0,
    color: colors.text,
    fontSize: 12,
    lineHeight: 18,
    padding: 8,
  },
  cellHead: { color: colors.textFaint, fontWeight: '800', fontSize: 10, letterSpacing: 1 },
});

/**
 * The style for a heading level.
 *
 * A lookup rather than `styles[`heading${level}`]`: the parser accepts up to
 * four hashes and a fifth would index a style that does not exist, which the
 * template form spells as `undefined` and says nothing about.
 */
function headingStyle(level: number): TextStyle | undefined {
  if (level <= 1) return styles.heading1;
  if (level === 2) return styles.heading2;
  if (level === 3) return styles.heading3;
  return styles.heading4;
}
