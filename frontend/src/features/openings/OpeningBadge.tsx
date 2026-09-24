// What the game on the board is called, and the invitation to name it.
//
// Two pieces of one idea, kept together because they say the same thing at
// two moments. During the game the badge names the opening being played; when
// the game is over, the card asks the two people who just played it to name
// the line nobody has named yet — which is where the book's names come from in
// the first place.
//
// Neither works anything out. `useGameOpening` answers both questions from the
// one naming hierarchy the openings screen uses, so a line called "Skipping
// Stone" there is called that here.

import {Pressable, StyleSheet, Text, View} from 'react-native';

import {openingKind, type GameOpening} from '@/engine/openingBook';
import {links} from '@/navigation/links';
import {useGoTo} from '@/navigation/stack';
import { colors, radius, space, themedSheet, type } from '@/theme';
import type {ModeID} from '@/types/game';

export interface OpeningBadgeProps {
    modeId: ModeID;
    opening: GameOpening | null;
}

export interface LiveOpeningBadgeProps extends OpeningBadgeProps {
    /**
     * Whether the badge is a door.
     *
     * Only once the game is over. While it is being played the app holds people
     * at the board on purpose — see the rule in `app/_layout.tsx` — so a badge
     * that offered to leave would bounce straight back, which is worse than a
     * badge that plainly says what the opening is called.
     */
    linked?: boolean;
}

/** A line as a badge reads it out: `d8-c7 f2-g3`. */
const spellLine = (line: readonly string[]) => line.join('  ');

/**
 * The opening being played, as a chip on the board.
 *
 * Chess boards have done this forever, and it is the only place in this app
 * where the book meets a game in progress: the name arrives while the moves
 * that earned it are still on the screen. An opening nobody has named still
 * gets the chip — "unnamed" is a fact about the book, and hiding it is how a
 * book stays unnamed.
 */
export function OpeningBadge({linked, modeId, opening}: LiveOpeningBadgeProps) {
    // The chip is drawn on a board, which is a full-screen page: opening the
    // book puts the board down rather than covering it. See `navigation/stack`.
    const go = useGoTo();
    if (!opening) return null;

    const published = opening.name;
    const named = Boolean(published);
    const label = published
        ? published.name
        : opening.title.inherited
            ? opening.title.label
            : spellLine(opening.line);
    const description = named
        ? `Opening: ${label}`
        : `This opening has no name. ${spellLine(opening.line)}`;

    const chip = (
        <>
            <Text style={[styles.kicker, named && styles.kickerNamed]}>
                {named ? openingKind(opening.line).toUpperCase() : 'UNNAMED'}
            </Text>
            <Text numberOfLines={1} style={[styles.label, named && styles.labelNamed]}>
                {label}
            </Text>
        </>
    );

    if (!linked) {
        return (
            <View accessibilityLabel={description} style={[styles.badge, named && styles.badgeNamed]}>
                {chip}
            </View>
        );
    }

    return (
        <Pressable
            accessibilityHint="Opens this opening in the book."
            accessibilityLabel={description}
            accessibilityRole="link"
            onPress={() => go(links.openings({mode: modeId, line: opening.line}))}
            style={({pressed}) => [styles.badge, named && styles.badgeNamed, pressed && styles.pressed]}
        >
            {chip}
        </Pressable>
    );
}

/**
 * The end of a game, and a line still waiting for a name.
 *
 * Asked here rather than anywhere else because this is the one moment two
 * people have just played the thing: they know what it felt like, which is the
 * only qualification naming an opening has ever had. The button hands them to
 * the book, on the line itself, where the name is typed -- and where it is
 * published on the spot rather than queued.
 *
 * `opening.wants` is already bounded by the length a player may name, so this
 * never offers a line the book will refuse. See `openingOfGame`.
 */
export function NameThisOpening({modeId, opening}: OpeningBadgeProps) {
    const go = useGoTo();
    const wants = opening?.wants;
    if (!opening || !wants?.length) return null;

    const kind = openingKind(wants).toLowerCase();
    const under = opening.name;

    return (
        <View style={styles.prompt}>
            <View style={styles.promptCopy}>
                <Text style={styles.promptEyebrow}>NAME THIS {kind.toUpperCase()}</Text>
                <Text style={styles.promptTitle}>{spellLine(wants)}</Text>
                <Text style={styles.promptDetail}>
                    {under
                        ? `You played an unnamed variation of the ${under.name}. Name it now.`
                        : `Nobody has named this ${kind} yet. Name it now.`}
                </Text>
            </View>
            <Pressable
                accessibilityHint="Opens this line in the opening book, where it is named."
                accessibilityLabel={`Name the opening ${spellLine(wants)}`}
                accessibilityRole="link"
                onPress={() => go(links.openings({mode: modeId, line: wants}))}
                style={({pressed}) => [styles.promptButton, pressed && styles.pressed]}
            >
                <Text style={styles.promptButtonText}>Name it</Text>
            </Pressable>
        </View>
    );
}

const styles = themedSheet(() => ({
    badge: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.snug,
        maxWidth: '100%',
        marginTop: space.tight,
        paddingVertical: 3,
        paddingHorizontal: space.snug,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.small,
        backgroundColor: colors.surfaceSunken,
    },
    badgeNamed: {borderColor: colors.goldBorder, backgroundColor: colors.goldSurfaceDeep},
    pressed: {opacity: 0.7},
    kicker: {...type.eyebrow, color: colors.textFaint},
    kickerNamed: {color: colors.goldMuted},
    // `minWidth: 0` is what lets a long name shorten instead of pushing the
    // clock off the top bar. See `rnw-layout-traps`.
    label: {...type.label, flexShrink: 1, minWidth: 0, color: colors.textSubtle},
    labelNamed: {color: colors.goldSoft},

    prompt: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: space.small,
        marginVertical: space.small,
        padding: space.medium,
        borderWidth: 1,
        borderColor: colors.goldBorder,
        borderRadius: radius.medium,
        backgroundColor: colors.goldSurfaceDeep,
    },
    promptCopy: {flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0, gap: space.hair},
    promptEyebrow: {...type.eyebrow, color: colors.goldMuted},
    promptTitle: {...type.rowTitle, color: colors.goldBright},
    promptDetail: {...type.body, color: colors.goldSoft},
    promptButton: {
        paddingVertical: space.small,
        paddingHorizontal: space.medium,
        borderRadius: radius.small,
        backgroundColor: colors.gold,
    },
    promptButtonText: {...type.label, fontSize: 11, color: colors.textInverse},
}));
