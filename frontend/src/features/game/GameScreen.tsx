import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import MoveAnalysisList from '@/features/analysis/MoveAnalysisList';
import ReplayControls from '@/features/analysis/ReplayControls';
import QuietMoveMeter from '@/features/analysis/QuietMoveMeter';
import TerritoryMeter from '@/features/analysis/TerritoryMeter';
import { NameThisOpening, OpeningBadge } from '@/features/openings/OpeningBadge';
import ReachPanel from '@/features/reach/ReachPanel';
import { useGameOpening } from '@/hooks/useGameOpening';
import { useReach } from '@/hooks/useReach';
import Board from '@/features/board/Board';
import BoardExportButton from '@/features/board/BoardExportButton';
import { colourResultLabel } from '@/features/game/resultLabels';
import type { ShareCardInput } from '@/features/board/export/shareCard';
import {usePieceDrag} from '@/features/board/pieceDrag';
import { capturedPieces } from '@/features/board/CapturedPieces';
import GameChat from './GameChat';
import GameTransition from './GameTransition';
import PlayerBar from './PlayerBar';
import SpectateRail from './SpectateRail';
import SpectateResultModal from './SpectateResultModal';
import ServerBanner from '@/features/shell/ServerBanner';
import type { GameOpening } from '@/engine/openingBook';
import { useBoardLayout } from '@/hooks/useBoardLayout';
import { useGameHistory } from '@/hooks/useGameHistory';
import { useReplayCursor } from '@/hooks/useReplayCursor';
import { useSettled } from '@/hooks/useSettled';
import { useSpectateContext } from '@/hooks/useSpectateContext';
import { useTournamentCall } from '@/hooks/useTournamentCall';
import { useWatchGame } from '@/hooks/useWatchGame';
import { links } from '@/navigation/links';
import { useGoTo } from '@/navigation/stack';
import { up } from '@/navigation/upFrom';
import { chatRoomScopeOf } from '@/store/chatSelectors';
import { useGameStore } from '@/store/gameStore';
import { firstMoveCall } from '@/store/queueSelectors';
import { useReviewHandoff } from '@/store/reviewHandoff';
import { ruleSummary } from '@/store/setupSelectors';
import { playerName } from '@/store/spectateSelectors';
import type { ActiveGame } from '@/store/types';
import { colors, radius, shadows, themedSheet, type } from '@/theme';
import BackLink from '@/ui/BackLink';
import KeyboardLift from '@/ui/KeyboardLift';
import { arrows } from '@/ui/arrows';
import {
  FIRST_TO_MOVE,
  opposingColor,
  type GameEndReason,
  type ModeDefinition,
  type ModeID,
  type PlayerColor,
  type Position,
  type SideColor,
  type TimeControl,
} from '@/types/game';

/** A mode with real players queueing in it, offered to somebody playing a bot. */
interface WaitingMode {
    id: ModeID;
    name: string;
    shortCode: string;
    waiting: number;
}

/**
 * The top bar's height, before anything has been measured.
 *
 * Only a starting guess: the header is measured below, because what sits in it
 * is not fixed. Starting from the plain case means a game with nothing extra up
 * there never resizes its board after the first paint.
 */
const HEADER_HEIGHT = 54;
/**
 * What the board's column holds besides the board: a player bar above and below
 * it, and `playColumn`'s gap on either side of it.
 *
 * A bar is `minHeight: 50` and draws at that height for every game this app has
 * been measured on — one row, whatever is in it, since the avatar, the two lines
 * of copy, the captured tray and the clock all fit inside fifty. The allowance
 * is a little over twice that so a bar that does come out taller has somewhere
 * to go: the board gives the room up, rather than the bottom bar going over the
 * edge.
 */
const PLAYER_BARS = 2 * 57 + 2 * 7;
/**
 * The page's own horizontal padding, and so the whole of the board's horizontal
 * chrome on a phone. Named because `useBoardLayout` has to be told it: the
 * board fills the width this leaves, and a phone board is bounded by width
 * alone, so the two must not drift apart.
 */
const PHONE_PADDING = 10;

const formatTimeControl = (timeControl: TimeControl | null | undefined) => {
    if (!timeControl) return 'Live';
    const initialMinutes = timeControl.initialTimeMs / 60_000;
    const incrementSeconds = timeControl.incrementMs / 1000;
    const initialLabel = Number.isInteger(initialMinutes)
        ? initialMinutes.toString()
        : initialMinutes.toFixed(1);
    return `${initialLabel} + ${incrementSeconds}`;
};

/** How a finished game reads to the person who played it. */
interface GameOutcome {
  detail: string;
  didWin: boolean;
  isDraw: boolean;
  method: string;
  result: string;
}

/**
 * The same outcome, for a board where "you" names both players.
 *
 * Every line below is written in the second person, which is right for a game
 * with somebody on the other end of it and meaningless at a local board: one
 * person made both sets of moves, so "you resigned" and "your opponent
 * resigned" are the same sentence. This says which colour instead.
 */
const localOutcomeFor = (gameState: ActiveGame): GameOutcome => {
    const isDraw = gameState.winner === 'Neutral';
    const winner = gameState.winner;
    const loser = winner === 'Red' ? 'Blue' : 'Red';
    const reasons: Partial<Record<GameEndReason, {method: string; detail: string}>> = {
        annihilation: {
            method: 'ANNIHILATION',
            detail: `${winner} captured every one of ${loser}'s pieces.`,
        },
        draw_agreement: {method: 'AGREEMENT', detail: 'The players agreed to a draw.'},
        repetition: {method: 'REPETITION', detail: 'The same position occurred three times.'},
        no_capture: {
            method: 'NO CAPTURE',
            detail: "100 moves without a capture.",
        },
        stalemate: {
            method: 'STALEMATE',
            // A draw in most modes and a loss in a race, so the card reads the
            // result off the game rather than restating the rule.
            detail: isDraw
                ? 'A player had no legal move, which is a draw.'
                : `${loser} had no legal move, which loses in this mode.`,
        },
        move_limit: {
            method: 'MOVE LIMIT',
            detail: "The game reached its move limit.",
        },
        infiltration: {
            method: 'INFILTRATION',
            detail: `${winner} reached ${loser}'s home boundary.`,
        },
        corner: {
            method: 'CORNER',
            detail: `${winner} reached ${loser}'s home corner.`,
        },
        resignation: {method: 'RESIGNATION', detail: `${loser} resigned.`},
        territory: {
            method: 'TERRITORY',
            detail: isDraw
                ? 'The board filled with equal territory.'
                : `${winner} controlled more territory when the board filled.`,
        },
    };
    const reason = reasons[gameState.endReason ?? 'game_rule'] ?? {
        method: 'GAME RULE',
        detail: isDraw ? 'The game ended in a draw.' : 'The game is complete.',
    };
    return {
        detail: reason.detail,
        // Nobody at this board won or lost — both players are here — so the
        // card is drawn in its neutral colours rather than green or red.
        didWin: false,
        isDraw,
        method: reason.method,
        result: isDraw ? 'Draw' : `${winner} won`,
    };
};

const outcomeFor = (gameState: ActiveGame, playerColor: PlayerColor | null): GameOutcome => {
    if (gameState.local) return localOutcomeFor(gameState);
    const isDraw = gameState.winner === 'Neutral';
    const didWin = gameState.winner === playerColor;
    const result = isDraw ? 'Draw' : didWin ? 'You won' : 'You lost';
    const reasons: Partial<Record<GameEndReason, {method: string; detail: string}>> = {
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
        no_capture: {
            method: 'NO CAPTURE',
            detail: "100 moves without a capture.",
        },
        stalemate: {
            method: 'STALEMATE',
            detail: isDraw
                ? 'A player had no legal move, which is a draw.'
                : didWin
                  ? 'Your opponent had no legal move, which loses in this mode.'
                  : 'You had no legal move, which loses in this mode.',
        },
        move_limit: {
            method: 'MOVE LIMIT',
            detail: "The game reached its move limit.",
        },
        infiltration: {
            method: 'INFILTRATION',
            detail: didWin
                ? "You reached your opponent's home boundary."
                : 'Your opponent reached your home boundary.',
        },
        corner: {
            method: 'CORNER',
            detail: didWin
                ? "You reached your opponent's home corner."
                : 'Your opponent reached your home corner.',
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
    };
    const reason = reasons[gameState.endReason ?? 'game_rule'] ?? {
        method: 'GAME RULE',
        detail: isDraw ? 'The game ended in a draw.' : 'The match is complete.',
    };

    return {detail: reason.detail, didWin, isDraw, method: reason.method, result};
};

function OpponentReconnectNotice({deadline}: {deadline: number | null}) {
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

/**
 * The board is open and nothing is ticking yet.
 *
 * A game is now seated the moment two seeks fit, whether or not either player
 * is looking at the screen, so the first thing a board has to be able to say is
 * "this has not started". Both clocks are whole, nothing is rated, and the
 * first move is what turns it into a game — or thirty seconds pass and it is
 * called off as though it never happened.
 *
 * It ticks at 250ms like the reconnect notice, for the same reason: a countdown
 * that stutters is a countdown nobody believes. It says what is happening and
 * nothing else — the way out is the button the action row is already showing in
 * the place a player looks for it, and two of them a centimetre apart is one
 * too many.
 */
function FirstMoveNotice({
                             deadline,
                             opponentName,
                             yours,
                         }: {
    deadline: number | null;
    opponentName: string | null;
    yours: boolean;
}) {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!deadline) return undefined;
        setNow(Date.now());
        const interval = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(interval);
    }, [deadline]);

    const call = firstMoveCall(deadline, yours, opponentName, now);
    if (!call) return null;
    return (
        <View style={[styles.reconnectNotice, call.critical && styles.firstMoveNoticeUrgent]}>
            <View style={[styles.reconnectDot, call.critical && styles.firstMoveDotUrgent]}/>
            <View style={styles.reconnectCopy}>
                <Text style={styles.reconnectTitle}>{call.title}</Text>
                <Text style={styles.reconnectDetail}>{call.detail}</Text>
            </View>
        </View>
    );
}

