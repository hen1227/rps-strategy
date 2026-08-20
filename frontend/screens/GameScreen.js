import { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Board from '../components/Board';
import TerritoryMeter from '../components/TerritoryMeter';
import { useGameStore } from '../store/gameStore';

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

  return { detail: reason.detail, didWin, isDraw, method: reason.method, result };
};

function LiveClock({ clock, color, gameStatus }) {
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

function PlayerBar({ clock, color, gameStatus, isYou, profile }) {
  const isActive = gameStatus === 'InProgress' && clock?.activeColor === color;
  const label = isYou ? 'You' : 'Opponent';

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
        </View>
        <Text style={[styles.playerMeta, isActive && styles.playerMetaActive]}>
          {isActive ? 'Thinking' : color}
        </Text>
      </View>
      <LiveClock clock={clock} color={color} gameStatus={gameStatus} />
    </View>
  );
}

function OpponentReconnectNotice({ deadline }) {
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
      <View style={styles.reconnectDot} />
      <View style={styles.reconnectCopy}>
        <Text style={styles.reconnectTitle}>Opponent disconnected</Text>
        <Text style={styles.reconnectDetail}>
          Waiting {seconds}s before you win by abandonment.
        </Text>
      </View>
    </View>
  );
}

function DrawOfferNotice({ disabled, onAccept, onDecline }) {
  return (
    <View style={styles.drawOfferNotice}>
      <View style={styles.drawOfferCopy}>
        <Text style={styles.drawOfferTitle}>Draw offered</Text>
        <Text style={styles.drawOfferDetail}>Accept, ignore, or keep playing to decline.</Text>
      </View>
      <View style={styles.drawOfferButtons}>
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={onDecline}
          style={({ pressed }) => [
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
          style={({ pressed }) => [
            styles.drawAcceptButton,
            disabled && styles.actionButtonDisabled,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text style={styles.drawAcceptText}>Accept</Text>
        </Pressable>
      </View>
    </View>
  );
}

function GameActions({ connected, gameState, isMyTurn, onDraw, onResign, playerColor }) {
  const offeredByMe = gameState.drawOfferedBy === playerColor;
  const hasOpponentOffer =
    gameState.drawOfferedBy && gameState.drawOfferedBy !== playerColor;
  const usedThisTurn = gameState.drawOfferUsedBy === playerColor;
  const drawDisabled =
    !connected || !isMyTurn || Boolean(hasOpponentOffer) || offeredByMe || usedThisTurn;
  const drawLabel = offeredByMe || usedThisTurn ? 'Draw offered' : 'Offer draw';

  return (
    <View style={styles.gameActions}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: drawDisabled }}
        disabled={drawDisabled}
        onPress={onDraw}
        style={({ pressed }) => [
          styles.actionButton,
          drawDisabled && styles.actionButtonDisabled,
          pressed && styles.buttonPressed,
        ]}
      >
        <Text style={[styles.actionButtonText, drawDisabled && styles.actionButtonTextDisabled]}>
          {drawLabel}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !connected }}
        disabled={!connected}
        onPress={onResign}
        style={({ pressed }) => [
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

function ConfirmResignModal({ onCancel, onConfirm, visible }) {
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
          <Text style={styles.confirmDetail}>Your opponent will win immediately.</Text>
          <View style={styles.confirmButtons}>
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              style={({ pressed }) => [styles.confirmCancel, pressed && styles.buttonPressed]}
            >
              <Text style={styles.confirmCancelText}>Keep playing</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={onConfirm}
              style={({ pressed }) => [styles.confirmResign, pressed && styles.buttonPressed]}
            >
              <Text style={styles.confirmResignText}>Resign</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function OutcomeModal({ gameState, onReview, onReturn, playerColor, visible }) {
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
          <View style={styles.outcomeButtons}>
            <Pressable
              accessibilityRole="button"
              onPress={onReview}
              style={({ pressed }) => [styles.reviewButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.reviewButtonText}>Review board</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={onReturn}
              style={({ pressed }) => [styles.outcomeReturnButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.outcomeReturnText}>Back to modes</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function StatusContent({ gameState, isMyTurn, playerColor, selectedTile }) {
  if (gameState.status === 'Finished') {
    const isDraw = gameState.winner === 'Neutral';
    const didWin = gameState.winner === playerColor;
    const title = isDraw ? 'Draw' : didWin ? 'You won' : 'Opponent won';
    const detail = outcomeFor(gameState, playerColor).detail;
    return { title, detail, tone: didWin ? 'positive' : isDraw ? 'neutral' : 'negative' };
  }

  if (!isMyTurn) {
    return { title: "Opponent's move", detail: 'Their clock is running.', tone: 'neutral' };
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

function StatusCard({ gameState, isMyTurn, onReturn, playerColor, selectedTile, wide }) {
  const status = StatusContent({ gameState, isMyTurn, playerColor, selectedTile });
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
          <View style={styles.statusIconCore} />
        </View>
        <View style={styles.statusCopy}>
          <Text style={styles.statusTitle}>{status.title}</Text>
          <Text style={styles.statusDetail} numberOfLines={wide ? 3 : 1}>
            {status.detail}
          </Text>
        </View>
      </View>

      {isFinished ? (
        <Pressable
          accessibilityRole="button"
          onPress={onReturn}
          style={({ pressed }) => [styles.returnButton, pressed && styles.buttonPressed]}
        >
          <Text style={styles.returnButtonText}>Modes</Text>
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

export default function GameScreen({ navigation }) {
  const { height, width } = useWindowDimensions();
  const [reviewedResultId, setReviewedResultId] = useState(null);
  const [showResignConfirmation, setShowResignConfirmation] = useState(false);
  const gameState = useGameStore((state) => state.gameState);
  const lastMove = useGameStore((state) => state.lastMove);
  const playerColor = useGameStore((state) => state.playerColor);
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
  const resignGame = useGameStore((state) => state.resignGame);
  const clearGame = useGameStore((state) => state.clearGame);
  const error = useGameStore((state) => state.error);
  const clearError = useGameStore((state) => state.clearError);

  if (!gameState) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>No active match</Text>
          <Text style={styles.emptyBody}>Return to the mode screen to find an opponent.</Text>
          <Pressable
            onPress={() => navigation.goBack()}
            style={({ pressed }) => [styles.emptyButton, pressed && styles.buttonPressed]}
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
  const opponentColor = otherColor(playerColor);
  const myProfile = playerColor === 'Red' ? gameState.redPlayer : gameState.bluePlayer;
  const opponentProfile = playerColor === 'Red' ? gameState.bluePlayer : gameState.redPlayer;
  const isConnected = connectionStatus === 'connected';
  const isMyTurn =
    isConnected && gameState.status === 'InProgress' && gameState.currentTurn === playerColor;
  const timeControlLabel = formatTimeControl(gameState.timeControl);
  const hasOpponentDrawOffer =
    gameState.status === 'InProgress' &&
    gameState.drawOfferedBy &&
    gameState.drawOfferedBy !== playerColor;
  const showOutcome =
    gameState.status === 'Finished' && reviewedResultId !== gameState.gameId;

  const returnToModes = () => {
    clearGame();
    navigation.goBack();
  };

  const confirmResign = () => {
    setShowResignConfirmation(false);
    resignGame();
  };

  const matchNotices = (
    <>
      {!isConnected && gameState.status === 'InProgress' && (
        <View style={styles.selfReconnectNotice}>
          <Text style={styles.selfReconnectText}>Reconnecting to your match…</Text>
        </View>
      )}
      <OpponentReconnectNotice deadline={opponentReconnectDeadline} />
      {hasOpponentDrawOffer && (
        <DrawOfferNotice
          disabled={!isConnected}
          onAccept={acceptDraw}
          onDecline={declineDraw}
        />
      )}
    </>
  );

  const gameActions = gameState.status === 'InProgress' ? (
    <GameActions
      connected={isConnected}
      gameState={gameState}
      isMyTurn={isMyTurn}
      onDraw={offerDraw}
      onResign={() => setShowResignConfirmation(true)}
      playerColor={playerColor}
    />
  ) : null;

  const playerBars = (
    <>
      <PlayerBar
        clock={gameState.clock}
        color={opponentColor}
        gameStatus={gameState.status}
        isYou={false}
        profile={opponentProfile}
      />
      <Board
        boardSize={boardSize}
        canMove={isMyTurn}
        grid={gameState.grid}
        lastMove={lastMove}
        modeId={gameState.mode.id}
        onPieceDrop={movePiece}
        onTilePress={selectTile}
        playerColor={playerColor}
        selectedTile={selectedTile}
        validMoves={validMoves}
      />
      <PlayerBar
        clock={gameState.clock}
        color={playerColor}
        gameStatus={gameState.status}
        isYou
        profile={myProfile}
      />
    </>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <View style={styles.screen}>
        <View style={styles.topBar}>
          <View style={styles.matchIdentity}>
            <Text style={styles.matchKicker}>
              {gameState.mode.shortCode} · {gameState.status === 'InProgress' ? 'LIVE MATCH' : 'FINAL'}
            </Text>
            <Text style={styles.modeName}>{gameState.mode.name}</Text>
          </View>
          <View style={styles.timeControlBadge}>
            <Text style={styles.timeControlLabel}>TIME CONTROL</Text>
            <Text style={styles.timeControlValue}>{timeControlLabel}</Text>
          </View>
        </View>

        {isWide ? (
          <View style={styles.wideLayout}>
            <View style={styles.playColumn}>{playerBars}</View>
            <View style={[styles.sidePanel, { height: boardSize + 120 }]}>
              <StatusCard
                gameState={gameState}
                isMyTurn={isMyTurn}
                onReturn={returnToModes}
                playerColor={playerColor}
                selectedTile={selectedTile}
                wide
              />

              {matchNotices}
              {gameActions}

              <View style={styles.detailCard}>
                <Text style={styles.detailEyebrow}>OBJECTIVE</Text>
                <Text style={styles.detailTitle}>{gameState.mode.description}</Text>
                <Text style={styles.detailBody}>{gameState.mode.objective}</Text>
              </View>

              {hasTerritory && <TerritoryMeter grid={gameState.grid} />}

              <View style={styles.matchFacts}>
                <View>
                  <Text style={styles.factLabel}>MOVE</Text>
                  <Text style={styles.factValue}>{gameState.moveNumber + 1}</Text>
                </View>
                <View style={styles.factDivider} />
                <View>
                  <Text style={styles.factLabel}>CLOCK</Text>
                  <Text style={styles.factValue}>{timeControlLabel}</Text>
                </View>
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.mobileLayout}>
            {playerBars}
            {hasTerritory && <TerritoryMeter grid={gameState.grid} />}
            {matchNotices}
            {gameActions}
            <StatusCard
              gameState={gameState}
              isMyTurn={isMyTurn}
              onReturn={returnToModes}
              playerColor={playerColor}
              selectedTile={selectedTile}
            />
          </View>
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

        <ConfirmResignModal
          onCancel={() => setShowResignConfirmation(false)}
          onConfirm={confirmResign}
          visible={showResignConfirmation}
        />
        <OutcomeModal
          gameState={gameState}
          onReview={() => setReviewedResultId(gameState.gameId)}
          onReturn={returnToModes}
          playerColor={playerColor}
          visible={showOutcome}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0e1116' },
  screen: {
    flex: 1,
    width: '100%',
    maxWidth: 1180,
    alignSelf: 'center',
    paddingHorizontal: 10,
    paddingTop: 7,
    paddingBottom: 8,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { color: '#f4f6f8', fontSize: 25, fontWeight: '900' },
  emptyBody: { color: '#929ba8', marginTop: 8, textAlign: 'center' },
  emptyButton: {
    marginTop: 22,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 9,
    backgroundColor: '#72d4bf',
  },
  emptyButtonText: { color: '#10201d', fontWeight: '900' },
  buttonPressed: { opacity: 0.72 },
  topBar: {
    minHeight: 47,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 7,
    paddingHorizontal: 4,
  },
  matchKicker: { color: '#72d4bf', fontSize: 8, fontWeight: '900', letterSpacing: 1.4 },
  modeName: { color: '#f4f6f8', fontSize: 20, fontWeight: '900', marginTop: 2 },
  timeControlBadge: {
    minWidth: 88,
    alignItems: 'flex-end',
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#2d3440',
    backgroundColor: '#181d25',
  },
  timeControlLabel: { color: '#6f7a88', fontSize: 7, fontWeight: '900', letterSpacing: 1.1 },
  timeControlValue: { color: '#f4f6f8', fontSize: 15, fontWeight: '900', marginTop: 1 },
  mobileLayout: { flex: 1, alignItems: 'center', gap: 7 },
  wideLayout: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 18,
  },
  playColumn: { alignItems: 'center', gap: 7 },
  sidePanel: { width: 310, gap: 10 },
  playerBar: {
    width: '100%',
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 5,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  playerBarActive: { borderColor: '#283e3b', backgroundColor: '#131b20' },
  avatar: {
    width: 35,
    height: 35,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    borderWidth: 1,
  },
  redAvatar: { backgroundColor: '#733b42', borderColor: '#a45a61' },
  blueAvatar: { backgroundColor: '#324f70', borderColor: '#4d739c' },
  avatarText: { color: '#ffffff', fontSize: 14, fontWeight: '900' },
  playerCopy: { flex: 1, minWidth: 0, paddingHorizontal: 9 },
  playerNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  playerName: { maxWidth: '75%', color: '#e9edf1', fontSize: 13, fontWeight: '800' },
  youLabel: { color: '#72d4bf', fontSize: 7, fontWeight: '900', letterSpacing: 1 },
  playerMeta: { color: '#697380', fontSize: 9, fontWeight: '700', marginTop: 2 },
  playerMetaActive: { color: '#92a6a3' },
  clock: {
    minWidth: 100,
    height: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 7,
    paddingHorizontal: 11,
    borderRadius: 8,
    backgroundColor: '#202630',
  },
  clockActive: { backgroundColor: '#e7ecef' },
  clockLow: { backgroundColor: '#ffe9e7' },
  clockPulse: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#525d6b' },
  clockPulseActive: { backgroundColor: '#32a98f' },
  clockPulseLow: { backgroundColor: '#d44c4c' },
  clockText: {
    color: '#c7ced6',
    fontSize: 22,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.6,
  },
  clockTextActive: { color: '#192127' },
  clockTextLow: { color: '#a63232' },
  selfReconnectNotice: {
    width: '100%',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#725f32',
    backgroundColor: '#29251b',
  },
  selfReconnectText: { color: '#e4c879', fontSize: 10, fontWeight: '800' },
  reconnectNotice: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#725f32',
    backgroundColor: '#29251b',
  },
  reconnectDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginRight: 9,
    backgroundColor: '#d5ae4f',
  },
  reconnectCopy: { flex: 1 },
  reconnectTitle: { color: '#f0deb0', fontSize: 10, fontWeight: '900' },
  reconnectDetail: { color: '#ad9d75', fontSize: 8, marginTop: 2 },
  drawOfferNotice: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#3b625b',
    backgroundColor: '#172724',
  },
  drawOfferCopy: { flex: 1, minWidth: 0 },
  drawOfferTitle: { color: '#dff7f0', fontSize: 10, fontWeight: '900' },
  drawOfferDetail: { color: '#88aaa1', fontSize: 8, marginTop: 2 },
  drawOfferButtons: { flexDirection: 'row', gap: 5 },
  drawIgnoreButton: {
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 7,
    backgroundColor: '#2b3b38',
  },
  drawIgnoreText: { color: '#b9ccc7', fontSize: 9, fontWeight: '800' },
  drawAcceptButton: {
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 7,
    backgroundColor: '#72d4bf',
  },
  drawAcceptText: { color: '#10201d', fontSize: 9, fontWeight: '900' },
  gameActions: { width: '100%', flexDirection: 'row', gap: 7 },
  actionButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#38414c',
    backgroundColor: '#202630',
  },
  actionButtonDisabled: { opacity: 0.42 },
  actionButtonText: { color: '#dbe1e6', fontSize: 10, fontWeight: '900' },
  actionButtonTextDisabled: { color: '#88919b' },
  resignButton: { borderColor: '#53383b', backgroundColor: '#2b2023' },
  resignButtonText: { color: '#e3a2a7', fontSize: 10, fontWeight: '900' },
  statusCard: {
    width: '100%',
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#29313c',
    backgroundColor: '#171b22',
  },
  statusCardWide: {
    minHeight: 112,
    alignItems: 'flex-start',
    padding: 14,
  },
  statusLead: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  statusIcon: {
    width: 27,
    height: 27,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: '#303844',
  },
  statusIconPositive: { backgroundColor: '#21463f' },
  statusIconNegative: { backgroundColor: '#553033' },
  statusIconCore: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#f0f3f5' },
  statusCopy: { flex: 1, minWidth: 0, marginLeft: 9 },
  statusTitle: { color: '#f1f3f5', fontSize: 13, fontWeight: '900' },
  statusDetail: { color: '#828c99', fontSize: 9, lineHeight: 13, marginTop: 2 },
  moveBadge: { alignItems: 'flex-end', paddingLeft: 4 },
  moveBadgeLabel: { color: '#626d7a', fontSize: 7, fontWeight: '900', letterSpacing: 1 },
  moveBadgeValue: { color: '#dce1e6', fontSize: 17, fontWeight: '900' },
  returnButton: {
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#72d4bf',
  },
  returnButtonText: { color: '#12201e', fontSize: 11, fontWeight: '900' },
  detailCard: {
    padding: 15,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#29313c',
    backgroundColor: '#171b22',
  },
  detailEyebrow: { color: '#72d4bf', fontSize: 8, fontWeight: '900', letterSpacing: 1.3 },
  detailTitle: { color: '#f0f3f5', fontSize: 18, fontWeight: '900', marginTop: 8 },
  detailBody: { color: '#8c96a3', fontSize: 12, lineHeight: 18, marginTop: 5 },
  matchFacts: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 11,
    backgroundColor: '#171b22',
    borderWidth: 1,
    borderColor: '#29313c',
  },
  factLabel: { color: '#626d7a', fontSize: 7, fontWeight: '900', letterSpacing: 1.1 },
  factValue: { color: '#e8ecf0', fontSize: 16, fontWeight: '900', marginTop: 3 },
  factDivider: { width: 1, height: 30, marginHorizontal: 22, backgroundColor: '#323a46' },
  errorBanner: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderRadius: 9,
    backgroundColor: '#733b3f',
    boxShadow: [
      { offsetX: 0, offsetY: 5, blurRadius: 8, color: 'rgba(0, 0, 0, 0.32)' },
    ],
    elevation: 9,
  },
  errorText: { flex: 1, color: '#ffe2df', fontSize: 11, fontWeight: '700' },
  errorDismiss: { color: '#ffe2df', fontSize: 19, paddingHorizontal: 4 },
  modalBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 22,
    backgroundColor: 'rgba(4, 7, 10, 0.78)',
  },
  confirmCard: {
    width: '100%',
    maxWidth: 360,
    padding: 20,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#39414c',
    backgroundColor: '#181d25',
    boxShadow: [
      { offsetX: 0, offsetY: 10, blurRadius: 18, color: 'rgba(0, 0, 0, 0.45)' },
    ],
    elevation: 18,
  },
  confirmTitle: { color: '#f4f6f8', fontSize: 20, fontWeight: '900' },
  confirmDetail: { color: '#929ba8', fontSize: 12, lineHeight: 18, marginTop: 7 },
  confirmButtons: { flexDirection: 'row', gap: 8, marginTop: 20 },
  confirmCancel: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: 9,
    backgroundColor: '#29313b',
  },
  confirmCancelText: { color: '#d9dfe5', fontSize: 11, fontWeight: '900' },
  confirmResign: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: 9,
    backgroundColor: '#a84750',
  },
  confirmResignText: { color: '#ffffff', fontSize: 11, fontWeight: '900' },
  outcomeCard: {
    width: '100%',
    maxWidth: 390,
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 20,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#3a434f',
    backgroundColor: '#181d25',
    boxShadow: [
      { offsetX: 0, offsetY: 12, blurRadius: 22, color: 'rgba(0, 0, 0, 0.5)' },
    ],
    elevation: 20,
  },
  outcomeEyebrow: { color: '#737f8d', fontSize: 8, fontWeight: '900', letterSpacing: 1.7 },
  outcomeTitle: { color: '#f4f6f8', fontSize: 32, fontWeight: '900', marginTop: 9 },
  outcomeTitleWin: { color: '#72d4bf' },
  outcomeTitleLoss: { color: '#e3a2a7' },
  outcomeScore: {
    color: '#d9dfe5',
    fontSize: 22,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
    marginTop: 8,
  },
  outcomeMethodBadge: {
    marginTop: 14,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 7,
    backgroundColor: '#273139',
  },
  outcomeMethod: { color: '#a9b5bf', fontSize: 8, fontWeight: '900', letterSpacing: 1.15 },
  outcomeDetail: {
    color: '#929ba8',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 13,
    textAlign: 'center',
  },
  outcomeButtons: { width: '100%', gap: 8, marginTop: 22 },
  reviewButton: {
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: 9,
    backgroundColor: '#29313b',
  },
  reviewButtonText: { color: '#d9dfe5', fontSize: 11, fontWeight: '900' },
  outcomeReturnButton: {
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 9,
    backgroundColor: '#72d4bf',
  },
  outcomeReturnText: { color: '#10201d', fontSize: 11, fontWeight: '900' },
});
