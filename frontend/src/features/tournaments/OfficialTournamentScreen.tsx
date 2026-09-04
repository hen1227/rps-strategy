import {Linking, Pressable, StyleSheet, Text, View} from 'react-native';

import {
    localTimeLabel,
    officialTournament,
    officialTournamentPhase,
    untilLabel,
} from './officialTournament';
import {useNow} from '@/hooks/useNow';
import {links} from '@/navigation/links';
import {useGameStore} from '@/store/gameStore';
import {colors, contentWidth, radius, space, type} from '@/theme';
import ScreenShell from '@/ui/ScreenShell';
import LinkRow from '@/ui/LinkRow';
import {Badge, Panel, SectionHeading} from '@/ui/primitives';

// The official tournament, which does not happen here.
//
// The `/tournaments` board is events of this site: this server owns their
// signups, their pairings, and the boards they are played on. This page is the
// opposite of all of that. The event is WebGoatGuy's, on his site, and the two
// useful things this page can do are say when it is and get people to it.
//
// The one part that *is* this site's business is the second half: every engine
// on the bot ladder is stood down across the afternoon, so that the practice
// ladder is not the interesting thing here while the real event runs. That is a
// schedule the server owns — see `bot_bench.go` — and this page reports it from
// the socket rather than deciding it, so the page and the server cannot end up
// disagreeing about whether the bots are up.

/** A big button that leaves the site. */
function OutwardButton({
                           detail,
                           label,
                           tone = 'accent',
                           url,
                       }: {
    detail: string;
    label: string;
    tone?: 'accent' | 'quiet' | 'discord';
    url: string;
}) {
    return (
        <Pressable
            accessibilityHint="Opens outside this site"
            accessibilityLabel={label}
            accessibilityRole="link"
            onPress={() => Linking.openURL(url)}
            style={({pressed}) => [
                styles.outward,
                tone === 'accent' && styles.outwardAccent,
                tone === 'quiet' && styles.outwardQuiet,
                tone === 'discord' && styles.outwardDiscord,
                pressed && styles.pressed,
            ]}
        >
            <View style={styles.outwardCopy}>
                <Text style={[styles.outwardLabel, tone === 'accent' && styles.outwardLabelAccent]}>
                    {label}
                </Text>
                <Text style={styles.outwardDetail}>{detail}</Text>
                <Text numberOfLines={1} style={styles.outwardURL}>
                    {url}
                </Text>
            </View>
            <Text style={[styles.outwardMark, tone === 'accent' && styles.outwardLabelAccent]}>↗</Text>
        </Pressable>
    );
}

