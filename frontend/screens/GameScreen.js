import {useEffect, useState} from 'react';
import {
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useWindowDimensions,
    View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';

import Board from '../components/Board';
import CapturedPieces, {capturedPieces} from '../components/CapturedPieces';
import GameChat from '../components/GameChat';
import TerritoryMeter from '../components/TerritoryMeter';
import {useGameStore} from '../store/gameStore';
import {useTournamentCall} from '../store/useTournamentCall';
import {clock as clockColors, colors, overlay, players, radius, shadows} from '../theme';

const BOARD_SIZE = 9;
const LOW_TIME_MS = 20_000;

const otherColor = (color) => (color === 'Red' ? 'Blue' : 'Red');

const formatClock = (milliseconds) => {
    const safeMilliseconds = Math.max(0, milliseconds);
    if (safeMilliseconds < LOW_TIME_MS) {
        const seconds = Math.floor(safeMilliseconds / 1000);
        const tenths = Math.floor((safeMilliseconds % 1000) / 100);
        return `0:${String(seconds).padStart(2, '0')}.${tenths}`;
    }

    const totalSeconds = Math.ceil(safeMilliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const formatTimeControl = (timeControl) => {
    if (!timeControl) return 'Live';
    const initialMinutes = timeControl.initialTimeMs / 60_000;
    const incrementSeconds = timeControl.incrementMs / 1000;
    const initialLabel = Number.isInteger(initialMinutes)
        ? initialMinutes.toString()
        : initialMinutes.toFixed(1);
    return `${initialLabel} + ${incrementSeconds}`;
};

const remainingForColor = (clock, color) =>
    color === 'Red' ? clock?.redRemainingMs ?? 0 : clock?.blueRemainingMs ?? 0;

const profileName = (profile, fallback) => {
    const name = profile?.username?.trim();
    return name && name.toLowerCase() !== 'guest' ? name : fallback;
};

const outcomeFor = (gameState, playerColor) => {
    const isDraw = gameState.winner === 'Neutral';
    const didWin = gameState.winner === playerColor;
    const result = isDraw ? 'Draw' : didWin ? 'You won' : 'You lost';
    const reason = {
        abandonment: {
            method: 'ABANDONMENT',
            detail: didWin
                ? 'Your opponent did not return within 30 seconds.'
                : 'The game ended after you left the match.',
        },
        annihilation: {
            method: 'ANNIHILATION',
            detail: didWin
                ? 'You captured every opposing piece.'
                : 'Your opponent captured every one of your pieces.',
        },
        draw_agreement: {
            method: 'AGREEMENT',
            detail: 'Both players agreed to a draw.',
        },
        repetition: {
            method: 'REPETITION',
            detail: 'The same position occurred three times.',
        },
        stalemate: {
            method: 'STALEMATE',
            detail: 'A player had no legal move, which is a draw.',
        },
        infiltration: {
            method: 'INFILTRATION',
            detail: didWin
                ? "You reached your opponent's home boundary."
                : 'Your opponent reached your home boundary.',
        },
        resignation: {
            method: 'RESIGNATION',
            detail: didWin ? 'Your opponent resigned.' : 'You resigned the game.',
        },
        territory: {
            method: 'TERRITORY',
            detail: isDraw
                ? 'The board filled with equal territory.'
                : didWin
                    ? 'You controlled more territory when the board filled.'
                    : 'Your opponent controlled more territory when the board filled.',
        },
        timeout: {
            method: 'TIME',
            detail: didWin ? "Your opponent's clock expired." : 'Your clock expired.',
        },
    }[gameState.endReason] ?? {
        method: 'GAME RULE',
        detail: isDraw ? 'The game ended in a draw.' : 'The match is complete.',
    };

    return {detail: reason.detail, didWin, isDraw, method: reason.method, result};
};

function LiveClock({clock, color, gameStatus}) {
    const [now, setNow] = useState(() => Date.now());
    const isActive = gameStatus === 'InProgress' && clock?.activeColor === color;

    useEffect(() => {
        setNow(Date.now());
        if (!isActive) return undefined;

        const interval = setInterval(() => setNow(Date.now()), 100);
        return () => clearInterval(interval);
    }, [clock?.activeColor, clock?.updatedAtUnixMs, isActive]);

    const snapshot = remainingForColor(clock, color);
    const elapsed = isActive ? Math.max(0, now - (clock?.updatedAtUnixMs ?? now)) : 0;
    const remaining = Math.max(0, snapshot - elapsed);
    const isLow = remaining < LOW_TIME_MS;

    return (
        <View
            accessibilityLabel={`${color} clock, ${formatClock(remaining)}`}
            style={[
                styles.clock,
                isActive && styles.clockActive,
                isActive && isLow && styles.clockLow,
            ]}
        >
            <View
                style={[
                    styles.clockPulse,
                    isActive && styles.clockPulseActive,
                    isActive && isLow && styles.clockPulseLow,
                ]}
            />
            <Text
                style={[
                    styles.clockText,
                    isActive && styles.clockTextActive,
                    isActive && isLow && styles.clockTextLow,
                ]}
            >
                {formatClock(remaining)}
            </Text>
        </View>
    );
}

// `clock` is absent in a bot game, which has no time control at all, so whose
// turn it is comes from the position instead and no clock face is rendered.
function PlayerBar({
                       badge,
                       captured,
                       clock,
                       color,
                       fallbackLabel,
                       gameStatus,
                       isYou,
                       metaOverride,
                       profile,
                       turnColor,
                   }) {
    const isActive =
        gameStatus === 'InProgress' &&
        (clock ? clock.activeColor === color : turnColor === color);
    const label = fallbackLabel ?? (isYou ? 'You' : 'Opponent');
    const discord = profile?.discord?.trim();
    const activity = metaOverride ?? (isActive ? 'Thinking' : color);

    return (
        <View style={[styles.playerBar, isActive && styles.playerBarActive]}>
            <View style={[styles.avatar, color === 'Red' ? styles.redAvatar : styles.blueAvatar]}>
                <Text style={styles.avatarText}>{color.slice(0, 1)}</Text>
            </View>
            <View style={styles.playerCopy}>
                <View style={styles.playerNameRow}>
                    <Text style={styles.playerName} numberOfLines={1}>
                        {profileName(profile, label)}
                    </Text>
                    {isYou && <Text style={styles.youLabel}>YOU</Text>}
                    {Boolean(badge) && <Text style={styles.botLabel}>{badge}</Text>}
                </View>
                <Text style={[styles.playerMeta, isActive && styles.playerMetaActive]}>
                    {discord ? `Discord: ${discord} · ${activity}` : activity}
                </Text>
            </View>
            <CapturedPieces
                advantage={captured?.advantage ?? 0}
                color={otherColor(color)}
                tally={captured?.tally}
            />
            {Boolean(clock) && <LiveClock clock={clock} color={color} gameStatus={gameStatus}/>}
        </View>
    );
}

function OpponentReconnectNotice({deadline}) {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!deadline) return undefined;
        setNow(Date.now());
        const interval = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(interval);
    }, [deadline]);

    if (!deadline) return null;
    const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
    return (
        <View style={styles.reconnectNotice}>
            <View style={styles.reconnectDot}/>
            <View style={styles.reconnectCopy}>
                <Text style={styles.reconnectTitle}>Opponent disconnected</Text>
                <Text style={styles.reconnectDetail}>
                    Waiting {seconds}s before you win by abandonment.
                </Text>
            </View>
        </View>
    );
}

