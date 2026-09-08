import {useRouter} from 'expo-router';
import {useMemo, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';

import BotLevelPicker from './BotLevelPicker';
import BotSeriesPanel from './BotSeriesPanel';
import EngineBotCard, {ENGINE_CARD_BASIS} from './EngineBotCard';
import {BOT_PROFILES, DEFAULT_BOT_PROFILE_ID} from '@/engine/bots/profiles';
import {
    engineSupportsMode,
    engineUnavailableMessage,
    isEngineAvailable,
} from '@/engine/rpsfish/client';
import {engineElo} from '@/features/live/liveSelectors';
import {links} from '@/navigation/links';
import {useGameStore} from '@/store/gameStore';
import {SEAT_CHOICES, type SeatChoice} from '@/store/setupSelectors';
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
import type {BotPresence} from '@/types/protocol';

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
// What it is *mostly* for changed under it. RPSFish shipping in the bundle was
// once the whole of this page and is now a long way off the pace — a dozen
// people's engines are usually connected, several of them hundreds of points
// stronger. So the connected engines lead and the practice ladder sits at the
// bottom, unconditionally: it is always available and it is never the reason
// anybody came, and a panel that jumps to the top of the page whenever the last
// engine disconnects is one nobody can learn the position of.
//
// One mode governs the whole page. It decides which rating each card shows,
// what a challenge is played at, and what a series is run at — three questions
// with one honest answer, where the page used to ask two of them separately in
// chip rows six inches apart.

/** How a seat reads out loud, where 'random' is not a colour anybody plays. */
const seatDescription = (seat: SeatChoice) => (seat === 'random' ? 'either side' : seat);

/**
 * Invisible items that pad out the grid's last row.
 *
 * Every card is `flexGrow: 1`, so a row that is not full shares the leftover
 * space between whatever is on it — and a single orphan card takes all of it,
 * arriving three times the width of the ones above it. Zero-height items with
 * the card's own basis sit at the end and soak that up instead. Five of them
 * covers a six-column row, which is wider than this page can get.
 */
const GRID_FILLERS = [0, 1, 2, 3, 4];

/** The two sides of the series form, as the page holds them. */
interface PitPick {
    first: string | null;
    second: string | null;
}

export default function BotsScreen() {
    const router = useRouter();
    const modes = useGameStore((state) => state.modes);
    const engineBots = useGameStore((state) => state.engineBots);
    const botPlayerCount = useGameStore((state) => state.botPlayerCount);
    const startBotGame = useGameStore((state) => state.startBotGame);
    const challengeBot = useGameStore((state) => state.challengeBot);
    const gameState = useGameStore((state) => state.gameState);
    const connectionStatus = useGameStore((state) => state.connectionStatus);
    // Which engines are this account's own, for the tint on their cards. The
    // roster publishes the owner's id on every row — see BotPresence.ownerUserId
    // — so this needs no request of its own, and it is the same comparison the
    // series form makes to decide whether a run is casual.
    const accountId = useGameStore((state) => state.accountId);

    const [profileId, setProfileId] = useState(DEFAULT_BOT_PROFILE_ID);
    const [opponentId, setOpponentId] = useState('boulder');
    const [engineModeId, setEngineModeId] = useState<ModeID | null>(null);
    // Two seats, because the two panels are two games. Sharing one control
    // across a page break would make a choice made under an engine's name
    // silently apply to a practice board six inches further down.
    const [engineSeat, setEngineSeat] = useState<SeatChoice>('random');
    const [practiceSeat, setPracticeSeat] = useState<SeatChoice>('random');
    // Null until somebody presses VS, which is what lets the default below track
    // the roster: the two strongest engines are already in the slots when the
    // page loads, and stop being the moment anybody says otherwise.
    const [pitPick, setPitPick] = useState<PitPick | null>(null);

    const playableModes = useMemo(() => modes.filter((mode) => mode.playable !== false), [modes]);
    // The two panels below are RPSFish playing, so they offer only the modes
    // RPSFish knows. Handed one it does not, its search throws and the bot
    // silently falls back to random legal moves — a rung labelled 1100 playing
    // like nothing at all, which is worse than not offering the game. The
    // engine panels above are other people's programs and keep the full list.
    const engineModes = useMemo(
        () => playableModes.filter((mode) => engineSupportsMode(mode.id)),
        [playableModes],
    );
    const profileOptions = useMemo(
        () => BOT_PROFILES.map((profile) => ({label: profile.name, value: profile.id})),
        [],
    );
    // Explains why `engineModes` is shorter than `playableModes`, when it is a
    // tournament gate rather than the engine simply not knowing the mode. Reads
    // the gate fresh per mode instead of naming a mode, so it goes quiet on its
    // own once nothing is gated.
    const tournamentNotice = useMemo(
        () => playableModes.map((mode) => engineUnavailableMessage(mode.id)).find(Boolean) ?? null,
        [playableModes],
    );

    const engineMode =
        playableModes.find((mode) => mode.id === engineModeId) ?? playableModes[0] ?? null;
    const ratedAt = engineMode?.id ?? ('V6' as ModeID);

    // Strongest first, which is the order somebody scanning a dozen engines for
    // an opponent is scanning in. Deliberately not grouped by what each is doing:
    // an engine mid-game is still the one worth challenging next, and a roster
    // that reshuffles every time a bot picks up a game is one nobody can learn
    // the shape of. Ties break by name so the order is stable between broadcasts.
    const engines = useMemo(
        () =>
            [...engineBots].sort(
                (left, right) =>
                    engineElo(right, ratedAt) - engineElo(left, ratedAt) ||
                    left.name.localeCompare(right.name),
            ),
        [engineBots, ratedAt],
    );

    // A bot that is mid-game cannot be entered into a new run, and neither can one
    // that is shutting down — that one is dropped rather than marked, because
    // unlike a private bot there is nobody, owner included, who can enter it. A
    // bot whose owner has not opened it to public play is still offered, because
    // its owner is allowed to enter it and the server is the one that knows who
    // that is. `benched` as well as `draining`: the server refuses to start a
    // series during a scheduled bench, so offering the engines would be a form
    // that can only fail.
    const pittable = useMemo(
        () => engines.filter((bot) => !bot.busy && !bot.draining && !bot.benched),
        [engines],
    );

    // The fight the page proposes before anybody has proposed one: the two
    // strongest free engines, preferring a second one with a different owner so
    // the default run is a rated one rather than a casual pair of somebody's own
    // bots. Starting a series is then a single press, which is the whole point.
    const defaultPit = useMemo<PitPick>(() => {
        const [top, ...rest] = pittable;
        if (!top) return {first: null, second: null};
        const rival =
            rest.find((bot) => !top.ownerUserId || bot.ownerUserId !== top.ownerUserId) ??
            rest[0] ??
            null;
        return {first: top.botId, second: rival?.botId ?? null};
    }, [pittable]);

    const pick = pitPick ?? defaultPit;
    // Resolved against the free engines rather than trusted: a bot that has since
    // picked up a game empties its slot instead of arming a START button that the
    // server would refuse.
    const inPit = (botId: string | null) =>
        pittable.find((bot) => bot.botId === botId) ?? null;
    const pitFirst = inPit(pick.first);
    const pitSecond = inPit(pick.second);

    const togglePit = (bot: BotPresence) => {
        const id = bot.botId;
        if (pick.first === id) setPitPick({first: null, second: pick.second});
        else if (pick.second === id) setPitPick({first: pick.first, second: null});
        else if (!pick.first) setPitPick({first: id, second: pick.second});
        else if (!pick.second) setPitPick({first: pick.first, second: id});
        // Both sides taken. Keeping the two most recent presses is the only rule
        // that lets somebody walk down the roster comparing engines without
        // having to empty a slot between each pair.
        else setPitPick({first: pick.second, second: id});
    };

    // RPSFish runs in a browser Worker, so the bots that ship with the app are a
    // website feature. An engine on somebody else's machine is not, which is why
    // only this panel carries the gate.
    // Whether RPSFish is here, not which platform this is: the engine ships in
    // the iOS binary, so the practice board is offered wherever it can actually
    // be played.
    const nativeBotsSupported = isEngineAvailable();
    const launchBlocked = !nativeBotsSupported || Boolean(gameState);
    // Challenging an engine is not in conflict with being queued: the server
    // releases the seek when the bot game starts.
    const challengeBlocked = connectionStatus !== 'connected' || Boolean(gameState);

    const profile = BOT_PROFILES.find((entry) => entry.id === profileId) ?? BOT_PROFILES[0]!;
    const opponent = BOT_PROFILES.find((entry) => entry.id === opponentId) ?? BOT_PROFILES[0]!;

    const enginePanel = (
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
                    <Text style={styles.help}>
                        Programs other people wrote, running on their own machines. PLAY challenges
                        one, VS puts it in the series below, and the mode decides both — as well as
                        which rating each card shows.
                    </Text>
                    {playableModes.length > 1 ? (
                        <OptionChips<ModeID | null>
                            label="MODE"
                            onChange={setEngineModeId}
                            options={playableModes.map((mode) => ({label: mode.name, value: mode.id}))}
                            value={engineMode?.id ?? null}
                        />
                    ) : null}
                    {/*
              An engine has no opinion about which side it plays, so this is a
              choice the player simply gets. EITHER hands them Red, which is
              what a challenge has always done here.
            */}
                    <OptionChips<SeatChoice>
                        label="YOUR SIDE"
                        onChange={setEngineSeat}
                        options={SEAT_CHOICES}
                        value={engineSeat}
                    />
                    <View style={styles.grid}>
                        {engines.map((bot) => (
                            <EngineBotCard
                                bot={bot}
                                challengeDisabled={challengeBlocked || !engineMode}
                                key={bot.botId}
                                mine={Boolean(bot.ownerUserId) && bot.ownerUserId === accountId}
                                modeId={ratedAt}
                                onChallenge={() => challengeBot(bot.botId, engineMode!.id, engineSeat)}
                                onPit={togglePit}
                                pitRole={
                                    pitFirst?.botId === bot.botId
                                        ? 'first'
                                        : pitSecond?.botId === bot.botId
                                          ? 'second'
                                          : null
                                }
                            />
                        ))}
                        {GRID_FILLERS.map((index) => (
                            <View key={`filler-${index}`} style={styles.gridFiller}/>
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
    );

    // The ladder these runs feed is the Leaderboard's BOTS board. This page
    // carried its own eight-row copy of it, which is one table too many for a
    // number that is already published somewhere it belongs.
    const pitPanel = engineMode ? (
        <BotSeriesPanel
            available={pittable.length}
            first={pitFirst}
            mode={engineMode}
            onClear={(side) =>
                setPitPick(side === 'first' ? {...pick, first: null} : {...pick, second: null})
            }
            onSwap={() => setPitPick({first: pick.second, second: pick.first})}
            second={pitSecond}
        />
    ) : null;

    const practicePanel = (
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
                    ? 'RPSFish plays the other side on this device. No clock, no rating, and the hint and undo buttons stay switched on.'
                    : 'This build does not include the RPSFish engine, so the practice board is unavailable here.'}
            </Text>
            {tournamentNotice ? (
                <Text style={styles.tournamentNotice}>{tournamentNotice}</Text>
            ) : null}

            <BotLevelPicker compact onSelect={setProfileId} selectedProfileId={profile.id}/>
            <Text style={styles.blurb}>
                <Text style={styles.blurbName}>{profile.name}</Text> · {profile.blurb}
            </Text>

            {/*
        EITHER deals a side, and keeps dealing: a rematch hands over the one
        you did not just play. Choosing a colour means it, so the rematch
        button leaves you on it.
      */}
            <View style={styles.seat}>
                <OptionChips<SeatChoice>
                    label="YOUR SIDE"
                    onChange={setPracticeSeat}
                    options={SEAT_CHOICES}
                    value={practiceSeat}
                />
            </View>

            <View style={styles.buttonRow}>
                {engineModes.map((mode) => (
                    <View key={mode.id} style={styles.buttonCell}>
                        <PrimaryButton
                            accessibilityLabel={`Play ${mode.name} against ${profile.name} as ${seatDescription(practiceSeat)}`}
                            disabled={launchBlocked}
                            label={`PLAY ${mode.name.toUpperCase()} ▶`}
                            onPress={() =>
                                startBotGame({mode, playerColor: practiceSeat, profileId: profile.id})
                            }
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
                    {engineModes.map((mode) => (
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
    );

    return (
        <ScreenShell width={contentWidth.page}>
            {enginePanel}
            {pitPanel}
            {practicePanel}
        </ScreenShell>
    );
}

const styles = StyleSheet.create({
    help: {...type.body, color: colors.textMuted, marginTop: space.small},
    tournamentNotice: {
        ...type.body,
        color: colors.accentSoft,
        marginTop: space.small,
        fontWeight: '700',
    },
    seat: {marginTop: space.small},
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
    grid: {flexDirection: 'row', flexWrap: 'wrap', gap: space.small, marginTop: space.medium},
    gridFiller: {flexBasis: ENGINE_CARD_BASIS, flexGrow: 1, height: 0},
});
