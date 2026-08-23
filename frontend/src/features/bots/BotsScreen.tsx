import {useRouter} from 'expo-router';
import {useMemo, useState} from 'react';
import {Platform, StyleSheet, Text, View} from 'react-native';

import BotLevelPicker from './BotLevelPicker';
import BotSeriesPanel from './BotSeriesPanel';
import EngineBotRow from './EngineBotRow';
import {BOT_PROFILES, DEFAULT_BOT_PROFILE_ID} from '@/engine/bots/profiles';
import {links} from '@/navigation/links';
import {useGameStore} from '@/store/gameStore';
import {colors, contentWidth, space, type} from '@/theme';
import LinkRow from '@/ui/LinkRow';
import ScreenShell from '@/ui/ScreenShell';
import {
    Badge,
    EmptyState,
    OptionChips,
    Panel,
    PrimaryButton,
    SectionHeading,
} from '@/ui/primitives';
import type {ModeID} from '@/types/game';

// Playing bots: one screen.
//
// This page used to carry four sub-tabs, and the reason given for them was that
// it is a lot — which was true, and was the problem rather than the answer. Two
// of the four were not about playing at all: the bot ladder is the Leaderboard's
// BOTS board, rendered twice, and the registry plus two whole documents belong to
// whoever owns an engine. The ladder is now a link and the registry is its own
// page under Account, which leaves exactly what this page is for: play one, watch
// two, or challenge one somebody connected.
//
// So the controls are compact rather than paginated. The difficulty ladder picks
// your opponent *and* the red side of a battle, and the chips under it pick the
// blue side, which is one six-tile control instead of three.