// Draw offers and time extensions are the same negotiation, so they share one
// notice: accept it, ignore it, or make a move to decline it.
function OfferNotice({acceptLabel, detail, disabled, onAccept, onDecline, title}) {
    return (
        <View style={styles.drawOfferNotice}>
            <View style={styles.drawOfferCopy}>
                <Text style={styles.drawOfferTitle}>{title}</Text>
                <Text style={styles.drawOfferDetail}>{detail}</Text>
            </View>
            <View style={styles.drawOfferButtons}>
                <Pressable
                    accessibilityRole="button"
                    disabled={disabled}
                    onPress={onDecline}
                    style={({pressed}) => [
                        styles.drawIgnoreButton,
                        disabled && styles.actionButtonDisabled,
                        pressed && styles.buttonPressed,
                    ]}
                >
                    <Text style={styles.drawIgnoreText}>Ignore</Text>
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    disabled={disabled}
                    onPress={onAccept}
                    style={({pressed}) => [
                        styles.drawAcceptButton,
                        disabled && styles.actionButtonDisabled,
                        pressed && styles.buttonPressed,
                    ]}
                >
                    <Text style={styles.drawAcceptText}>{acceptLabel}</Text>
                </Pressable>
            </View>
        </View>
    );
}

// An offer is available once per move, and only while neither side has one of
// that kind already on the table. `available` carries the rest: a draw needs
// your own turn, while extra time can be asked for at any point.
const offerAvailability = (offeredBy, usedBy, playerColor, available) => {
    const offeredByMe = offeredBy === playerColor;
    const usedThisMove = usedBy === playerColor;
    return {
        pending: offeredByMe || usedThisMove,
        disabled: !available || Boolean(offeredBy) || usedThisMove,
    };
};

function GameActions({
                         connected,
                         gameState,
                         isMyTurn,
                         onDraw,
                         onResign,
                         onTimeExtension,
                         playerColor,
                     }) {
    const draw = offerAvailability(
        gameState.drawOfferedBy,
        gameState.drawOfferUsedBy,
        playerColor,
        connected && isMyTurn,
    );
    const time = offerAvailability(
        gameState.timeOfferedBy,
        gameState.timeOfferUsedBy,
        playerColor,
        connected,
    );

    return (
        <View style={styles.gameActions}>
            <Pressable
                accessibilityRole="button"
                accessibilityState={{disabled: draw.disabled}}
                disabled={draw.disabled}
                onPress={onDraw}
                style={({pressed}) => [
                    styles.actionButton,
                    draw.disabled && styles.actionButtonDisabled,
                    pressed && styles.buttonPressed,
                ]}
            >
                <Text style={[styles.actionButtonText, draw.disabled && styles.actionButtonTextDisabled]}>
                    {draw.pending ? 'Draw offered' : 'Offer draw'}
                </Text>
            </Pressable>
            <Pressable
                accessibilityRole="button"
                accessibilityState={{disabled: time.disabled}}
                disabled={time.disabled}
                onPress={onTimeExtension}
                style={({pressed}) => [
                    styles.actionButton,
                    time.disabled && styles.actionButtonDisabled,
                    pressed && styles.buttonPressed,
                ]}
            >
                <Text style={[styles.actionButtonText, time.disabled && styles.actionButtonTextDisabled]}>
                    {time.pending ? '+3 min asked' : 'Ask +3 min'}
                </Text>
            </Pressable>
            <Pressable
                accessibilityRole="button"
                accessibilityState={{disabled: !connected}}
                disabled={!connected}
                onPress={onResign}
                style={({pressed}) => [
                    styles.actionButton,
                    styles.resignButton,
                    !connected && styles.actionButtonDisabled,
                    pressed && styles.buttonPressed,
                ]}
            >
                <Text style={styles.resignButtonText}>Resign</Text>
            </Pressable>
        </View>
    );
}

// A bot game has no clock to extend and nothing riding on the result, so its
// controls are the ones a practice board actually wants: the engine's own
// suggestion, a way to take a move back, and the two ways to end the game.
function BotGameActions({
                            botName,
                            canUndo,
                            drawPending,
                            drawUsed,
                            hintShowing,
                            hintPending,
                            isMyTurn,
                            onDraw,
                            onHint,
                            onResign,
                            onUndo,
                        }) {
    const hintDisabled = !isMyTurn || hintPending;

    return (
        <View style={styles.botActions}>
            <View style={styles.gameActions}>
                <Pressable
                    accessibilityHint="Asks RPSFish for the strongest move in this position."
                    accessibilityLabel={hintShowing ? 'Hide the hint' : 'Show the best move'}
                    accessibilityRole="button"
                    accessibilityState={{disabled: hintDisabled}}
                    disabled={hintDisabled}
                    onPress={onHint}
                    style={({pressed}) => [
                        styles.actionButton,
                        styles.hintButton,
                        hintDisabled && styles.actionButtonDisabled,
                        pressed && styles.buttonPressed,
                    ]}
                >
                    <Text style={styles.hintButtonText}>
                        {hintPending ? 'Thinking…' : hintShowing ? 'Hide hint' : '◈ Hint'}
                    </Text>
                </Pressable>
                <Pressable
                    accessibilityHint="Takes back your last move and the bot's reply."
                    accessibilityLabel="Undo your last move"
                    accessibilityRole="button"
                    accessibilityState={{disabled: !canUndo}}
                    disabled={!canUndo}
                    onPress={onUndo}
                    style={({pressed}) => [
                        styles.actionButton,
                        !canUndo && styles.actionButtonDisabled,
                        pressed && canUndo && styles.buttonPressed,
                    ]}
                >
                    <Text style={[styles.actionButtonText, !canUndo && styles.actionButtonTextDisabled]}>
                        ← Undo
                    </Text>
                </Pressable>
            </View>
            <View style={styles.gameActions}>
                <Pressable
                    accessibilityLabel={`Offer ${botName} a draw`}
                    accessibilityRole="button"
                    accessibilityState={{disabled: drawUsed || !isMyTurn}}
                    disabled={drawUsed || !isMyTurn}
                    onPress={onDraw}
                    style={({pressed}) => [
                        styles.actionButton,
                        (drawUsed || !isMyTurn) && styles.actionButtonDisabled,
                        pressed && styles.buttonPressed,
                    ]}
                >
                    <Text
                        style={[
                            styles.actionButtonText,
                            (drawUsed || !isMyTurn) && styles.actionButtonTextDisabled,
                        ]}
                    >
                        {drawPending ? 'Asking…' : drawUsed ? 'Draw declined' : 'Offer draw'}
                    </Text>
                </Pressable>
                <Pressable
                    accessibilityLabel="Resign this bot game"
                    accessibilityRole="button"
                    onPress={onResign}
                    style={({pressed}) => [
                        styles.actionButton,
                        styles.resignButton,
                        pressed && styles.buttonPressed,
                    ]}
                >
                    <Text style={styles.resignButtonText}>Resign</Text>
                </Pressable>
            </View>
        </View>
    );
}