// Draw offers and time extensions are the same negotiation, so they share one
// notice: accept it, ignore it, or make a move to decline it.
interface OfferNoticeProps {
    acceptLabel: string;
    detail: string;
    disabled?: boolean;
    onAccept: () => void;
    onDecline: () => void;
    title: string;
}

function OfferNotice({acceptLabel, detail, disabled, onAccept, onDecline, title}: OfferNoticeProps) {
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
const offerAvailability = (
    offeredBy: PlayerColor | undefined,
    usedBy: PlayerColor | undefined,
    playerColor: PlayerColor | null,
    available: boolean,
) => {
    const offeredByMe = offeredBy === playerColor;
    const usedThisMove = usedBy === playerColor;
    return {
        pending: offeredByMe || usedThisMove,
        disabled: !available || Boolean(offeredBy) || usedThisMove,
    };
};

interface GameActionsProps {
    /** Nothing has been played yet, so leaving costs nothing. */
    awaitingFirstMove: boolean;
    connected: boolean;
    gameState: ActiveGame;
    isMyTurn: boolean;
    onAbort: () => void;
    onDraw: () => void;
    onResign: () => void;
    onTimeExtension: () => void;
    playerColor: PlayerColor | null;
}

function GameActions({
                         awaitingFirstMove,
                         connected,
                         gameState,
                         isMyTurn,
                         onAbort,
                         onDraw,
                         onResign,
                         onTimeExtension,
                         playerColor,
                     }: GameActionsProps) {
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
    // A custom game can drop either offer. Hidden rather than disabled: a
    // greyed-out button reads as "not yet", and these are never.
    const rules = gameState.rules ?? {};

    return (
        <View style={styles.gameActions}>
            {rules.noDrawOffers ? null : (
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
            )}
            {rules.noTimeExtensions ? null : (
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
            )}
            {/*
              Resigning a game nobody has played is a rated loss for nothing,
              and it is exactly the button somebody reaches for when a board
              they did not expect opens in front of them. Until the first move
              lands, the same place says what it actually does.
            */}
            <Pressable
                accessibilityRole="button"
                accessibilityState={{disabled: !connected}}
                disabled={!connected}
                onPress={awaitingFirstMove ? onAbort : onResign}
                style={({pressed}) => [
                    styles.actionButton,
                    styles.resignButton,
                    !connected && styles.actionButtonDisabled,
                    pressed && styles.buttonPressed,
                ]}
            >
                <Text style={styles.resignButtonText}>
                    {awaitingFirstMove ? 'Call it off' : 'Resign'}
                </Text>
            </Pressable>
        </View>
    );
}

// A bot game has no clock to extend and nothing riding on the result, so its
// controls are the ones a practice board actually wants: the engine's own
// suggestion, a way to take a move back, and the two ways to end the game.
interface BotGameActionsProps {
    botName: string;
    canUndo: boolean;
    drawPending: boolean;
    drawUsed: boolean;
    hintShowing: boolean;
    hintPending: boolean;
    isMyTurn: boolean;
    onDraw: () => void;
    onHint: () => void;
    onResign: () => void;
    onUndo: () => void;
    /** Absent in a mode with no goal row for the reach tool to measure against. */
    onReach?: () => void;
    reachShowing?: boolean;
}

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
                            onReach,
                            reachShowing = false,
                        }: BotGameActionsProps) {
    const hintDisabled = !isMyTurn || hintPending;

    return (
        <View style={styles.botActions}>
            <View style={styles.gameActions}>
                <Pressable
                    accessibilityHint="Ask RPSFish for a move."
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
                        {arrows.back} Undo
                    </Text>
                </Pressable>
                {onReach && (
                    <Pressable
                        accessibilityHint="Show travel distances and safe routes to the goal."
                        accessibilityLabel={reachShowing ? 'Hide the reach maps' : 'Show the reach maps'}
                        accessibilityRole="switch"
                        accessibilityState={{checked: reachShowing}}
                        onPress={onReach}
                        style={({pressed}) => [
                            styles.actionButton,
                            reachShowing && styles.reachButtonOn,
                            pressed && styles.buttonPressed,
                        ]}
                    >
                        <Text
                            style={[
                                styles.actionButtonText,
                                reachShowing && styles.reachButtonTextOn,
                            ]}
                        >
                            {reachShowing ? 'Hide reach' : '◇ Reach'}
                        </Text>
                    </Pressable>
                )}
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

// Two players at one device. Nothing is riding on the result and there is no
// clock, so the controls are the four a shared board actually wants: turn it
// round for the person on the other side, take back a move, and the two ways to
// stop. Notably absent is a hint: this is a game between two people, and one of
// them consulting RPSFish is cheating rather than practising.
interface LocalGameActionsProps {
    canUndo: boolean;
    onDraw: () => void;
    onFlip: () => void;
    onResign: () => void;
    onUndo: () => void;
    /** Whose turn it is, because the resign button says who is giving up. */
    turnColor: SideColor;
}

function LocalGameActions({
                              canUndo,
                              onDraw,
                              onFlip,
                              onResign,
                              onUndo,
                              turnColor,
                          }: LocalGameActionsProps) {
    return (
        <View style={styles.botActions}>
            <View style={styles.gameActions}>
                <Pressable
                    accessibilityHint="View the board from the other side."
                    accessibilityLabel="Turn the board around"
                    accessibilityRole="button"
                    onPress={onFlip}
                    style={({pressed}) => [styles.actionButton, pressed && styles.buttonPressed]}
                >
                    <Text style={styles.actionButtonText}>⇅ Flip board</Text>
                </Pressable>
                <Pressable
                    accessibilityHint="Takes back the last move, whoever played it."
                    accessibilityLabel="Take back the last move"
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
                        {arrows.back} Undo
                    </Text>
                </Pressable>
            </View>
            <View style={styles.gameActions}>
                <Pressable
                    accessibilityHint="Ends the game as a draw."
                    accessibilityLabel="Agree a draw"
                    accessibilityRole="button"
                    onPress={onDraw}
                    style={({pressed}) => [styles.actionButton, pressed && styles.buttonPressed]}
                >
                    <Text style={styles.actionButtonText}>Agree a draw</Text>
                </Pressable>
                <Pressable
                    accessibilityLabel={`Resign as ${turnColor}`}
                    accessibilityRole="button"
                    onPress={onResign}
                    style={({pressed}) => [
                        styles.actionButton,
                        styles.resignButton,
                        pressed && styles.buttonPressed,
                    ]}
                >
                    <Text style={styles.resignButtonText}>{turnColor} resigns</Text>
                </Pressable>
            </View>
        </View>
    );
}

// Practising against a bot should not mean missing a real opponent. Every mode
// with someone waiting in matchmaking is offered here, and taking one up hands
// the board over to that match as soon as it is found.
interface OpponentSearchNoticeProps {
    onJoin: (modeId: ModeID) => void;
    /** Modes with somebody waiting *and at the keyboard* right now. */
    waitingModes: WaitingMode[];
}

// Somebody practising against a bot, told that a real opponent is available.
//
// This used to carry the search state too, which is now the floating bar's job
// on every screen rather than this one's. What is left is the half that is a
// nudge on a page you are already looking at, rather than a notification — so
// the rule that this server sends exactly one kind of notification is untouched.
function OpponentSearchNotice({onJoin, waitingModes}: OpponentSearchNoticeProps) {
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

interface ConfirmResignModalProps {
    detail?: string;
    onCancel: () => void;
    onConfirm: () => void;
    visible: boolean;
}

function ConfirmResignModal({detail, onCancel, onConfirm, visible}: ConfirmResignModalProps) {
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

interface FinishedGameCardProps {
    canReview: boolean;
    gameState: ActiveGame;
    /** The opening just played, for the line of it nobody has named. */
    opening: GameOpening | null;
    /** Absent for a game that cannot be replayed, such as a spectated one. */
    onRematch?: (() => void) | null;
    onReviewGame: () => void;
    onReturn: () => void;
    playerColor: PlayerColor | null;
    wide?: boolean;
}

function FinishedGameCard({
                              canReview,
                              gameState,
                              opening,
                              onRematch,
                              onReviewGame,
                              onReturn,
                              playerColor,
                              wide,
                          }: FinishedGameCardProps) {
    const outcome = outcomeFor(gameState, playerColor);
    const score = outcome.isDraw
        ? '½  ·  ½'
        : gameState.winner === 'Red'
            ? '1  ·  0'
            : '0  ·  1';

    return (
        <View
            accessibilityLiveRegion="polite"
            style={[styles.finishedCard, wide && styles.finishedCardWide]}
        >
            <View style={styles.finishedSummary}>
                <View style={styles.finishedResult}>
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
                </View>
                <View style={styles.finishedScoreBlock}>
                    <Text style={styles.finishedScoreLabel}>FINAL</Text>
                    <Text style={styles.outcomeScore}>{score}</Text>
                </View>
            </View>
            <View style={styles.outcomeReason}>
                <View style={styles.outcomeMethodBadge}>
                    <Text style={styles.outcomeMethod}>BY {outcome.method}</Text>
                </View>
                <Text style={styles.outcomeDetail}>{outcome.detail}</Text>
            </View>
            {/* These don't look good. Too much unuseful information. */}
            {/*{Boolean(gameState.bot) && (*/}
            {/*    <Text style={styles.outcomeUnrated}>*/}
            {/*        Bot games are unrated. Nothing was added to your record.*/}
            {/*    </Text>*/}
            {/*)}*/}
            {/*{Boolean(gameState.local) && (*/}
            {/*    <Text style={styles.outcomeUnrated}>*/}
            {/*        Local games are unrated, and never left this device.*/}
            {/*    </Text>*/}
            {/*)}*/}
            {/*
              The book's names come from the people who play the lines, and
              this is the moment somebody has just played one. Above the review
              button because it is about the game that happened; the review is
              already the way off this screen.
            */}
            <NameThisOpening modeId={gameState.mode.id} opening={opening}/>
            {canReview && (
                <Pressable
                    accessibilityHint="Opens a move-by-move replay of this game."
                    accessibilityRole="button"
                    onPress={onReviewGame}
                    style={({pressed}) => [styles.reviewGameButton, pressed && styles.buttonPressed]}
                >
                    <View style={styles.reviewGameCopy}>
                        <Text style={styles.reviewGameButtonText}>Review game</Text>
                        <Text style={styles.reviewGameButtonDetail}>
                            Replay it move by move, and try your own lines
                        </Text>
                    </View>
                    <Text style={styles.reviewGameButtonArrow}>→</Text>
                </Pressable>
            )}
            <View style={styles.finishedActions}>
                {Boolean(onRematch) && (
                    <Pressable
                        accessibilityLabel={
                            gameState.bot ? `Play ${gameState.bot.name} again` : 'Play again'
                        }
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
                    style={({pressed}) => [styles.finishedModesButton, pressed && styles.buttonPressed]}
                >
                    <Text style={styles.finishedModesButtonText}>Return to lobby</Text>
                </Pressable>
            </View>
        </View>
    );
}

/** What the status card should say, and how urgently. */
interface StatusMessage {
    title: string;
    detail: string;
    tone: 'neutral' | 'positive' | 'negative' | 'waiting';
}

interface StatusContentProps {
    botThinking?: boolean;
    gameState: ActiveGame;
    isMyTurn: boolean;
    isSpectating: boolean;
    /**
     * Whether the board is showing an earlier position rather than the game.
     *
     * First, because it is the only thing worth saying when it is true. This
     * card is otherwise about whose turn it is, and "Your move · tap a piece"
     * over a board that has been stepped back is a instruction that does not
     * apply to what is on the screen.
     */
    lookingBack: boolean;
    playerColor: PlayerColor | null;
    selectedTile: Position | null;
}

function StatusContent({
                           botThinking,
                           gameState,
                           isMyTurn,
                           isSpectating,
                           lookingBack,
                           playerColor,
                           selectedTile,
                       }: StatusContentProps): StatusMessage {
    if (lookingBack) {
        return {
            title: 'Looking back',
            detail:
                gameState.status === 'InProgress'
                    ? "Press → or tap the board to return to live play."
                    : 'Stepping through the finished game.',
            tone: 'neutral',
        };
    }

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
        const outcome = outcomeFor(gameState, playerColor);
        if (gameState.local) {
            return {title: outcome.result, detail: outcome.detail, tone: 'neutral'};
        }
        const didWin = gameState.winner === playerColor;
        const title = isDraw ? 'Draw' : didWin ? 'You won' : 'Opponent won';
        return {title, detail: outcome.detail, tone: didWin ? 'positive' : isDraw ? 'neutral' : 'negative'};
    }

    // Both players are here, so there is no such thing as the other person's
    // move: the card names the colour to play rather than an owner.
    if (gameState.local) {
        return {
            title: `${gameState.currentTurn} to move`,
            detail: selectedTile
                ? 'Tap a marked square or drag the piece there.'
                : 'Tap a piece or drag it to a legal square.',
            tone: 'positive',
        };
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
        // Only true once the game has begun. Before the first move both clocks
        // are stopped, and the notice below is already counting down the one
        // thing that *is* running.
        return {
            title: "Opponent's move",
            detail:
                gameState.clock?.activeColor === 'Neutral'
                    ? 'Nothing is on the clock until they play it.'
                    : 'Their clock is running.',
            tone: 'neutral',
        };
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

interface StatusCardProps extends StatusContentProps {
    canReview: boolean;
    opening: GameOpening | null;
    onRematch?: (() => void) | null;
    onReturn: () => void;
    onReviewGame: () => void;
    wide?: boolean;
}

function StatusCard({
                        botThinking,
                        canReview,
                        gameState,
                        isMyTurn,
                        isSpectating,
                        lookingBack,
                        opening,
                        onRematch,
                        onReturn,
                        onReviewGame,
                        playerColor,
                        selectedTile,
                        wide,
                    }: StatusCardProps) {
    if (gameState.status === 'Finished' && !isSpectating && !lookingBack) {
        return (
            <FinishedGameCard
                canReview={canReview}
                gameState={gameState}
                onRematch={onRematch}
                onReturn={onReturn}
                onReviewGame={onReviewGame}
                opening={opening}
                playerColor={playerColor}
                wide={wide}
            />
        );
    }

    const status = StatusContent({
        botThinking,
        gameState,
        isMyTurn,
        isSpectating,
        lookingBack,
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

            {/*
              What is left to *do* here, and nothing about leaving. The way out
              used to be a second button in this row — "Leave" while watching,
              "Return to lobby" once the game was over — which put the only exit
              from the board halfway down the right-hand panel, where nobody
              looks for one. It is the back button at the top left now, the same
              one every other page of this site carries.
            */}
            {isFinished && canReview ? (
                <View style={styles.statusActions}>
                    <Pressable
                        accessibilityLabel="Review game"
                        accessibilityRole="button"
                        onPress={onReviewGame}
                        style={({pressed}) => [styles.statusReviewButton, pressed && styles.buttonPressed]}
                    >
                        <Text style={styles.statusReviewText}>Review game</Text>
                    </Pressable>
                </View>
            ) : isFinished || isSpectating ? null : (
                <View style={styles.moveBadge}>
                    <Text style={styles.moveBadgeLabel}>MOVE</Text>
                    <Text style={styles.moveBadgeValue}>{gameState.moveNumber + 1}</Text>
                </View>
            )}
        </View>
    );
}

export default function GameScreen() {
    // A board fills the screen, so everything off it is a `dismissTo` rather
    // than a page laid on top — see `navigation/stack` for the pile that used
    // to build up here, two screens at a time.
    const go = useGoTo();
    const handReview = useReviewHandoff((state) => state.hand);
    const reviewOpeningRef = useRef(false);
    const [showResignConfirmation, setShowResignConfirmation] = useState(false);
    // Which game's result has been read and put away. Keyed by game rather
    // than a plain boolean, so the next board of a series brings its own
    // result up instead of inheriting the last one's dismissal.
    const [dismissedResultFor, setDismissedResultFor] = useState<string | null>(null);
    const gameState = useGameStore((state) => state.gameState);
    // The game this browser was in, remembered across a refresh. It is what
    // tells an empty screen whether a board is on its way back.
    const gameSessionId = useGameStore((state) => state.gameSessionId);
    const lastMove = useGameStore((state) => state.lastMove);
    const draggingPiece = usePieceDrag((state) => state.dragging);
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
    // Both bars celebrate the same grant, so it is read once here rather than
    // subscribed to twice.
    const timeExtension = useGameStore((state) => state.timeExtension);
    const declineTimeExtension = useGameStore((state) => state.declineTimeExtension);
    const resignGame = useGameStore((state) => state.resignGame);
    const abortGame = useGameStore((state) => state.abortGame);
    const firstMoveDeadline = useGameStore((state) => state.firstMoveDeadline);
    const accountId = useGameStore((state) => state.accountId);
    const chatMessages = useGameStore((state) => state.chatMessages);
    const chatRoomId = useGameStore((state) => state.chatRoomId);
    const chatRoomScope = useGameStore((state) => state.chatRoomScope);
    const chatOccupancy = useGameStore((state) => state.chatOccupancy);
    const liveGames = useGameStore((state) => state.liveGames);
    const spectatedGameId = useGameStore((state) => state.spectatedGameId);
    // The board that was taken away rather than finished, and why. Everything
    // else that empties this screen leaves something to go and look at — a
    // result, a record, a game still loading. A cancelled game leaves nothing
    // at all, so the reason is the only thing there is to show.
    const cancelledGame = useGameStore((state) => state.cancelledGame);
    const watchGame = useWatchGame();
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
    const modeReadyCounts = useGameStore((state) => state.modeReadyCounts);
    const queue = useGameStore((state) => state.queue);
    const joinQueue = useGameStore((state) => state.joinQueue);
    const leaveQueue = useGameStore((state) => state.leaveQueue);
    const botSession = useGameStore((state) => state.botSession);
    const botHistoryLength = useGameStore((state) => state.botHistory.length);
    const requestBotHint = useGameStore((state) => state.requestBotHint);
    const undoBotMove = useGameStore((state) => state.undoBotMove);
    const restartBotGame = useGameStore((state) => state.restartBotGame);
    const botGamePGN = useGameStore((state) => state.botGamePGN);
    const localHistoryLength = useGameStore((state) => state.localHistory.length);
    const undoLocalMove = useGameStore((state) => state.undoLocalMove);
    const flipLocalBoard = useGameStore((state) => state.flipLocalBoard);
    const restartLocalGame = useGameStore((state) => state.restartLocalGame);
    const localGamePGN = useGameStore((state) => state.localGamePGN);
    const tournamentCall = useTournamentCall();
    const spectateContext = useSpectateContext();
    // The phone's chin, taken as padding at the end of the scrolled content
    // rather than as a margin around the scroller — see `safeArea` below for
    // why the two are not the same thing to look at.
    const insets = useSafeAreaInsets();

    // Opening the review is guarded so a double press cannot hand the same
    // record over twice; coming back to this page arms it again.
    useFocusEffect(
        useCallback(() => {
            reviewOpeningRef.current = false;
        }, []),
    );

    // Measured before the empty state below rather than after it. A refresh
    // renders this page twice — once with no game, then again with the game
    // the server hands back — and a hook only the second render reaches is the
    // crash React reports as rendering more hooks than during the previous
    // render.
    const hasTerritory = gameState?.mode.features?.includes('territory');
    const isWatchingSeries = isSpectating && Boolean(spectateContext.series);
    // Everything above the board is measured rather than assumed, because it is
    // not always the same height: a spectated game carries the rail that steers
    // between boards, and a custom game an extra line of terms. Sizing the board
    // as though the header were only ever the top bar is what pushed the bottom
    // player bar — the clock — off the screen while watching two bots play.
    const [headerHeight, setHeaderHeight] = useState(HEADER_HEIGHT);
    const measureHeader = (event: LayoutChangeEvent) => {
        const measured = Math.round(event.nativeEvent.layout.height);
        setHeaderHeight((current) => (current === measured ? current : measured));
    };
    // The server banner, for the same reason and measured the same way. It is
    // zero nearly always and a couple of lines during a deploy, and the couple
    // of lines came out of the board's share of the window: the banner pushed
    // the page down, the board was still sized for a window without one, and
    // the bottom player bar — the clock, the resign button — went under the
    // fold of a wide layout that has nowhere to scroll to.
    const [bannerHeight, setBannerHeight] = useState(0);
    const measureBanner = (event: LayoutChangeEvent) => {
        const measured = Math.round(event.nativeEvent.layout.height);
        setBannerHeight((current) => (current === measured ? current : measured));
    };
    // The room the layout has actually been given, which on a wide screen is
    // the only figure worth sizing the board against.
    //
    // Measuring the two strips above and taking them off the window is the same
    // arithmetic from the other end, and it is arithmetic that has to come out
    // exactly right: every pixel it misses is a pixel the board keeps and the
    // foot of the layout loses, off the bottom of a column that cannot scroll.
    // The two measurements above are honest and it still came out wrong, on the
    // page that carries the most chrome — a header with a spectator's rail in
    // it, under a deploy banner — and what went missing was the clock and the
    // chat's composer.
    //
    // `screen` is the container the whole layout sits in and it is `flex: 1`
    // under both strips, so its height is what is left after them by
    // construction: the banner, the header, the rule between them and the
    // window's own safe area are all already gone from it, and nothing above
    // the board has to be counted again. Zero until the first layout, which is
    // what `chrome` below is still for.
    const [layoutHeight, setLayoutHeight] = useState(0);
    const measureLayout = (event: LayoutChangeEvent) => {
        const measured = Math.round(event.nativeEvent.layout.height);
        setLayoutHeight((current) => (current === measured ? current : measured));
    };
    // The live board is the tightest fit in the app: it has a player bar above
    // and below, and on a narrow screen the controls and the territory meter
    // under those. What the constants cover is everything the header does not —
    // the two player bars, the gaps around the board, and the page's padding.
    const {boardSize, height, isWide} = useBoardLayout({
        minimum: 190,
        sidePanel: 390,
        // What shares the board's column with it: a player bar above and below,
        // and the gap on either side of the board. `chrome` counts the strips
        // over the layout as well, because it is measured from the window.
        maxHeight: layoutHeight ? layoutHeight - PLAYER_BARS : undefined,
        chrome: headerHeight + bannerHeight + PLAYER_BARS + 7,
        narrowChrome: headerHeight + bannerHeight + (hasTerritory ? 336 : 306),
        // Series viewers scroll to the moves and chat; the header should not
        // shrink their board as the browser's address bar changes height.
        narrowFit: isWatchingSeries ? 'width' : 'viewport',
        // Nothing is drawn beside the board on a phone — the layout below is a
        // single column — so the only horizontal chrome the board owes is
        // `screen`'s padding. Keep the two numbers together: widening that
        // padding without widening this hands the board pixels it cannot have.
        narrowMargin: PHONE_PADDING * 2,
    });
    const compactSeriesHeader = isWatchingSeries && !isWide;
    // A refresh arrives here with nothing in the store: the socket has to come
    // back up and the game has to be asked for again before there is a board to
    // draw. So an empty screen is two different things, and saying the wrong
    // one is what the player notices.
    //
    // A remembered session id means a board is on its way — the server clears
    // it with `game_unavailable` if the game is really gone. The very first
    // render cannot read it, because a pre-rendered page has no local storage
    // and disagreeing with the pre-rendered HTML would cost the whole page, so
    // that render says it is still looking rather than claiming there is
    // nothing.
    // The reach maps, and only on a practice board: a game against a person is
    // rated, and handing one side a solved picture of the race is not a helper
    // tool, it is an engine. A mode with no goal row switches itself off.
    const reachTool = useReach(gameState?.bot ? gameState : null, {
        viewerSide: playerColor === 'Red' ? 'Red' : FIRST_TO_MOVE,
    });
    // What the game on the board is called. Read once and handed to both the
    // badge and the card at the end, from the line the game itself carries —
    // see `GameState.openingLine`, which is why a refresh and a spectator who
    // arrived late get the name too.
    const opening = useGameOpening(gameState);
    // The moves behind the position, and where along them the viewer is
    // standing. Both hooks run for every kind of game and before the empty
    // state below, because a hook only some renders reach is the crash React
    // reports as rendering more hooks than during the previous render.
    //
    // `follow` is what makes this a live board rather than a replay of one:
    // somebody sitting at the latest move is carried along by the next one,
    // and somebody who has stepped back stays where they put themselves.
    const history = useGameHistory(gameState);
    const replay = useReplayCursor({
        length: history.positions.length,
        follow: true,
        // Which game this is, so that arriving at one — or being carried from
        // one board of a series to the next — starts at the live position
        // rather than wherever the last board left the cursor.
        lineId: gameState?.gameId ?? null,
    });

    const settled = useSettled();
    // Two reasons a board might be on its way: a game of our own is being
    // rejoined, or a game somebody else is playing has been asked for. The
    // watch screen sets the second one from the id in the address, and without
    // it a shared link read "No active match" for as long as the request took.
    const lookingForGame = !settled || Boolean(gameSessionId) || Boolean(spectatedGameId);
    const lookingToWatch = !gameSessionId && Boolean(spectatedGameId);
    // A board that was stopped under whoever was looking at it. Nothing is on
    // its way — the game is gone and was never filed — so this outranks the
    // "no active match" copy below, which would leave a player and a spectator
    // alike to conclude the site had lost their game.
    const stopped = !lookingForGame && cancelledGame?.message ? cancelledGame : null;

    if (!gameState) {
        return (
            <SafeAreaView style={styles.safeArea}>
                <View style={styles.centered}>
                    {lookingForGame ? (
                        <ActivityIndicator
                            color={colors.accent}
                            size="small"
                            style={styles.emptySpinner}
                        />
                    ) : null}
                    <Text style={styles.emptyTitle}>
                        {stopped
                            ? 'This game was stopped'
                            : lookingToWatch
                                ? 'Opening the board…'
                                : lookingForGame
                                    ? 'Looking for your game…'
                                    : 'No active match'}
                    </Text>
                    <Text style={styles.emptyBody}>
                        {stopped
                            ? stopped.message
                            : lookingToWatch
                                ? "Joining the game…"
                                : lookingForGame
                                    ? "Reconnecting to your game…"
                                    : 'Return to the mode screen to find an opponent.'}
                    </Text>
                    {/* An escape hatch either way: a rejoin that never answers
                        should not be a screen with nothing on it. The same
                        control as the one on a board that did arrive, so it is
                        the same button in the same place whether or not the
                        game turns up. */}
                    <BackLink label={up.play.label} onPress={() => go(up.play.href)} />
                </View>
            </SafeAreaView>
        );
    }
    // A bot game is local: it needs no socket, shows no clock, and nothing it
    // does can change a rating.
    const bot = gameState.bot ?? null;
    // Two players at one device. All of the above, and one thing more: there is
    // no side the person at the keyboard owns, so `playerColor` is null and
    // every question that would normally be answered with it — which way up to
    // draw the board, whose turn this is, who just won — is answered from the
    // game instead.
    const local = gameState.local ?? null;
    // A spectator watches from the opening side, which is the end of the board
    // rank 1 is drawn at. A player watches from their own, and `Neutral` is not
    // a side anybody sits on. A local board is drawn from whichever side its
    // players last turned it to.
    const ownColor: SideColor = playerColor === 'Red' ? 'Red' : FIRST_TO_MOVE;
    const seatColor: SideColor = local ? local.viewColor : ownColor;
    // Whoever is to move is the only side a resignation can come from: there is
    // nobody else at this keyboard to give up. `Neutral` is not a side, so it
    // reads as the side that opens.
    const turnSide: SideColor =
        gameState.currentTurn === 'Red' ? 'Red' : FIRST_TO_MOVE;
    const viewColor: SideColor = isSpectating ? FIRST_TO_MOVE : seatColor;
    const topColor: SideColor = isSpectating
        ? opposingColor(FIRST_TO_MOVE)
        : opposingColor(seatColor);
    const bottomColor: SideColor = isSpectating ? FIRST_TO_MOVE : seatColor;
    const captured = capturedPieces(gameState);
    const topProfile = topColor === 'Red' ? gameState.redPlayer : gameState.bluePlayer;
    const bottomProfile = bottomColor === 'Red' ? gameState.redPlayer : gameState.bluePlayer;
    const isConnected = connectionStatus === 'connected';
    // At a local board every turn is this keyboard's, which is the whole point:
    // the same person plays both sides. Everywhere else it is the usual
    // question of whether the colour to move is yours.
    const isMyTurn = local
        ? gameState.status === 'InProgress'
        : !isSpectating &&
        (isConnected || Boolean(bot)) &&
        gameState.status === 'InProgress' &&
        gameState.currentTurn === playerColor;
    // A board that exists but has not been played on. Read off the position
    // rather than tracked separately: a stopped clock in a game in progress is
    // the server's own way of saying it, so this cannot go stale.
    const awaitingFirstMove =
        !bot &&
        !local &&
        gameState.status === 'InProgress' &&
        gameState.clock?.activeColor === 'Neutral';
    const opponentName = topProfile?.username?.trim() || null;
    const timeControlLabel = formatTimeControl(gameState.timeControl);
    // Read from the same describeSetup the lobby row was rendered from, so a
    // game reads the same after you accept it as it did before.
    const customTerms = ruleSummary(gameState.rules);
    const spectatorCount =
        liveGames.find((liveGame) => liveGame.gameId === gameState.gameId)?.spectatorCount ?? 0;
    // A board has been asked for and has not arrived yet. `spectatedGameId` is
    // set the moment the request goes out, while `gameState` still holds the
    // board being left, so the two disagreeing is exactly the hand-off.
    const switchingBoards = isSpectating && Boolean(spectatedGameId) && spectatedGameId !== gameState.gameId;
    // Whether the board is showing the game as it stands, or a position from
    // earlier in it.
    //
    // A game with no history to step through is always at its live edge, which
    // is what keeps every board that has no record — an older server, a mode
    // this client cannot replay — behaving exactly as it did before there was
    // a move list.
    const atLiveEdge = !history.available || replay.atLiveEdge;
    const replayPosition = atLiveEdge ? null : (history.positions[replay.cursor] ?? null);
    // The live grid comes off the game itself and never off the replay, even
    // though the two should agree: the replay is this client running the rules
    // over a record, and the board the server sent is the game. Only a viewer
    // who has deliberately stepped back is shown the reconstruction.
    const visibleGrid = replayPosition?.grid ?? gameState.grid;
    // Which move to mark on the board. Stepped back, that is the move that
    // produced the position being looked at rather than the one just played in
    // a game that has moved on without the viewer.
    const visibleLastMove = replayPosition
        ? (history.moves[replay.cursor - 1] ?? null)
        : lastMove;
    // The board as the export dialog needs it: the position being looked at,
    // the names either side of it, and the clocks as they stood there. A viewer
    // who has stepped back gets the record's own clocks for that move rather
    // than the live ones, which belong to a position they are not looking at.
    const exportCaptures = capturedPieces({
        grid: visibleGrid,
        mode: gameState.mode,
    });
    const steppedBackMove = replayPosition ? history.moves[replay.cursor - 1] ?? null : null;
    const exportBoard: ShareCardInput = {
        grid: visibleGrid,
        currentTurn: replayPosition?.currentTurn ?? gameState.currentTurn,
        mode: gameState.mode,
        era: replayPosition?.era,
        flipped: viewColor === 'Red',
        lastMove: visibleLastMove,
        detail: {
            players: {
                Red: {
                    name: playerName(gameState.redPlayer, 'Red'),
                    detail: bot && bot.color === 'Red' ? `LEVEL ${bot.rating}` : undefined,
                },
                Blue: {
                    name: playerName(gameState.bluePlayer, 'Blue'),
                    detail: bot && bot.color === 'Blue' ? `LEVEL ${bot.rating}` : undefined,
                },
            },
            clock: steppedBackMove
                ? steppedBackMove.redRemainingMs !== null &&
                  steppedBackMove.blueRemainingMs !== null
                    ? {
                        Red: steppedBackMove.redRemainingMs,
                        Blue: steppedBackMove.blueRemainingMs,
                    }
                    : null
                : gameState.clock
                    ? {
                        Red: gameState.clock.redRemainingMs,
                        Blue: gameState.clock.blueRemainingMs,
                    }
                    : null,
            captured: { Red: exportCaptures.Red.tally, Blue: exportCaptures.Blue.tally },
            heading: local ? 'SHARED BOARD' : bot ? 'BOT GAME' : isSpectating ? 'LIVE' : undefined,
            caption:
                gameState.status === 'Finished' && atLiveEdge
                    ? colourResultLabel(gameState.winner, gameState.endReason ?? null)
                    : `Move ${replay.cursor} · ${
                        replayPosition?.currentTurn ?? gameState.currentTurn
                    } to move`,
        },
    };
    // Where the hundred-move rule has got to in the position on the board.
    //
    // Off the replay at both edges, unlike the grid above: a board snapshot does
    // not carry the count — only the moves behind it do — and this is the same
    // replay the move list beside it is drawn from, so the two cannot disagree
    // about the game they describe. A record that never arrived leaves no meter,
    // exactly as it leaves no move list.
    //
    // Nothing counts down in a game that is over, whatever its last position
    // says: a resignation or a flagged clock ends a game the moves alone show no
    // ending for, and the result card is what speaks for those.
    const quietPosition =
        gameState.status === 'Finished'
            ? null
            : (replayPosition ?? history.positions[history.positions.length - 1] ?? null);
    // Modes with a real player waiting in matchmaking right now. Someone busy
    // with a bot should still get the chance to take that game.
    // Counted from the people who are *at the keyboard*, not from everybody
    // queued. Now that a search survives a closed tab, the wider figure includes
    // players who are asleep — and telling somebody mid-bot-game that a human is
    // waiting, when that human cannot be seated for another thirty seconds, is
    // how a useful nudge becomes a wasted click.
    const waitingModes = bot
        ? modes
            .filter((mode) => (modeReadyCounts[mode.id] ?? 0) > 0)
            .map((mode) => ({
                id: mode.id,
                name: mode.name,
                shortCode: mode.shortCode,
                waiting: modeReadyCounts[mode.id] ?? 0,
            }))
        : [];
    const canAnswerOffers = !isSpectating && gameState.status === 'InProgress';
    const hasOpponentDrawOffer =
        canAnswerOffers && gameState.drawOfferedBy && gameState.drawOfferedBy !== playerColor;
    const hasOpponentTimeOffer =
        canAnswerOffers && gameState.timeOfferedBy && gameState.timeOfferedBy !== playerColor;
    // A game nobody moved in has nothing to review, and a game the server never
    // saw can only be reviewed from the move list this browser kept.
    const canReview = bot
        ? botHistoryLength > 0
        : local
            ? localHistoryLength > 0
            : gameState.moveNumber > 0;

    // Whether there is anything to leave *to*.
    //
    // A rated game in progress cannot be walked out of: `SessionBridge` puts a
    // player back on their own live board from wherever they navigate, so a
    // press here would land on the lobby and bounce straight back — and
    // `clearGame` would have thrown the board away on the way past. Resigning
    // and aborting are the real ways out and they are both in the panel.
    // Everything else leaves: a finished game (which is only being held open
    // for its chat room), a game being watched, and the bot and shared-device
    // boards, which never left this tab.
    const canLeave =
        Boolean(bot) || Boolean(local) || isSpectating || gameState.status !== 'InProgress';

    // The board is not somewhere to go back *to* once it has been left: its
    // game has been cleared out of the store, so the browser's back button
    // landed on a screen with nothing on it, or — from a watched game that had
    // since finished — on that game's review, whether or not the archive had
    // written it yet.
    //
    // A `replace` was the first answer to that and it was not enough, because
    // the lobby is not this screen's neighbour on the stack — it is the screen
    // this one was laid over. Replacing put a *second* lobby where the board
    // had been and left the first one under it, which is how the pile grew a
    // pair at a time and why "back" took two or three presses to get anywhere.
    const returnToModes = () => {
        clearGame();
        go(up.play.href);
    };

    // The game is deliberately left in the store: an online game's chat room
    // stays open while the players go over the board, and `clearGame` is what
    // closes it. A bot game never reached the server, so its record is written
    // here from the moves the browser kept.
    const openReview = () => {
        if (reviewOpeningRef.current) return;
        reviewOpeningRef.current = true;
        // A server game is addressed by its id, which makes the review a page
        // somebody can link to. A bot game never reached the server, so its
        // record is written here and handed over.
        if (!bot && !local) {
            go(links.review(gameState.gameId));
            return;
        }
        const pgn = local ? localGamePGN() : botGamePGN();
        if (!pgn) {
            reviewOpeningRef.current = false;
            return;
        }
        // A local game has no reviewer's own side to grade from: both accuracy
        // figures belong to somebody in the room.
        handReview({pgn, playerColor: local || isSpectating ? null : playerColor});
        go(links.review());
    };

    const confirmResign = () => {
        setShowResignConfirmation(false);
        resignGame();
    };

    const matchNotices = (
        <>
            {Boolean(bot) && (
                <OpponentSearchNotice onJoin={joinQueue} waitingModes={waitingModes} />
            )}
            {botSession?.drawNotice ? (
                <View style={styles.selfReconnectNotice}>
                    <Text style={styles.selfReconnectText}>{botSession.drawNotice}</Text>
                </View>
            ) : null}
            {botSession?.engineError ? (
                <View style={styles.selfReconnectNotice}>
                    <Text style={styles.selfReconnectText}>{botSession.engineError}</Text>
                </View>
            ) : null}
            {!bot && !local && !isConnected && gameState.status === 'InProgress' && (
                <View style={styles.selfReconnectNotice}>
                    <Text style={styles.selfReconnectText}>
                        {isSpectating ? 'Reconnecting to the live game…' : 'Reconnecting to your match…'}
                    </Text>
                </View>
            )}
            {!isSpectating && !bot && !local && awaitingFirstMove && (
                <FirstMoveNotice
                    deadline={firstMoveDeadline}
                    opponentName={opponentName}
                    yours={isMyTurn}
                />
            )}
            {/*
              Only one countdown at a time. Before the first move nobody has
              abandoned anything: the game is simply waiting, and it says so
              above rather than threatening a win that is not on offer.
            */}
            {!isSpectating && !bot && !local && !awaitingFirstMove && (
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
        isSpectating || gameState.status !== 'InProgress' ? null : local ? (
            <LocalGameActions
                canUndo={localHistoryLength > 0}
                onDraw={offerDraw}
                onFlip={flipLocalBoard}
                onResign={() => setShowResignConfirmation(true)}
                onUndo={undoLocalMove}
                turnColor={turnSide}
            />
        ) : bot ? (
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
                onReach={reachTool.available ? reachTool.toggle : undefined}
                onResign={() => setShowResignConfirmation(true)}
                onUndo={undoBotMove}
                reachShowing={reachTool.active}
            />
        ) : (
            <GameActions
                awaitingFirstMove={awaitingFirstMove}
                connected={isConnected}
                gameState={gameState}
                isMyTurn={isMyTurn}
                onAbort={abortGame}
                onDraw={offerDraw}
                onResign={() => setShowResignConfirmation(true)}
                onTimeExtension={offerTimeExtension}
                playerColor={playerColor}
            />
        );

    const hint = bot ? botSession?.hint ?? null : null;
    // "Thinking" is what a bar says about somebody you are waiting for, and at
    // a shared board there is nobody to wait for — the other player is holding
    // the same device. The seat says whether it is its go instead, which also
    // spares the idle bar from reading "Blue · Blue", and once the game is over
    // it says how it went rather than leaving a turn on the board that has
    // stopped taking them.
    const localMeta = (color: SideColor) => {
        if (!local) return undefined;
        if (gameState.status === 'Finished') {
            if (gameState.winner === 'Neutral') return 'Drew';
            return gameState.winner === color ? 'Won' : 'Lost';
        }
        return gameState.currentTurn === color ? 'To move' : 'Waiting';
    };
    // Both names lead to their pages while somebody is watching.
    //
    // A spectator came to see two other people play, so "who is that" is the
    // question the board provokes and the names are where anybody would look
    // for the answer. The two players get plain text: the app holds them at
    // their own live board (see `app/_layout.tsx`), so a link out of it would
    // navigate and be replaced straight back — and their way to an opponent's
    // page is the review, which the card at the end of the game offers them.
    const linkNames = isSpectating;
    const playerBars = (
        <>
            <PlayerBar
                badge={bot && topColor === bot.color ? 'BOT' : null}
                captured={captured[topColor]}
                clock={gameState.clock}
                color={topColor}
                extension={timeExtension}
                fallbackLabel={isSpectating || local ? `${topColor} player` : 'Opponent'}
                gameStatus={gameState.status}
                isYou={false}
                linkName={linkNames}
                metaOverride={
                    bot && topColor === bot.color
                        ? `Level ${bot.rating} · ${
                            gameState.currentTurn === bot.color ? 'thinking' : 'waiting'
                        }`
                        : localMeta(topColor)
                }
                profile={topProfile}
                turnColor={gameState.currentTurn}
            />
            {/*
              `movableColor` is what makes a shared board work: one person plays
              both sides, so what may be picked up is whatever is to move rather
              than the viewer's own colour, which is nobody's here.
            */}
            <Board
                analysisArrows={hint && atLiveEdge ? [hint] : []}
                boardSize={boardSize}
                // Nothing can be played from a position the game has already
                // left. The tap handler below brings the viewer back rather
                // than refusing, so a player who stepped back to look at
                // something is one tap from their own move again.
                canMove={isMyTurn && atLiveEdge}
                grid={visibleGrid}
                lastMove={visibleLastMove}
                modeId={gameState.mode.id}
                movableColor={local && atLiveEdge ? gameState.currentTurn : undefined}
                onPieceDrop={movePiece}
                onTilePress={(square) => {
                    // Stepped back, the board is a picture of an earlier move
                    // and every square on it is the way back to the game.
                    if (!atLiveEdge) {
                        replay.goToLast();
                        return;
                    }
                    // The tool only ever swallows a tap while it is waiting for
                    // somewhere to put a ghost piece. Everything else falls
                    // through, so selecting and moving behave the same whether
                    // the overlay is on or off.
                    if (reachTool.handleTilePress(square)) return;
                    selectTile(square);
                }}
                overlay={atLiveEdge ? reachTool.overlay : null}
                playerColor={viewColor}
                // Handed the whole line, so a jump of several moves off the
                // list animates through the positions in between instead of
                // cutting to the destination.
                replayIndex={history.available ? replay.cursor : null}
                replayPositions={history.available ? history.positions : null}
                selectedTile={atLiveEdge ? selectedTile : null}
                validMoves={atLiveEdge ? validMoves : []}
            />
            <PlayerBar
                badge={bot && bottomColor === bot.color ? 'BOT' : null}
                captured={captured[bottomColor]}
                clock={gameState.clock}
                color={bottomColor}
                extension={timeExtension}
                fallbackLabel={isSpectating || local ? `${bottomColor} player` : 'You'}
                gameStatus={gameState.status}
                isYou={!isSpectating && !local}
                linkName={linkNames}
                metaOverride={localMeta(bottomColor)}
                profile={bottomProfile}
                turnColor={gameState.currentTurn}
            />
        </>
    );

    // The score sheet, and the controls that walk it.
    //
    // Every board here has one now — a match, a game against a bot, a shared
    // device, and a game being watched. It is the same list the review screen
    // draws, off the same replay, with nothing graded: a live game has no
    // analysis behind it, so each move gets a plain pip where a review would
    // put a symbol.
    //
    // The rows scroll inside the card and everything else in it is pinned: the
    // heading above them, the controls and the hint below. A live game keeps
    // adding rows, and a card that grew with them pushed the controls off the
    // bottom of the panel and then moved them again after every move — so the
    // one thing you steer the list with was never in the same place twice.
    //
    // Not drawn at all when there is no record to read. That is the honest
    // answer for a game whose history never arrived, and it is what keeps this
    // out of the way on a board that cannot have one.
    const moveHistory = history.available ? (
        <MoveAnalysisList
            emptyText="No moves yet."
            moves={history.moves}
            onSelect={replay.goTo}
            scroll
            selectedIndex={replay.cursor}
            title={atLiveEdge ? 'MOVES' : 'MOVES · LOOKING BACK'}
            // The board being looked at, which is the live one until somebody
            // steps back off it. Up here rather than beside the controls
            // because the board column on this screen has no height to spare —
            // see the note on `titleAccessory`.
            titleAccessory={<BoardExportButton board={exportBoard}/>}
            footer={
                <>
                    <ReplayControls
                        // Beside the buttons rather than under them, and only
                        // while the game is going and the viewer is not at the
                        // end of it: there is no live edge to return to in a game
                        // that has finished, and a button offering one would be a
                        // lie about the board underneath.
                        //
                        // It used to be a full-width row of its own, which meant
                        // stepping back off the live edge grew the footer and
                        // moved the controls and the rows above them — the list
                        // shifting under you as a side effect of reading it. The
                        // controls row keeps a zone for this, so appearing here
                        // moves nothing.
                        accessory={
                            !atLiveEdge && gameState.status === 'InProgress' ? (
                                <Pressable
                                    accessibilityLabel="Return to the live position"
                                    accessibilityRole="button"
                                    onPress={replay.goToLast}
                                    style={({pressed}) => [
                                        styles.returnToLive,
                                        pressed && styles.buttonPressed,
                                    ]}
                                >
                                    <Text numberOfLines={1} style={styles.returnToLiveText}>
                                        ◉ LIVE
                                    </Text>
                                </Pressable>
                            ) : null
                        }
                        current={replay.cursor}
                        // The badge is the one place that says whether the board
                        // is the game or a picture of it. `LIVE` while the game
                        // is still being played and the viewer is at the end of
                        // it; the move number otherwise, including for every
                        // position of a finished game, where nothing is live.
                        label={atLiveEdge && gameState.status === 'InProgress' ? 'LIVE' : 'MOVE'}
                        onFirst={replay.goToFirst}
                        onLast={replay.goToLast}
                        onNext={replay.stepForward}
                        onPrevious={replay.stepBack}
                        total={replay.lastIndex}
                    />
                </>
            }
        />
    ) : null;

    // Nobody is listening on the other side of a bot game, and at a local board
    // the other player is close enough to talk to. Neither has a chat.
    const gameChat = bot || local ? null : (
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
            roomOccupancy={chatOccupancy}
            scope={chatRoomScopeOf(chatRoomScope, chatRoomId, gameState.gameId)}
            showSpectatorMessages={showSpectatorMessages}
            spectatorCount={spectatorCount}
            wide={isWide}
        />
    );
    // What to watch next, for the card at the end of a watched game.
    //
    // The run is asked first and the event second, which is the order they
    // answer in: the next game of a series is the same two engines carrying on,
    // and a tournament's other boards are a different match entirely. Null when
    // neither has anything up, which takes the button off the card rather than
    // offering a dead one — and that is the ordinary case for a single game
    // between two people.
    const nextSeriesBoard = spectateContext.nextSeriesGame;
    const nextTournamentBoard = spectateContext.boards.find(
        (board) => board.gameId !== gameState.gameId,
    );
    const nextToWatch = nextSeriesBoard
        ? {
            label: nextSeriesBoard.series?.gameNumber
                ? `Watch game ${nextSeriesBoard.series.gameNumber}`
                : 'Watch the next game',
            onWatch: () => watchGame(nextSeriesBoard.gameId),
        }
        : nextTournamentBoard
            ? {
                label: `Watch ${nextTournamentBoard.redName} vs ${nextTournamentBoard.blueName}`,
                onWatch: () => watchGame(nextTournamentBoard.gameId),
            }
            : null;

    const rematch = bot ? restartBotGame : local ? restartLocalGame : null;
    const statusCard = (wide = false) => (
        <StatusCard
            botThinking={Boolean(botSession?.thinking)}
            canReview={canReview}
            gameState={gameState}
            isMyTurn={isMyTurn}
            isSpectating={isSpectating}
            lookingBack={!atLiveEdge}
            opening={opening}
            onRematch={rematch}
            onReturn={returnToModes}
            onReviewGame={openReview}
            playerColor={playerColor}
            selectedTile={selectedTile}
            wide={wide}
        />
    );

    return (
        <SafeAreaView
            style={styles.safeArea}
            edges={isWide ? ['top', 'right', 'bottom', 'left'] : ['right', 'left']}
        >
            {/*
              The top edge belongs to the chrome, not to the frame — the same
              split `ShellLayout` makes on a phone, and for the same reason.
              Claimed by the frame, the notch band is painted in the page's
              background colour and reads as a stripe of board above a header
              that is a different colour; claimed here, the header simply starts
              at the top of the screen. The frame no longer asks for `top` on a
              phone: two nested SafeAreaViews both claiming an edge would inset
              it twice.

              A wide screen has no notch to dress, so the frame keeps the edge
              and this asks for nothing.
            */}
            <SafeAreaView edges={isWide ? [] : ['top']} style={styles.topChrome}>
                {/*
                  Above the header rather than in the lobby only, because the board is
                  where the message matters most: somebody mid-game is the one person
                  a graceful restart is being run for, and they should be able to see
                  that their game is the thing it is waiting on. Renders nothing when
                  there is nothing to say, which is why it is wrapped and measured
                  rather than allowed a fixed allowance: the wrapper is 0 high until
                  there is a message, and the board gives up exactly the room the
                  message takes.
                */}
                <View onLayout={measureBanner}>
                    <ServerBanner />
                </View>
                <View onLayout={measureHeader} style={styles.header}>
                    <View style={styles.headerInner}>
                        <View style={[styles.topBar, compactSeriesHeader && styles.topBarCompact]}>
                            {/*
                              The way out, in the corner every other page of this
                              site keeps it in. There used to be nothing at all up
                              here: leaving was a button on the right of the status
                              card, which only appeared once the game was over or if
                              you were watching, so the one screen people spend the
                              most time on was the one screen with no navigation
                              where they reached for it.

                              Disabled rather than missing during your own rated
                              game, because there is genuinely no leaving one: the
                              app puts a player back on their live board from
                              wherever they navigate to, so a working button here
                              would take somebody to the lobby and bounce them
                              straight back. Resigning or aborting is the honest way
                              out and both are in the panel beside the board. A
                              bot game and a shared-device game are only in this
                              tab, so those leave freely.
                            */}
                            <BackLink
                                disabled={!canLeave}
                                hint={
                                    canLeave
                                        ? undefined
                                        : 'Resign or abort to leave a game in progress.'
                                }
                                label={up.play.label}
                                onPress={returnToModes}
                            />
                            <View style={[styles.matchIdentity, compactSeriesHeader && styles.matchIdentityCompact]}>
                                <Text style={[styles.matchKicker, compactSeriesHeader && styles.matchKickerCompact]}>
                                    {gameState.mode.shortCode} ·{' '}
                                    {gameState.status === 'Finished'
                                        ? 'FINAL'
                                        : bot
                                            ? 'BOT GAME · UNRATED'
                                            : local
                                                ? 'LOCAL GAME · UNRATED'
                                                : isSpectating
                                                    ? 'SPECTATING LIVE'
                                                    : 'LIVE MATCH'}
                                </Text>
                                <Text style={[styles.modeName, compactSeriesHeader && styles.modeNameCompact]}>
                                    {gameState.mode.name}
                                </Text>
                                {/*
                                  The terms this game was set up with, when they are not
                                  the usual ones. Players who accepted a custom game
                                  should not have to remember what they agreed to.
                                */}
                                {customTerms ? (
                                    <Text numberOfLines={2} style={styles.customTerms}>
                                        {customTerms}
                                    </Text>
                                ) : null}
                                {/*
                                  What the opening is called, while it is still
                                  being played. A custom board never gets one: the
                                  book is measured from the mode's own opening, and
                                  a line from anywhere else is not one it knows.
                                */}
                                <OpeningBadge
                                    linked={gameState.status === 'Finished'}
                                    modeId={gameState.mode.id}
                                    opening={opening}
                                />
                            </View>
                            <View style={[styles.timeControlBadge, compactSeriesHeader && styles.timeControlBadgeCompact]}>
                                <Text style={[styles.timeControlLabel, compactSeriesHeader && styles.timeControlLabelCompact]}>
                                    {bot || local ? 'OPPONENT' : 'TIME CONTROL'}
                                </Text>
                                <Text style={styles.timeControlValue} numberOfLines={1}>
                                    {bot ? bot.name : local ? 'Same device' : timeControlLabel}
                                </Text>
                            </View>
                        </View>

                        {isSpectating && (
                            <SpectateRail
                                blueName={playerName(gameState.bluePlayer, 'Blue player')}
                                context={spectateContext}
                                currentGameId={gameState.gameId}
                                disabled={!isConnected}
                                endReason={gameState.endReason ?? null}
                                gameStatus={gameState.status}
                                onWatch={watchGame}
                                pendingGameId={spectatedGameId}
                                redName={playerName(gameState.redPlayer, 'Red player')}
                                winner={gameState.winner}
                            />
                        )}
                    </View>
                </View>
            </SafeAreaView>

            {/*
              Measured, because this is the room the board is competing for —
              see `measureLayout`. It is what is left of the window after the
              banner and the header above, and it is a `flex: 1` child of them,
              so it gives that answer without anything here having to add the
              two of them up.
            */}
            <View onLayout={measureLayout} style={styles.screen}>
                <GameTransition
                    gameKey={gameState.gameId}
                    leaving={switchingBoards}
                    style={styles.transition}
                >
                    {isWide ? (
                        <View style={styles.wideLayout}>
                            <View style={styles.playColumn}>{playerBars}</View>
                            {/*
                              A column of a known height, with the chat pinned to
                              the foot of it.

                              The chat used to sit *inside* this panel's
                              ScrollView, where `flex: 1` cannot bound it: the
                              card grew with the conversation instead, its own
                              message list never scrolled, and by thirty messages
                              the composer was a thousand pixels below the panel.
                              Scrolling down to reach it took the clock, the
                              status card and the resign button off the screen.
                              So the chat is a sibling of the scroller now — it
                              takes the room the cards above it do not want, and
                              scrolls its messages inside that.
                            */}
                            <View
                                style={[
                                    styles.sidePanel,
                                    {height: boardSize + 120},
                                    Boolean(tournamentCall) && styles.calloutClearance,
                                ]}
                            >
                                {/*
                                  Pinned above the scroller, not inside it. It
                                  says whose turn it is and carries the way out
                                  of the game, and both of those are wanted while
                                  reading the move list underneath — which is its
                                  own scroller now, so anything above it in a
                                  shared one would scroll away.
                                */}
                                {statusCard(true)}

                                <ScrollView
                                    contentContainerStyle={styles.sidePanelContent}
                                    keyboardShouldPersistTaps="handled"
                                    showsVerticalScrollIndicator={false}
                                    style={styles.sidePanelScroll}
                                >
                                    {matchNotices}
                                    {gameActions}

                                    {hasTerritory && <TerritoryMeter grid={visibleGrid}/>}
                                    <QuietMoveMeter game={quietPosition}/>
                                    <ReachPanel tool={reachTool}/>

                                    {/*
                                      The cards that fill the panel when the chat
                                      is not taking the room: either it is
                                      collapsed, or this is a bot game, which has
                                      no chat to collapse. Gating them on
                                      `chatVisible` alone left the bot board with
                                      an empty half-panel, and hid the objective
                                      behind a toggle for a chat that was never
                                      there.
                                    */}
                                    {(!gameChat || !chatVisible) && (
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
                                                {/*
                                                  A bot game has no clock at all,
                                                  and `formatTimeControl` spells
                                                  that "Live" — true of a real
                                                  game waiting on a clock, a lie
                                                  next to a practice board. Its
                                                  rating is the useful figure.
                                                */}
                                                {/*
                                                  A local game's second fact is
                                                  which way round the board is.
                                                  Whose turn it is would be a
                                                  third copy of the status card
                                                  two cards above; the
                                                  orientation is the one piece
                                                  of this game's state that is
                                                  written down nowhere else.
                                                */}
                                                <View>
                                                    <Text style={styles.factLabel}>
                                                        {bot ? 'LEVEL' : local ? 'VIEW' : 'CLOCK'}
                                                    </Text>
                                                    <Text style={styles.factValue}>
                                                        {bot
                                                            ? bot.rating
                                                            : local
                                                                ? `${local.viewColor}'s side`
                                                                : timeControlLabel}
                                                    </Text>
                                                </View>
                                            </View>
                                        </>
                                    )}
                                </ScrollView>

                                {/*
                                  Given the column's spare room rather than its
                                  content height, so the rows have somewhere to
                                  scroll. It shares what is left with the chat
                                  below, which claims its room the same way.
                                */}
                                {moveHistory ? (
                                    <View style={styles.historySlot}>{moveHistory}</View>
                                ) : null}

                                {/*
                                  Lifted over the panel when the keyboard is up,
                                  rather than resized under it. This column is
                                  as tall as the board and the chat is pinned to
                                  the foot of it, so a keyboard over the bottom
                                  half of an iPad took the composer and most of
                                  the conversation with it — and the only way to
                                  fit both above it would be to shrink the board
                                  to a thumbnail for as long as somebody is
                                  typing. See KeyboardLift.
                                */}
                                {gameChat ? (
                                    <KeyboardLift style={styles.chatSlot}>{gameChat}</KeyboardLift>
                                ) : null}
                            </View>
                        </View>
                    ) : (
                        <ScrollView
                            // The chat's composer is at the bottom of a page that
                            // scrolls, so the keyboard is iOS's problem to solve:
                            // it pads the content by the room the keyboard takes
                            // and brings the focused field up out from under it.
                            // Without this the composer was simply behind the
                            // keyboard, with no way to scroll to it — the page had
                            // no more room to give.
                            automaticallyAdjustKeyboardInsets
                            contentContainerStyle={[
                                styles.mobileLayout,
                                {paddingBottom: (tournamentCall ? 88 : 6) + insets.bottom},
                            ]}
                            keyboardShouldPersistTaps="handled"
                            // The board is inside this scroller on a phone, and
                            // dragging a piece must not drag the page with it.
                            scrollEnabled={!draggingPiece}
                            showsVerticalScrollIndicator={false}
                        >
                            {gameState.status === 'Finished' && !isSpectating ? statusCard() : null}
                            {playerBars}
                            {hasTerritory && <TerritoryMeter grid={visibleGrid}/>}
                            <QuietMoveMeter game={quietPosition}/>
                            <ReachPanel tool={reachTool}/>
                            {matchNotices}
                            {gameActions}
                            {/*
                              Bounded here too, for the same reason and by a
                              height rather than by flex: the whole page is one
                              scroller on a phone, so a card that grew with the
                              game would put its controls further down the page
                              after every move.
                            */}
                            {moveHistory ? (
                                <View style={styles.historySlotPhone}>{moveHistory}</View>
                            ) : null}
                            {gameChat}
                            {gameState.status !== 'Finished' || isSpectating ? statusCard() : null}
                        </ScrollView>
                    )}
                </GameTransition>

                {error && (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Dismiss error"
                        onPress={clearError}
                        style={[styles.errorBanner, {bottom: 12 + insets.bottom}]}
                    >
                        <Text style={styles.errorText}>{error}</Text>
                        <Text style={styles.errorDismiss}>×</Text>
                    </Pressable>
                )}

                {/*
                  The result of a game being watched, said once and in the way.
                  See SpectateResultModal for why a spectator gets an
                  interruption where a player does not.
                */}
                {isSpectating && (
                    <SpectateResultModal
                        blueName={playerName(gameState.bluePlayer, 'Blue')}
                        endReason={gameState.endReason ?? null}
                        next={nextToWatch}
                        onDismiss={() => setDismissedResultFor(gameState.gameId)}
                        onReturnToLobby={returnToModes}
                        redName={playerName(gameState.redPlayer, 'Red')}
                        visible={
                            gameState.status === 'Finished' &&
                            dismissedResultFor !== gameState.gameId
                        }
                        winner={gameState.winner}
                    />
                )}

                {!isSpectating && (
                    <ConfirmResignModal
                        detail={
                            bot
                                ? `${bot.name} wins this practice game. Nothing is recorded.`
                                : local
                                    ? `${turnSide} resigns, so ${opposingColor(turnSide)} wins this local game. Nothing is recorded.`
                                    : undefined
                        }
                        onCancel={() => setShowResignConfirmation(false)}
                        onConfirm={confirmResign}
                        visible={showResignConfirmation}
                    />
                )}
            </View>
        </SafeAreaView>
    );
}

const styles = themedSheet(() => ({
    // No bottom edge on a phone: the scroller below runs to the physical foot
    // of the screen, and the chin is padded into the end of its content instead
    // (see `insets` above). Taken as a margin here, it read as the page being
    // cut off a finger's width short of the edge — the content stopped, and a
    // strip of empty background sat under it while there was still more to
    // scroll to. A wide screen has no chin worth the trouble and keeps the edge.
    safeArea: {flex: 1, backgroundColor: colors.background},
    screen: {
        flex: 1,
        width: '100%',
        maxWidth: 1180,
        alignSelf: 'center',
        paddingHorizontal: PHONE_PADDING,
    },
    centered: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24},
    // Room for the floating tournament call to action.
    calloutClearance: {paddingBottom: 88},
    emptySpinner: {marginBottom: 14},
    emptyTitle: {color: colors.textStrong, fontSize: 25, fontWeight: '900'},
    emptyBody: {color: colors.textMuted, marginTop: 8, textAlign: 'center'},
    buttonPressed: {opacity: 0.72},
    statusActions: {flexDirection: 'row', alignItems: 'center', gap: 6},
    statusReviewButton: {
        minHeight: 34,
        justifyContent: 'center',
        paddingHorizontal: 12,
        borderRadius: radius.medium,
        backgroundColor: colors.accent,
    },
    statusReviewText: {color: colors.textStrong, fontSize: 10, fontWeight: '900'},
    // Everything above the board that is chrome rather than page, in the
    // header's own colour — including the band the phone's notch sits in, which
    // is inside this and not inside the frame. A deploy banner is up here too,
    // so on the rare day there is one the whole strip reads as one piece of
    // chrome rather than as a header with a stripe of board above it.
    topChrome: {backgroundColor: colors.surfaceSunken},
    // The part of the page that does not scroll, and it has to look like it:
    // a bar of its own, the same sunken panel and hairline the lobby's header
    // uses, rather than the same background as the board sliding past under it.
    // The negative margins take it back out to the screen's edges, since the
    // page's own padding is what the scrolling content wants, not the bar.
    header: {
        marginBottom: 7,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surfaceSunken,
    },
    // The bar's contents keep the page's column; only its background and rule
    // run the full width of the window.
    headerInner: {
        width: '100%',
        maxWidth: 1180,
        alignSelf: 'center',
        gap: 7,
        paddingVertical: 7,
        paddingHorizontal: 14,
    },
    topBar: {
        minHeight: 47,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 11,
    },
    topBarCompact: {gap: 6},
    // Takes the slack in the top bar so a long mode name cannot squeeze the
    // time-control badge.
    matchIdentity: {flex: 1, minWidth: 0, paddingRight: 10},
    matchIdentityCompact: {paddingRight: 0},
    matchKicker: {
        color: colors.accentBright,
        fontSize: 8,
        fontWeight: '900',
        letterSpacing: 1.4,
    },
    matchKickerCompact: {fontSize: 7, letterSpacing: 0.8},
    modeName: {color: colors.textStrong, fontSize: 20, fontWeight: '900', marginTop: 2},
    modeNameCompact: {fontSize: 16, lineHeight: 20, marginTop: 1},
    customTerms: {...type.meta, color: colors.accentSoft, marginTop: 2},
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
    timeControlBadgeCompact: {minWidth: 72, paddingHorizontal: 8, paddingVertical: 5},
    timeControlLabel: {
        color: colors.textFaint,
        fontSize: 7,
        fontWeight: '900',
        letterSpacing: 1.1,
    },
    timeControlLabelCompact: {fontSize: 6, letterSpacing: 0.7},
    timeControlValue: {
        color: colors.textStrong,
        fontSize: 15,
        fontWeight: '900',
        marginTop: 1,
    },
    // The hand-off wrapper sits between the screen and the layout, so it has to
    // pass the height it was given straight through.
    transition: {flex: 1},
    // `paddingBottom` is set inline, from the phone's chin and whether the
    // floating call-out is over the foot of the page.
    mobileLayout: {flexGrow: 1, alignItems: 'center', gap: 7},
    wideLayout: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'center',
        gap: 18,
    },
    playColumn: {alignItems: 'center', gap: 7},
    // `flexGrow` because this was a ScrollView, which grows by default on the
    // web: taking it away would have narrowed the panel and left the row
    // floating in the middle of the page.
    sidePanel: {width: 310, flexGrow: 1, flexShrink: 1, gap: 10},
    // Only as tall as its cards, and the first thing to give when the panel is
    // short — which is what leaves the chat below it a bounded box to scroll in.
    sidePanelScroll: {flexGrow: 0, flexShrink: 1, flexBasis: 'auto'},
    sidePanelContent: {gap: 10, paddingBottom: 2},
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
    firstMoveNoticeUrgent: {borderColor: colors.dangerBorder},
    firstMoveDotUrgent: {backgroundColor: colors.danger},
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
    // Five bot controls do not fit one comfortable row on a phone, so they sit
    // in two: what the engine and the reach maps can do for you, then how the
    // game ends.
    botActions: {width: '100%', gap: 7},
    hintButton: {
        borderColor: colors.accentBorder,
        backgroundColor: colors.accentSurface,
    },
    hintButtonText: {color: colors.accentSoft, fontSize: 10, fontWeight: '900'},
    // Lit only while the overlay is on the board, so the button reads as the
    // switch it is rather than as a second hint.
    reachButtonOn: {
        borderColor: colors.accentBorder,
        backgroundColor: colors.accentSurface,
    },
    reachButtonTextOn: {color: colors.accentSoft},
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
    // Beside a board this card is one line of copy and a button, and it used to
    // reserve 112 points for them with the content pushed to the top — a third
    // of the panel's width in empty card, above the list somebody is actually
    // reading. It is as tall as what is in it now.
    statusCardWide: {padding: 12},
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
    // What the score sheet is given to scroll in. Beside a board it takes the
    // column's spare room; on a phone it is a fixed slice of a page.
    historySlot: {flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 148},
    // The width is what holds the card to the page's edges. The phone column
    // centres its children, so without one the card sized itself to its
    // contents: narrower than the page at the live edge, and wider than the
    // screen once `LOOKING BACK` and the LIVE button lengthened them.
    historySlotPhone: {width: '100%', maxHeight: 320},
    // The chat's slot in the panel, which is now a wrapper's rather than the
    // card's own: the same `flex: 1` and the same floor the card carried when it
    // was a direct child, so the column divides its room exactly as it did.
    chatSlot: {flex: 1, minHeight: 190},
    historyHint: {
        ...type.meta,
        color: colors.textFaint,
        marginTop: 2,
        textAlign: 'center',
    },
    // Small enough to live at the end of the controls row without crowding the
    // buttons: the row's own zone is what keeps it off them.
    returnToLive: {
        height: 30,
        paddingHorizontal: 8,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.medium,
        borderWidth: 1,
        borderColor: colors.liveBorder,
        backgroundColor: colors.surfaceRaised,
    },
    returnToLiveText: {...type.label, fontSize: 8, color: colors.live},

    modalBackdrop: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 22,
        backgroundColor: colors.overlay,
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
    finishedCard: {
        width: '100%',
        padding: 14,
        borderRadius: radius.large,
        borderWidth: 1,
        borderColor: colors.accentBorder,
        backgroundColor: colors.surface,
    },
    finishedCardWide: {padding: 16},
    finishedSummary: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    finishedResult: {flex: 1, minWidth: 0},
    finishedScoreBlock: {alignItems: 'flex-end'},
    finishedScoreLabel: {
        color: colors.textFaint,
        fontSize: 7,
        fontWeight: '900',
        letterSpacing: 1.1,
    },
    outcomeEyebrow: {
        color: colors.accentBright,
        fontSize: 8,
        fontWeight: '900',
        letterSpacing: 1.4,
    },
    outcomeTitle: {color: colors.textStrong, fontSize: 25, fontWeight: '900', marginTop: 4},
    outcomeTitleWin: {color: colors.accentBright},
    outcomeTitleLoss: {color: colors.dangerSoft},
    outcomeScore: {
        color: colors.textSoft,
        fontSize: 17,
        fontWeight: '900',
        fontVariant: ['tabular-nums'],
        marginTop: 3,
    },
    outcomeReason: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
        marginTop: 10,
    },
    outcomeMethodBadge: {
        paddingHorizontal: 8,
        paddingVertical: 5,
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
        flex: 1,
        color: colors.textMuted,
        fontSize: 10,
        lineHeight: 14,
    },
    outcomeUnrated: {
        color: colors.goldMuted,
        fontSize: 9,
        fontWeight: '800',
        marginTop: 8,
    },
    reviewGameButton: {
        flexDirection: 'row',
        alignItems: 'center',
        width: '100%',
        marginTop: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: radius.medium,
        backgroundColor: colors.accent,
    },
    reviewGameCopy: {flex: 1, minWidth: 0},
    reviewGameButtonText: {color: colors.textStrong, fontSize: 12, fontWeight: '900'},
    reviewGameButtonDetail: {
        color: colors.accentSurface,
        fontSize: 8,
        fontWeight: '700',
        marginTop: 2,
    },
    reviewGameButtonArrow: {color: colors.textStrong, fontSize: 18, fontWeight: '900'},
    noReviewDetail: {color: colors.textFaint, fontSize: 9, lineHeight: 13, marginTop: 11},
    finishedActions: {width: '100%', flexDirection: 'row', gap: 8, marginTop: 8},
    rematchButton: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 36,
        paddingHorizontal: 10,
        borderRadius: radius.medium,
        borderWidth: 1,
        borderColor: colors.accentBorder,
        backgroundColor: colors.accentSurface,
    },
    rematchButtonText: {color: colors.accentSoft, fontSize: 11, fontWeight: '900'},
    finishedModesButton: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 36,
        paddingHorizontal: 10,
        borderRadius: radius.medium,
        backgroundColor: colors.surfaceMuted,
    },
    finishedModesButtonText: {color: colors.textSoft, fontSize: 11, fontWeight: '900'},
}));