export default function BotsScreen() {
    const router = useRouter();
    const modes = useGameStore((state) => state.modes);
    const engineBots = useGameStore((state) => state.engineBots);
    const botPlayerCount = useGameStore((state) => state.botPlayerCount);
    const startBotGame = useGameStore((state) => state.startBotGame);
    const challengeBot = useGameStore((state) => state.challengeBot);
    const gameState = useGameStore((state) => state.gameState);
    const connectionStatus = useGameStore((state) => state.connectionStatus);

    const [profileId, setProfileId] = useState(DEFAULT_BOT_PROFILE_ID);
    const [opponentId, setOpponentId] = useState('boulder');
    const [engineModeId, setEngineModeId] = useState<ModeID | null>(null);

    const playableModes = useMemo(() => modes.filter((mode) => mode.playable !== false), [modes]);
    const profileOptions = useMemo(
        () => BOT_PROFILES.map((profile) => ({label: profile.name, value: profile.id})),
        [],
    );

    // RPSFish runs in a browser Worker, so the bots that ship with the app are a
    // website feature. An engine on somebody else's machine is not, which is why
    // only this panel carries the gate.
    const nativeBotsSupported = Platform.OS === 'web';
    const launchBlocked = !nativeBotsSupported || Boolean(gameState);
    // Challenging an engine is not in conflict with being queued: the server
    // releases the seek when the bot game starts.
    const challengeBlocked = connectionStatus !== 'connected' || Boolean(gameState);

    const profile = BOT_PROFILES.find((entry) => entry.id === profileId) ?? BOT_PROFILES[0]!;
    const opponent = BOT_PROFILES.find((entry) => entry.id === opponentId) ?? BOT_PROFILES[0]!;
    const engineMode =
        playableModes.find((mode) => mode.id === engineModeId) ?? playableModes[0] ?? null;

    return (
        <ScreenShell width={contentWidth.page}>
            <Panel>
                <SectionHeading
                    eyebrow="PLAYERS' ENGINES"
                    title="Engines online now"
                    trailing={
                        <Badge
                            label={`${engineBots.length} ONLINE`}
                            tone={engineBots.length > 0 ? 'accent' : 'neutral'}
                        />
                    }
                />
                {engineBots.length === 0 ? (
                    <EmptyState
                        detail="Anyone can connect one — write a program that reads and writes lines."
                        title="No engines are connected"
                    />
                ) : (
                    <>
                        {playableModes.length > 1 ? (
                            <OptionChips<ModeID | null>
                                label="CHALLENGE THEM AT"
                                onChange={setEngineModeId}
                                options={playableModes.map((mode) => ({label: mode.name, value: mode.id}))}
                                value={engineMode?.id ?? null}
                            />
                        ) : null}
                        <View style={styles.list}>
                            {engineBots.map((bot) => (
                                <EngineBotRow
                                    bot={bot}
                                    disabled={challengeBlocked || !engineMode}
                                    key={bot.botId}
                                    modeId={engineMode?.id as ModeID}
                                    onChallenge={() => challengeBot(bot.botId, engineMode!.id)}
                                />
                            ))}
                        </View>
                    </>
                )}
                <LinkRow
                    detail="Register an engine, take its token, and run it from your own machine."
                    divided={engineBots.length > 0}
                    href={links.myBots()}
                    title="Run your own engine"
                />
            </Panel>

            {/*
        The ladder these runs feed is the Leaderboard's BOTS board. This page
        carried its own eight-row copy of it, which is one table too many for a
        number that is already published somewhere it belongs.
      */}
            <BotSeriesPanel bots={engineBots} modes={playableModes}/>

            <Panel>
                <SectionHeading
                    eyebrow="PRACTICE"
                    title="Play a (RPSFish) bot"
                    trailing={
                        <Badge
                            label={`${botPlayerCount} PLAYING BOTS`}
                            tone={botPlayerCount > 0 ? 'live' : 'neutral'}
                        />
                    }
                />
                <Text style={styles.help}>
                    {nativeBotsSupported
                        ? 'RPSFish plays the other side in your browser. No clock, no rating, and the hint and undo buttons stay switched on.'
                        : 'These bots run on the RPSFish web engine, so the practice board is available on the website.'}
                </Text>

                <BotLevelPicker compact onSelect={setProfileId} selectedProfileId={profile.id}/>
                <Text style={styles.blurb}>
                    <Text style={styles.blurbName}>{profile.name}</Text> · {profile.blurb}
                </Text>

                <View style={styles.buttonRow}>
                    {playableModes.map((mode) => (
                        <View key={mode.id} style={styles.buttonCell}>
                            <PrimaryButton
                                accessibilityLabel={`Play ${mode.name} against ${profile.name}`}
                                disabled={launchBlocked}
                                label={`PLAY ${mode.name.toUpperCase()} ▶`}
                                onPress={() => startBotGame({mode, profileId: profile.id})}
                            />
                        </View>
                    ))}
                </View>

                {/*
          Watching is the same choice one step further on — this bot against
          another one — so it sits under the same ladder rather than in a second
          panel with a second copy of it. Two identical picks are allowed: a
          mirror match is a fair thing to want to watch.
        */}
                <View style={styles.watch}>
                    <OptionChips
                        label={`OR WATCH ${profile.name.toUpperCase()} FIGHT`}
                        onChange={setOpponentId}
                        options={profileOptions}
                        value={opponent.id}
                    />
                    <View style={styles.buttonRow}>
                        {playableModes.map((mode) => (
                            <View key={mode.id} style={styles.buttonCell}>
                                <PrimaryButton
                                    accessibilityLabel={`Watch ${profile.name} fight ${opponent.name} in ${mode.name}`}
                                    compact
                                    disabled={launchBlocked}
                                    label={`WATCH ${mode.name.toUpperCase()} ▶`}
                                    onPress={() =>
                                        router.push(
                                            links.botBattle({
                                                blue: opponent.id,
                                                mode: mode.id,
                                                red: profile.id,
                                            }),
                                        )
                                    }
                                    tone="quiet"
                                />
                            </View>
                        ))}
                    </View>
                </View>
            </Panel>
        </ScreenShell>
    );
}

const styles = StyleSheet.create({
    help: {...type.body, color: colors.textMuted, marginTop: space.small},
    blurb: {...type.body, color: colors.textDim, marginTop: space.small},
    blurbName: {color: colors.textSubtle, fontWeight: '900'},
    buttonRow: {flexDirection: 'row', flexWrap: 'wrap', gap: space.small, marginTop: space.medium},
    buttonCell: {flexBasis: 180, flexGrow: 1},
    watch: {
        marginTop: space.large,
        paddingTop: space.medium,
        borderTopWidth: 1,
        borderTopColor: colors.borderSoft,
    },
    list: {marginTop: space.small},
});