// Practising against a bot should not mean missing a real opponent. Every mode
// with someone waiting in matchmaking is offered here, and taking one up hands
// the board over to that match as soon as it is found.
function OpponentSearchNotice({isSearching, onCancel, onJoin, queuedForMs, waitingModes}) {
    if (isSearching) {
        return (
            <View style={styles.searchNotice}>
                <View style={styles.searchNoticeCopy}>
                    <Text style={styles.searchNoticeTitle}>Looking for a real opponent</Text>
                    <Text style={styles.searchNoticeDetail}>
                        Searching {Math.floor(queuedForMs / 1000)}s · keep playing the bot until
                        someone is found.
                    </Text>
                </View>
                <Pressable
                    accessibilityLabel="Cancel the matchmaking search"
                    accessibilityRole="button"
                    onPress={onCancel}
                    style={({pressed}) => [styles.searchNoticeButton, pressed && styles.buttonPressed]}
                >
                    <Text style={styles.searchNoticeButtonText}>CANCEL</Text>
                </Pressable>
            </View>
        );
    }

    if (waitingModes.length === 0) return null;
    const waiting = waitingModes.reduce((total, mode) => total + mode.waiting, 0);

    return (
        <View style={styles.searchNotice}>
            <View style={styles.searchNoticeCopy}>
                <Text style={styles.searchNoticeTitle}>
                    {waiting === 1 ? 'Someone wants a game' : `${waiting} players want a game`}
                </Text>
                <Text style={styles.searchNoticeDetail}>
                    Waiting in {waitingModes.map((mode) => mode.name).join(' · ')}
                </Text>
            </View>
            <View style={styles.searchNoticeButtons}>
                {waitingModes.map((mode) => (
                    <Pressable
                        accessibilityLabel={`Join the ${mode.name} queue`}
                        accessibilityRole="button"
                        key={mode.id}
                        onPress={() => onJoin(mode.id)}
                        style={({pressed}) => [
                            styles.searchNoticeJoin,
                            pressed && styles.buttonPressed,
                        ]}
                    >
                        <Text style={styles.searchNoticeJoinText}>{mode.shortCode} ▶</Text>
                    </Pressable>
                ))}
            </View>
        </View>
    );
}