export default function OfficialTournamentScreen() {
    // Null until this has mounted, which is what keeps the pre-rendered HTML free
    // of a countdown that was true at build time. Everything below that depends
    // on it renders nothing at first and appears a render later. See `useNow`.
    const now = useNow();
    const phase = now === null ? null : officialTournamentPhase(now);
    // The server's answer, not this page's arithmetic: it is the thing that
    // actually refuses the games.
    const bench = useGameStore((state) => state.botBench);
    const local = now === null ? null : localTimeLabel(officialTournament.startsAtUnixMs);

    const status =
        phase === 'live'
            ? {label: 'HAPPENING NOW', tone: 'live' as const}
            : phase === 'over'
                ? {label: 'FINISHED', tone: 'neutral' as const}
                : {label: 'UPCOMING', tone: 'gold' as const};

    return (
        <ScreenShell width={contentWidth.reading}>
            <View style={styles.hero}>
                <Text style={styles.heroEyebrow}>NOT ON THIS SITE</Text>
                <Text style={styles.heroTitle}>{officialTournament.name}</Text>
            </View>

            <Panel tone="accent">
                <SectionHeading
                    eyebrow="WHEN"
                    title={officialTournament.whenLabel}
                    // The badge is the only thing on this page that changes through the
                    // afternoon, and it is absent from the pre-rendered HTML on purpose.
                    trailing={phase ? <Badge label={status.label} tone={status.tone}/> : undefined}
                />
                {local ? <Text style={styles.body}>In your timezone: {local}.</Text> : null}
                {phase === 'upcoming' && now !== null ? (
                    <Text style={styles.countdown}>
                        Starts {untilLabel(now, officialTournament.startsAtUnixMs)}.
                    </Text>
                ) : null}
                {phase === 'live' ? (
                    <Text style={styles.countdown}>It is running right now — go and play.</Text>
                ) : null}
                {phase === 'over' ? (
                    <Text style={styles.body}>
                        This one is over. The Discord below is where the next one will be announced.
                    </Text>
                ) : null}
            </Panel>

            <View style={styles.section}>
                <OutwardButton
                    detail="The official site, and where the tournament is played."
                    label="PLAY AT MEAF.US/RPS2"
                    url={officialTournament.playURL}
                />
            </View>

            <Panel>
                <SectionHeading
                    eyebrow="WHAT HAPPENS HERE"
                    title="The engines are off for the afternoon"
                />
                <Text style={styles.body}>
                    Every bot on this site stops taking games from{' '}
                    <Text style={styles.emphasis}>{officialTournament.botsOfflineLabel}</Text> — half an
                    hour before the first round until well after the last.
                </Text>
                {/*
          The server's own account of the same thing, which is the one that
          decides what actually happens. Shown only when it has something to
          say — before the socket is up there is nothing here but the sentence
          above, which is the honest state.
        */}
                {bench?.active ? (
                    <View style={styles.serverNote}>
                        <Text style={styles.serverNoteTitle}>The engines are off right now</Text>
                        <Text style={styles.serverNoteBody}>
                            The server is refusing bot games for {bench.reason}
                            {bench.untilUnixMs
                                ? `, back at ${localTimeLabel(bench.untilUnixMs) ?? 'the end of the window'}`
                                : ''}
                            .
                        </Text>
                    </View>
                ) : null}
            </Panel>
        </ScreenShell>
    );
}

const styles = StyleSheet.create({
    hero: {paddingTop: space.xlarge, paddingBottom: space.snug},
    heroEyebrow: {...type.eyebrow, color: colors.gold, letterSpacing: 2.1},
    heroTitle: {
        color: colors.textStrong,
        fontSize: 32,
        fontWeight: '900',
        letterSpacing: -1,
        marginTop: space.tight,
    },
    heroSubtitle: {
        ...type.bodyStrong,
        color: colors.textMuted,
        lineHeight: 20,
        marginTop: space.small,
    },

    body: {...type.bodyStrong, color: colors.textMuted, lineHeight: 19, marginTop: space.small},
    emphasis: {color: colors.textStrong, fontWeight: '900'},
    countdown: {
        ...type.bodyStrong,
        color: colors.accentTextStrong,
        fontWeight: '900',
        marginTop: space.small,
    },

    section: {gap: space.small},

    outward: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.medium,
        padding: space.medium,
        borderRadius: radius.large,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
    },
    outwardDiscord: {
        borderColor: colors.discordBorder,
        backgroundColor: colors.discordSurface,
    },
    outwardQuiet: {
        borderColor: colors.borderFaint,
        backgroundColor: colors.surfaceMuted,
    },
    outwardAccent: {
        borderColor: colors.accentBorder,
        backgroundColor: colors.accentSurface,
    },
    outwardCopy: {flex: 1, minWidth: 0, gap: space.hair},
    outwardLabel: {...type.label, color: colors.textStrong, fontSize: 11, letterSpacing: 1},
    outwardLabelAccent: {color: colors.accentTextStrong},
    outwardDetail: {...type.body, color: colors.textMuted, marginTop: space.hair},
    outwardURL: {...type.meta, color: colors.textFaint},
    outwardMark: {color: colors.textFaint, fontSize: 14},

    serverNote: {
        marginTop: space.medium,
        padding: space.medium,
        borderRadius: radius.medium,
        backgroundColor: colors.surfaceMuted,
    },
    serverNoteTitle: {...type.rowTitle, color: colors.textStrong},
    serverNoteBody: {...type.body, color: colors.textMuted, marginTop: space.tight},

    rows: {marginTop: space.small},

    pressed: {opacity: 0.7},
});