function ConfirmResignModal({detail, onCancel, onConfirm, visible}) {
    const resignDetail = detail ?? 'Your opponent will win immediately.';

    return (
        <Modal
            animationType="fade"
            onRequestClose={onCancel}
            transparent
            visible={visible}
        >
            <View style={styles.modalBackdrop}>
                <View style={styles.confirmCard}>
                    <Text style={styles.confirmTitle}>Resign this game?</Text>
                    <Text style={styles.confirmDetail}>{resignDetail}</Text>
                    <View style={styles.confirmButtons}>
                        <Pressable
                            accessibilityRole="button"
                            onPress={onCancel}
                            style={({pressed}) => [styles.confirmCancel, pressed && styles.buttonPressed]}
                        >
                            <Text style={styles.confirmCancelText}>Keep playing</Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            onPress={onConfirm}
                            style={({pressed}) => [styles.confirmResign, pressed && styles.buttonPressed]}
                        >
                            <Text style={styles.confirmResignText}>Resign</Text>
                        </Pressable>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

function OutcomeModal({gameState, onRematch, onReview, onReturn, playerColor, visible}) {
    const outcome = outcomeFor(gameState, playerColor);
    const score = outcome.isDraw
        ? '½  —  ½'
        : gameState.winner === 'Red'
            ? '1  —  0'
            : '0  —  1';

    return (
        <Modal
            animationType="fade"
            onRequestClose={onReview}
            transparent
            visible={visible}
        >
            <View style={styles.modalBackdrop}>
                <View style={styles.outcomeCard}>
                    <Text style={styles.outcomeEyebrow}>GAME OVER</Text>
                    <Text
                        style={[
                            styles.outcomeTitle,
                            outcome.didWin && styles.outcomeTitleWin,
                            !outcome.didWin && !outcome.isDraw && styles.outcomeTitleLoss,
                        ]}
                    >
                        {outcome.result}
                    </Text>
                    <Text style={styles.outcomeScore}>{score}</Text>
                    <View style={styles.outcomeMethodBadge}>
                        <Text style={styles.outcomeMethod}>BY {outcome.method}</Text>
                    </View>
                    <Text style={styles.outcomeDetail}>{outcome.detail}</Text>
                    {Boolean(gameState.bot) && (
                        <Text style={styles.outcomeUnrated}>
                            Bot games are unrated — nothing was added to your record.
                        </Text>
                    )}
                    <View style={styles.outcomeButtons}>
                        <Pressable
                            accessibilityRole="button"
                            onPress={onReview}
                            style={({pressed}) => [styles.reviewButton, pressed && styles.buttonPressed]}
                        >
                            <Text style={styles.reviewButtonText}>Review board</Text>
                        </Pressable>
                        {Boolean(onRematch) && (
                            <Pressable
                                accessibilityLabel={`Play ${gameState.bot?.name} again`}
                                accessibilityRole="button"
                                onPress={onRematch}
                                style={({pressed}) => [
                                    styles.rematchButton,
                                    pressed && styles.buttonPressed,
                                ]}
                            >
                                <Text style={styles.rematchButtonText}>Play again</Text>
                            </Pressable>
                        )}
                        <Pressable
                            accessibilityRole="button"
                            onPress={onReturn}
                            style={({pressed}) => [styles.outcomeReturnButton, pressed && styles.buttonPressed]}
                        >
                            <Text style={styles.outcomeReturnText}>Back to modes</Text>
                        </Pressable>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

function StatusContent({botThinking, gameState, isMyTurn, isSpectating, playerColor, selectedTile}) {
    if (isSpectating) {
        if (gameState.status === 'Finished') {
            return gameState.winner === 'Neutral'
                ? {title: 'Game drawn', detail: 'The live match has ended.', tone: 'neutral'}
                : {
                    title: `${gameState.winner} won`,
                    detail: 'The live match has ended.',
                    tone: 'positive',
                };
        }
        return {
            title: `${gameState.currentTurn} to move`,
            detail: 'You are watching this game live.',
            tone: 'neutral',
        };
    }

    if (gameState.status === 'Finished') {
        const isDraw = gameState.winner === 'Neutral';
        const didWin = gameState.winner === playerColor;
        const title = isDraw ? 'Draw' : didWin ? 'You won' : 'Opponent won';
        const detail = outcomeFor(gameState, playerColor).detail;
        return {title, detail, tone: didWin ? 'positive' : isDraw ? 'neutral' : 'negative'};
    }

    if (!isMyTurn) {
        if (gameState.bot) {
            return {
                title: `${gameState.bot.name} is thinking`,
                detail: botThinking
                    ? 'RPSFish is searching in the background.'
                    : 'Its reply is on the way.',
                tone: 'neutral',
            };
        }
        return {title: "Opponent's move", detail: 'Their clock is running.', tone: 'neutral'};
    }

    if (selectedTile) {
        return {
            title: 'Choose a destination',
            detail: 'Tap a marked square or drag the piece there.',
            tone: 'positive',
        };
    }

    return {
        title: 'Your move',
        detail: 'Tap a piece or drag it to a legal square.',
        tone: 'positive',
    };
}

function StatusCard({
                        botThinking,
                        gameState,
                        isMyTurn,
                        isSpectating,
                        onReturn,
                        playerColor,
                        selectedTile,
                        wide,
                    }) {
    const status = StatusContent({
        botThinking,
        gameState,
        isMyTurn,
        isSpectating,
        playerColor,
        selectedTile,
    });
    const isFinished = gameState.status === 'Finished';

    return (
        <View style={[styles.statusCard, wide && styles.statusCardWide]}>
            <View style={styles.statusLead}>
                <View
                    style={[
                        styles.statusIcon,
                        status.tone === 'positive' && styles.statusIconPositive,
                        status.tone === 'negative' && styles.statusIconNegative,
                    ]}
                >
                    <View style={styles.statusIconCore}/>
                </View>
                <View style={styles.statusCopy}>
                    <Text style={styles.statusTitle}>{status.title}</Text>
                    <Text style={styles.statusDetail} numberOfLines={wide ? 3 : 1}>
                        {status.detail}
                    </Text>
                </View>
            </View>

            {isFinished || isSpectating ? (
                <Pressable
                    accessibilityRole="button"
                    onPress={onReturn}
                    style={({pressed}) => [styles.returnButton, pressed && styles.buttonPressed]}
                >
                    <Text style={styles.returnButtonText}>{isSpectating && !isFinished ? 'Leave' : 'Modes'}</Text>
                </Pressable>
            ) : (
                <View style={styles.moveBadge}>
                    <Text style={styles.moveBadgeLabel}>MOVE</Text>
                    <Text style={styles.moveBadgeValue}>{gameState.moveNumber + 1}</Text>
                </View>
            )}
        </View>
    );
}

export default function GameScreen({navigation}) {
    const {height, width} = useWindowDimensions();
    const [reviewedResultId, setReviewedResultId] = useState(null);
    const [showResignConfirmation, setShowResignConfirmation] = useState(false);
    const gameState = useGameStore((state) => state.gameState);
    const lastMove = useGameStore((state) => state.lastMove);
    const playerColor = useGameStore((state) => state.playerColor);
    const isSpectating = useGameStore((state) => state.isSpectating);
    const connectionStatus = useGameStore((state) => state.connectionStatus);
    const opponentReconnectDeadline = useGameStore(
        (state) => state.opponentReconnectDeadline,
    );
    const selectedTile = useGameStore((state) => state.selectedTile);
    const validMoves = useGameStore((state) => state.validMoves);
    const selectTile = useGameStore((state) => state.selectTile);
    const movePiece = useGameStore((state) => state.movePiece);
    const offerDraw = useGameStore((state) => state.offerDraw);
    const acceptDraw = useGameStore((state) => state.acceptDraw);
    const declineDraw = useGameStore((state) => state.declineDraw);
    const offerTimeExtension = useGameStore((state) => state.offerTimeExtension);
    const acceptTimeExtension = useGameStore((state) => state.acceptTimeExtension);
    const declineTimeExtension = useGameStore((state) => state.declineTimeExtension);
    const resignGame = useGameStore((state) => state.resignGame);
    const accountId = useGameStore((state) => state.accountId);
    const chatMessages = useGameStore((state) => state.chatMessages);
    const liveGames = useGameStore((state) => state.liveGames);
    const chatVisible = useGameStore((state) => state.chatVisible);
    const showSpectatorMessages = useGameStore((state) => state.showSpectatorMessages);
    const sendChat = useGameStore((state) => state.sendChat);
    const toggleChat = useGameStore((state) => state.toggleChat);
    const toggleSpectatorMessages = useGameStore(
        (state) => state.toggleSpectatorMessages,
    );
    const clearGame = useGameStore((state) => state.clearGame);
    const error = useGameStore((state) => state.error);
    const clearError = useGameStore((state) => state.clearError);
    const modes = useGameStore((state) => state.modes);
    const modeQueueCounts = useGameStore((state) => state.modeQueueCounts);
    const queue = useGameStore((state) => state.queue);
    const joinQueue = useGameStore((state) => state.joinQueue);
    const leaveQueue = useGameStore((state) => state.leaveQueue);
    const botSession = useGameStore((state) => state.botSession);
    const botHistoryLength = useGameStore((state) => state.botHistory.length);
    const requestBotHint = useGameStore((state) => state.requestBotHint);
    const undoBotMove = useGameStore((state) => state.undoBotMove);
    const restartBotGame = useGameStore((state) => state.restartBotGame);
    const tournamentCall = useTournamentCall();

    if (!gameState) {
        return (
            <SafeAreaView style={styles.safeArea}>
                <View style={styles.centered}>
                    <Text style={styles.emptyTitle}>No active match</Text>
                    <Text style={styles.emptyBody}>Return to the mode screen to find an opponent.</Text>
                    <Pressable
                        onPress={() => navigation.goBack()}
                        style={({pressed}) => [styles.emptyButton, pressed && styles.buttonPressed]}
                    >
                        <Text style={styles.emptyButtonText}>Choose a mode</Text>
                    </Pressable>
                </View>
            </SafeAreaView>
        );
    }

    const isWide = width >= 760 && width > height;
    const hasTerritory = gameState.mode.features?.includes('territory');
    const verticalAllowance = isWide ? 190 : hasTerritory ? 390 : 360;
    const horizontalAllowance = isWide ? 390 : 20;
    const boardSize = Math.floor(
        Math.max(
            190,
            Math.min(620, width - horizontalAllowance, height - verticalAllowance),
        ),
    );
    // A bot game is local: it needs no socket, shows no clock, and nothing it
    // does can change a rating.
    const bot = gameState.bot ?? null;
    const viewColor = isSpectating ? 'Red' : playerColor;
    const topColor = isSpectating ? 'Blue' : otherColor(playerColor);
    const bottomColor = isSpectating ? 'Red' : playerColor;
    const captured = capturedPieces(gameState);
    const topProfile = topColor === 'Red' ? gameState.redPlayer : gameState.bluePlayer;
    const bottomProfile = bottomColor === 'Red' ? gameState.redPlayer : gameState.bluePlayer;
    const isConnected = connectionStatus === 'connected';
    const isMyTurn =
        !isSpectating &&
        (isConnected || Boolean(bot)) &&
        gameState.status === 'InProgress' &&
        gameState.currentTurn === playerColor;
    const timeControlLabel = formatTimeControl(gameState.timeControl);
    const spectatorCount =
        liveGames.find((liveGame) => liveGame.gameId === gameState.gameId)?.spectatorCount ?? 0;
    // Modes with a real player waiting in matchmaking right now. Someone busy
    // with a bot should still get the chance to take that game.
    const waitingModes = bot
        ? modes
            .filter((mode) => (modeQueueCounts[mode.id] ?? 0) > 0)
            .map((mode) => ({
                id: mode.id,
                name: mode.name,
                shortCode: mode.shortCode,
                waiting: modeQueueCounts[mode.id],
            }))
        : [];
    const canAnswerOffers = !isSpectating && gameState.status === 'InProgress';
    const hasOpponentDrawOffer =
        canAnswerOffers && gameState.drawOfferedBy && gameState.drawOfferedBy !== playerColor;
    const hasOpponentTimeOffer =
        canAnswerOffers && gameState.timeOfferedBy && gameState.timeOfferedBy !== playerColor;
    const showOutcome =
        !isSpectating &&
        gameState.status === 'Finished' &&
        reviewedResultId !== gameState.gameId;

    const returnToModes = () => {
        clearGame();
        navigation.navigate('Lobby');
    };

    const confirmResign = () => {
        setShowResignConfirmation(false);
        resignGame();
    };

    const matchNotices = (
        <>
            {Boolean(bot) && (
                <OpponentSearchNotice
                    isSearching={queue.isSearching}
                    onCancel={leaveQueue}
                    onJoin={joinQueue}
                    queuedForMs={queue.queuedForMs}
                    waitingModes={waitingModes}
                />
            )}
            {Boolean(botSession?.drawNotice) && (
                <View style={styles.selfReconnectNotice}>
                    <Text style={styles.selfReconnectText}>{botSession.drawNotice}</Text>
                </View>
            )}
            {Boolean(botSession?.engineError) && (
                <View style={styles.selfReconnectNotice}>
                    <Text style={styles.selfReconnectText}>{botSession.engineError}</Text>
                </View>
            )}
            {!bot && !isConnected && gameState.status === 'InProgress' && (
                <View style={styles.selfReconnectNotice}>
                    <Text style={styles.selfReconnectText}>
                        {isSpectating ? 'Reconnecting to the live game…' : 'Reconnecting to your match…'}
                    </Text>
                </View>
            )}
            {!isSpectating && !bot && (
                <OpponentReconnectNotice deadline={opponentReconnectDeadline}/>
            )}
            {hasOpponentDrawOffer && (
                <OfferNotice
                    acceptLabel="Accept"
                    detail="Accept, ignore, or keep playing to decline."
                    disabled={!isConnected}
                    onAccept={acceptDraw}
                    onDecline={declineDraw}
                    title="Draw offered"
                />
            )}
            {hasOpponentTimeOffer && (
                <OfferNotice
                    acceptLabel="Add time"
                    detail="Both clocks gain three minutes if you agree."
                    disabled={!isConnected}
                    onAccept={acceptTimeExtension}
                    onDecline={declineTimeExtension}
                    title="Extra time requested"
                />
            )}
        </>
    );

    const gameActions =
        isSpectating || gameState.status !== 'InProgress' ? null : bot ? (
            <BotGameActions
                botName={bot.name}
                canUndo={botHistoryLength > 0}
                drawPending={gameState.drawOfferedBy === playerColor}
                drawUsed={gameState.drawOfferUsedBy === playerColor}
                hintPending={Boolean(botSession?.hintPending)}
                hintShowing={Boolean(botSession?.hint)}
                isMyTurn={isMyTurn}
                onDraw={offerDraw}
                onHint={requestBotHint}
                onResign={() => setShowResignConfirmation(true)}
                onUndo={undoBotMove}
            />
        ) : (
            <GameActions
                connected={isConnected}
                gameState={gameState}
                isMyTurn={isMyTurn}
                onDraw={offerDraw}
                onResign={() => setShowResignConfirmation(true)}
                onTimeExtension={offerTimeExtension}
                playerColor={playerColor}
            />
        );

    const hint = bot ? botSession?.hint ?? null : null;
    const playerBars = (
        <>
            <PlayerBar
                badge={bot && topColor === bot.color ? 'BOT' : null}
                captured={captured[topColor]}
                clock={gameState.clock}
                color={topColor}
                fallbackLabel={isSpectating ? `${topColor} player` : 'Opponent'}
                gameStatus={gameState.status}
                isYou={false}
                metaOverride={
                    bot && topColor === bot.color
                        ? `Level ${bot.rating} · ${
                            gameState.currentTurn === bot.color ? 'thinking' : 'waiting'
                        }`
                        : undefined
                }
                profile={topProfile}
                turnColor={gameState.currentTurn}
            />
            <Board
                analysisArrows={hint ? [hint] : []}
                boardSize={boardSize}
                canMove={isMyTurn}
                grid={gameState.grid}
                lastMove={lastMove}
                modeId={gameState.mode.id}
                onPieceDrop={movePiece}
                onTilePress={selectTile}
                playerColor={viewColor}
                selectedTile={selectedTile}
                validMoves={validMoves}
            />
            <PlayerBar
                badge={bot && bottomColor === bot.color ? 'BOT' : null}
                captured={captured[bottomColor]}
                clock={gameState.clock}
                color={bottomColor}
                fallbackLabel={isSpectating ? `${bottomColor} player` : 'You'}
                gameStatus={gameState.status}
                isYou={!isSpectating}
                profile={bottomProfile}
                turnColor={gameState.currentTurn}
            />
        </>
    );

    // Nobody is listening on the other side of a bot game, so it has no chat.
    const gameChat = bot ? null : (
        <GameChat
            accountId={accountId}
            chatVisible={chatVisible}
            connected={isConnected}
            gameStatus={gameState.status}
            isSpectating={isSpectating}
            messages={chatMessages}
            onSend={sendChat}
            onToggleChat={toggleChat}
            onToggleSpectatorMessages={toggleSpectatorMessages}
            showSpectatorMessages={showSpectatorMessages}
            spectatorCount={spectatorCount}
            wide={isWide}
        />
    );

    return (
        <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
            <View style={styles.screen}>
                <View style={styles.topBar}>
                    <View style={styles.matchIdentity}>
                        <Text style={styles.matchKicker}>
                            {gameState.mode.shortCode} ·{' '}
                            {gameState.status === 'Finished'
                                ? 'FINAL'
                                : bot
                                    ? 'BOT GAME · UNRATED'
                                    : isSpectating
                                        ? 'SPECTATING LIVE'
                                        : 'LIVE MATCH'}
                        </Text>
                        <Text style={styles.modeName}>{gameState.mode.name}</Text>
                    </View>
                    <View style={styles.timeControlBadge}>
                        <Text style={styles.timeControlLabel}>{bot ? 'OPPONENT' : 'TIME CONTROL'}</Text>
                        <Text style={styles.timeControlValue} numberOfLines={1}>
                            {bot ? bot.name : timeControlLabel}
                        </Text>
                    </View>
                </View>

                {isWide ? (
                    <View style={styles.wideLayout}>
                        <View style={styles.playColumn}>{playerBars}</View>
                        <ScrollView
                            contentContainerStyle={[
                                styles.sidePanelContent,
                                Boolean(tournamentCall) && styles.calloutClearance,
                            ]}
                            keyboardShouldPersistTaps="handled"
                            showsVerticalScrollIndicator={false}
                            style={[styles.sidePanel, {height: boardSize + 120}]}
                        >
                            <StatusCard
                                botThinking={Boolean(botSession?.thinking)}
                                gameState={gameState}
                                isMyTurn={isMyTurn}
                                isSpectating={isSpectating}
                                onReturn={returnToModes}
                                playerColor={playerColor}
                                selectedTile={selectedTile}
                                wide
                            />

                            {matchNotices}
                            {gameActions}

                            {hasTerritory && <TerritoryMeter grid={gameState.grid}/>}

                            {gameChat}

                            {!chatVisible && (
                                <>
                                    <View style={styles.detailCard}>
                                        <Text style={styles.detailEyebrow}>OBJECTIVE</Text>
                                        <Text style={styles.detailTitle}>{gameState.mode.description}</Text>
                                        <Text style={styles.detailBody}>{gameState.mode.objective}</Text>
                                    </View>

                                    <View style={styles.matchFacts}>
                                        <View>
                                            <Text style={styles.factLabel}>MOVE</Text>
                                            <Text style={styles.factValue}>{gameState.moveNumber + 1}</Text>
                                        </View>
                                        <View style={styles.factDivider}/>
                                        <View>
                                            <Text style={styles.factLabel}>CLOCK</Text>
                                            <Text style={styles.factValue}>{timeControlLabel}</Text>
                                        </View>
                                    </View>
                                </>
                            )}
                        </ScrollView>
                    </View>
                ) : (
                    <ScrollView
                        contentContainerStyle={[
                            styles.mobileLayout,
                            Boolean(tournamentCall) && styles.calloutClearance,
                        ]}
                        keyboardShouldPersistTaps="handled"
                        showsVerticalScrollIndicator={false}
                    >
                        {playerBars}
                        {hasTerritory && <TerritoryMeter grid={gameState.grid}/>}
                        {matchNotices}
                        {gameActions}
                        {gameChat}
                        <StatusCard
                            botThinking={Boolean(botSession?.thinking)}
                            gameState={gameState}
                            isMyTurn={isMyTurn}
                            isSpectating={isSpectating}
                            onReturn={returnToModes}
                            playerColor={playerColor}
                            selectedTile={selectedTile}
                        />
                    </ScrollView>
                )}

                {error && (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Dismiss error"
                        onPress={clearError}
                        style={styles.errorBanner}
                    >
                        <Text style={styles.errorText}>{error}</Text>
                        <Text style={styles.errorDismiss}>×</Text>
                    </Pressable>
                )}

                {!isSpectating && (
                    <>
                        <ConfirmResignModal
                            detail={
                                bot
                                    ? `${bot.name} wins this practice game. Nothing is recorded.`
                                    : undefined
                            }
                            onCancel={() => setShowResignConfirmation(false)}
                            onConfirm={confirmResign}
                            visible={showResignConfirmation}
                        />
                        <OutcomeModal
                            gameState={gameState}
                            onRematch={
                                bot
                                    ? () => {
                                        setReviewedResultId(null);
                                        restartBotGame();
                                    }
                                    : null
                            }
                            onReview={() => setReviewedResultId(gameState.gameId)}
                            onReturn={returnToModes}
                            playerColor={playerColor}
                            visible={showOutcome}
                        />
                    </>
                )}
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safeArea: {flex: 1, backgroundColor: colors.background},
    screen: {
        flex: 1,
        width: '100%',
        maxWidth: 1180,
        alignSelf: 'center',
        paddingHorizontal: 10,
        paddingTop: 7,
        paddingBottom: 8,
    },
    centered: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24},
    // Room for the floating tournament call to action.
    calloutClearance: {paddingBottom: 88},
    emptyTitle: {color: colors.textStrong, fontSize: 25, fontWeight: '900'},
    emptyBody: {color: colors.textMuted, marginTop: 8, textAlign: 'center'},
    emptyButton: {
        marginTop: 22,
        paddingHorizontal: 18,
        paddingVertical: 11,
        borderRadius: radius.medium,
        backgroundColor: colors.accent,
    },
    emptyButtonText: {color: colors.textStrong, fontWeight: '900'},
    buttonPressed: {opacity: 0.72},
    topBar: {
        minHeight: 47,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 7,
        paddingHorizontal: 4,
    },
    // Takes the slack in the top bar so a long mode name cannot squeeze the
    // time-control badge.
    matchIdentity: {flex: 1, minWidth: 0, paddingRight: 10},
    matchKicker: {
        color: colors.accentBright,
        fontSize: 8,
        fontWeight: '900',
        letterSpacing: 1.4,
    },
    modeName: {color: colors.textStrong, fontSize: 20, fontWeight: '900', marginTop: 2},
    timeControlBadge: {
        minWidth: 88,
        alignItems: 'flex-end',
        paddingHorizontal: 11,
        paddingVertical: 7,
        borderRadius: radius.medium,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
    },
    timeControlLabel: {
        color: colors.textFaint,
        fontSize: 7,
        fontWeight: '900',
        letterSpacing: 1.1,
    },
    timeControlValue: {
        color: colors.textStrong,
        fontSize: 15,
        fontWeight: '900',
        marginTop: 1,
    },
    mobileLayout: {flexGrow: 1, alignItems: 'center', gap: 7, paddingBottom: 4},
    wideLayout: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'center',
        gap: 18,
    },
    playColumn: {alignItems: 'center', gap: 7},
    sidePanel: {width: 310},
    sidePanelContent: {gap: 10, paddingBottom: 2},
    playerBar: {
        width: '100%',
        minHeight: 50,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 5,
        borderRadius: radius.small,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    playerBarActive: {
        borderColor: colors.accentBorder,
        backgroundColor: colors.accentSurface,
    },
    avatar: {
        width: 35,
        height: 35,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.medium,
        borderWidth: 1,
    },
    redAvatar: {
        backgroundColor: players.Red.surface,
        borderColor: players.Red.border,
    },
    blueAvatar: {
        backgroundColor: players.Blue.surface,
        borderColor: players.Blue.border,
    },
    avatarText: {color: colors.textStrong, fontSize: 14, fontWeight: '900'},
    playerCopy: {flex: 1, minWidth: 0, paddingHorizontal: 9},
    playerNameRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
    playerName: {maxWidth: '75%', color: colors.text, fontSize: 13, fontWeight: '800'},
    youLabel: {
        color: colors.accentBright,
        fontSize: 7,
        fontWeight: '900',
        letterSpacing: 1,
    },
    botLabel: {
        color: colors.goldBright,
        fontSize: 7,
        fontWeight: '900',
        letterSpacing: 1,
        paddingHorizontal: 4,
        paddingVertical: 2,
        borderRadius: radius.small,
        backgroundColor: colors.goldSurface,
    },
    playerMeta: {color: colors.textFaint, fontSize: 9, fontWeight: '700', marginTop: 2},
    playerMetaActive: {color: colors.accentSoft},
    clock: {
        minWidth: 100,
        minHeight: 40,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 7,
        paddingHorizontal: 11,
        borderRadius: radius.small,
        backgroundColor: clockColors.idleSurface,
    },
    clockActive: {backgroundColor: clockColors.activeSurface},
    clockLow: {backgroundColor: clockColors.lowSurface},
    clockPulse: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: clockColors.idlePulse,
    },
    clockPulseActive: {backgroundColor: clockColors.activePulse},
    clockPulseLow: {backgroundColor: clockColors.lowPulse},
    clockText: {
        color: clockColors.idleText,
        fontSize: 22,
        fontWeight: '800',
        fontVariant: ['tabular-nums'],
        letterSpacing: -0.6,
    },
    clockTextActive: {color: clockColors.activeText},
    clockTextLow: {color: clockColors.lowText},
    selfReconnectNotice: {
        width: '100%',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: radius.medium,
        borderWidth: 1,
        borderColor: colors.goldBorder,
        backgroundColor: colors.goldSurfaceDeep,
    },
    selfReconnectText: {color: colors.goldBright, fontSize: 10, fontWeight: '800'},
    reconnectNotice: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 11,
        paddingVertical: 9,
        borderRadius: radius.medium,
        borderWidth: 1,
        borderColor: colors.goldBorder,
        backgroundColor: colors.goldSurfaceDeep,
    },
    reconnectDot: {
        width: 7,
        height: 7,
        borderRadius: 4,
        marginRight: 9,
        backgroundColor: colors.goldDot,
    },
    reconnectCopy: {flex: 1},
    reconnectTitle: {color: colors.goldBright, fontSize: 10, fontWeight: '900'},
    reconnectDetail: {color: colors.goldMuted, fontSize: 8, marginTop: 2},
    drawOfferNotice: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: radius.medium,
        borderWidth: 1,
        borderColor: colors.accentBorder,
        backgroundColor: colors.accentSurface,
    },
    drawOfferCopy: {flex: 1, minWidth: 0},
    drawOfferTitle: {color: colors.textStrong, fontSize: 10, fontWeight: '900'},
    drawOfferDetail: {color: colors.accentSoft, fontSize: 8, marginTop: 2},
    drawOfferButtons: {flexDirection: 'row', gap: 5},
    drawIgnoreButton: {
        paddingHorizontal: 9,
        paddingVertical: 7,
        borderRadius: radius.small,
        backgroundColor: colors.surfaceMuted,
    },
    drawIgnoreText: {color: colors.textSoft, fontSize: 9, fontWeight: '800'},
    drawAcceptButton: {
        paddingHorizontal: 9,
        paddingVertical: 7,
        borderRadius: radius.small,
        backgroundColor: colors.accent,
    },
    drawAcceptText: {color: colors.textStrong, fontSize: 9, fontWeight: '900'},
    gameActions: {width: '100%', flexDirection: 'row', gap: 7},
    // Four bot controls do not fit one comfortable row on a phone, so they sit
    // in two: what the engine can do for you, then how the game ends.
    botActions: {width: '100%', gap: 7},
    hintButton: {
        borderColor: colors.accentBorder,
        backgroundColor: colors.accentSurface,
    },
    hintButtonText: {color: colors.accentSoft, fontSize: 10, fontWeight: '900'},
    searchNotice: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: radius.medium,
        borderWidth: 1,
        borderColor: colors.liveBorder,
        backgroundColor: colors.liveSurface,
    },
    searchNoticeCopy: {flex: 1, minWidth: 0},
    searchNoticeTitle: {color: colors.textStrong, fontSize: 10, fontWeight: '900'},
    searchNoticeDetail: {color: colors.liveSoft, fontSize: 8, marginTop: 2},
    searchNoticeButtons: {flexDirection: 'row', gap: 5},
    searchNoticeJoin: {
        paddingHorizontal: 9,
        paddingVertical: 7,
        borderRadius: radius.small,
        backgroundColor: colors.accent,
    },
    searchNoticeJoinText: {color: colors.textStrong, fontSize: 9, fontWeight: '900'},
    searchNoticeButton: {
        paddingHorizontal: 9,
        paddingVertical: 7,
        borderRadius: radius.small,
        backgroundColor: colors.surfaceMuted,
    },
    searchNoticeButtonText: {color: colors.textSoft, fontSize: 9, fontWeight: '800'},
    actionButton: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 36,
        paddingHorizontal: 12,
        borderRadius: radius.small,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        backgroundColor: colors.surfaceRaised,
    },
    actionButtonDisabled: {opacity: 0.42},
    actionButtonText: {color: colors.textSoft, fontSize: 10, fontWeight: '900'},
    actionButtonTextDisabled: {color: colors.textFaint},
    resignButton: {
        borderColor: colors.dangerBorder,
        backgroundColor: colors.dangerSurfaceQuiet,
    },
    resignButtonText: {color: colors.dangerSoft, fontSize: 10, fontWeight: '900'},
    statusCard: {
        width: '100%',
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: radius.large,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
    },
    statusCardWide: {
        minHeight: 112,
        alignItems: 'flex-start',
        padding: 14,
    },
    statusLead: {flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0},
    statusIcon: {
        width: 27,
        height: 27,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 14,
        backgroundColor: colors.surfaceMuted,
    },
    statusIconPositive: {backgroundColor: colors.accentSurfaceRaised},
    statusIconNegative: {backgroundColor: colors.dangerSurface},
    statusIconCore: {
        width: 7,
        height: 7,
        borderRadius: 4,
        backgroundColor: colors.textStrong,
    },
    statusCopy: {flex: 1, minWidth: 0, marginLeft: 9},
    statusTitle: {color: colors.textStrong, fontSize: 13, fontWeight: '900'},
    statusDetail: {color: colors.textMuted, fontSize: 9, lineHeight: 13, marginTop: 2},
    moveBadge: {alignItems: 'flex-end', paddingLeft: 4},
    moveBadgeLabel: {
        color: colors.textFaint,
        fontSize: 7,
        fontWeight: '900',
        letterSpacing: 1,
    },
    moveBadgeValue: {color: colors.textSoft, fontSize: 17, fontWeight: '900'},
    returnButton: {
        paddingHorizontal: 13,
        paddingVertical: 8,
        borderRadius: radius.small,
        backgroundColor: colors.accent,
    },
    returnButtonText: {color: colors.textStrong, fontSize: 11, fontWeight: '900'},
    detailCard: {
        padding: 15,
        borderRadius: radius.large,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
    },
    detailEyebrow: {
        color: colors.accentBright,
        fontSize: 8,
        fontWeight: '900',
        letterSpacing: 1.3,
    },
    detailTitle: {color: colors.textStrong, fontSize: 18, fontWeight: '900', marginTop: 8},
    detailBody: {color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 5},
    matchFacts: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 14,
        borderRadius: radius.large,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
    },
    factLabel: {
        color: colors.textFaint,
        fontSize: 7,
        fontWeight: '900',
        letterSpacing: 1.1,
    },
    factValue: {color: colors.textSoft, fontSize: 16, fontWeight: '900', marginTop: 3},
    factDivider: {
        width: 1,
        height: 30,
        marginHorizontal: 22,
        backgroundColor: colors.border,
    },
    errorBanner: {
        position: 'absolute',
        right: 12,
        bottom: 12,
        left: 12,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 13,
        paddingVertical: 10,
        borderRadius: radius.medium,
        backgroundColor: colors.dangerSurface,
        boxShadow: shadows.banner,
        elevation: 9,
    },
    errorText: {flex: 1, color: colors.dangerText, fontSize: 11, fontWeight: '700'},
    errorDismiss: {color: colors.dangerText, fontSize: 19, paddingHorizontal: 4},
    modalBackdrop: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 22,
        backgroundColor: overlay,
    },
    confirmCard: {
        width: '100%',
        maxWidth: 360,
        padding: 20,
        borderRadius: radius.large,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        backgroundColor: colors.surface,
        boxShadow: shadows.modal,
        elevation: 18,
    },
    confirmTitle: {color: colors.textStrong, fontSize: 20, fontWeight: '900'},
    confirmDetail: {color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 7},
    confirmButtons: {flexDirection: 'row', gap: 8, marginTop: 20},
    confirmCancel: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 11,
        borderRadius: radius.medium,
        backgroundColor: colors.surfaceMuted,
    },
    confirmCancelText: {color: colors.textSoft, fontSize: 11, fontWeight: '900'},
    confirmResign: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 11,
        borderRadius: radius.medium,
        backgroundColor: colors.danger,
    },
    confirmResignText: {color: colors.textStrong, fontSize: 11, fontWeight: '900'},
    outcomeCard: {
        width: '100%',
        maxWidth: 390,
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingTop: 24,
        paddingBottom: 20,
        borderRadius: radius.xlarge,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        backgroundColor: colors.surface,
        boxShadow: shadows.modal,
        elevation: 20,
    },
    outcomeEyebrow: {
        color: colors.textFaint,
        fontSize: 8,
        fontWeight: '900',
        letterSpacing: 1.7,
    },
    outcomeTitle: {color: colors.textStrong, fontSize: 32, fontWeight: '900', marginTop: 9},
    outcomeTitleWin: {color: colors.accentBright},
    outcomeTitleLoss: {color: colors.dangerSoft},
    outcomeScore: {
        color: colors.textSoft,
        fontSize: 22,
        fontWeight: '900',
        fontVariant: ['tabular-nums'],
        marginTop: 8,
    },
    outcomeMethodBadge: {
        marginTop: 14,
        paddingHorizontal: 11,
        paddingVertical: 6,
        borderRadius: radius.small,
        backgroundColor: colors.surfaceMuted,
    },
    outcomeMethod: {
        color: colors.textSubtle,
        fontSize: 8,
        fontWeight: '900',
        letterSpacing: 1.15,
    },
    outcomeDetail: {
        color: colors.textMuted,
        fontSize: 12,
        lineHeight: 18,
        marginTop: 13,
        textAlign: 'center',
    },
    outcomeUnrated: {
        color: colors.goldMuted,
        fontSize: 9,
        fontWeight: '800',
        marginTop: 9,
        textAlign: 'center',
    },
    outcomeButtons: {width: '100%', gap: 8, marginTop: 22},
    rematchButton: {
        alignItems: 'center',
        paddingVertical: 11,
        borderRadius: radius.medium,
        borderWidth: 1,
        borderColor: colors.accentBorder,
        backgroundColor: colors.accentSurface,
    },
    rematchButtonText: {color: colors.accentSoft, fontSize: 11, fontWeight: '900'},
    reviewButton: {
        alignItems: 'center',
        paddingVertical: 11,
        borderRadius: radius.medium,
        backgroundColor: colors.surfaceMuted,
    },
    reviewButtonText: {color: colors.textSoft, fontSize: 11, fontWeight: '900'},
    outcomeReturnButton: {
        alignItems: 'center',
        paddingVertical: 12,
        borderRadius: radius.medium,
        backgroundColor: colors.accent,
    },
    outcomeReturnText: {color: colors.textStrong, fontSize: 11, fontWeight: '900'},
});
