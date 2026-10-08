import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { openGameCards, type OpenGameCard } from './openGames';
import ModePreview from '@/features/game/ModePreview';
import { useLobbyGate } from '@/hooks/useQueueCall';
import { links } from '@/navigation/links';
import { useGameStore } from '@/store/gameStore';
import { setupSummary } from '@/store/setupSelectors';
import { titledName } from '@/store/spectateSelectors';
import { colors, radius, space, themedSheet, type } from '@/theme';
import { Badge, GhostButton, PrimaryButton, SectionHeading, TextButton } from '@/ui/primitives';

// Somebody is waiting for a game: here, near the top, at a height that never
// changes.
//
// The strip is the one part of the lobby that the server rewrites while you
// are reading it, so it is built to absorb that. Its height is fixed, empty or
// full, which is what keeps a request arriving from pushing every card below
// it down the screen; the cards run sideways instead, and a new one joins the
// end of the row (see `openGameCards`). And it reads the requests out of the
// store itself, so an arrival redraws this strip rather than the page.

/** Wide enough for a name, the terms and two actions beside a board. */
const CARD_WIDTH = 296;
const CARD_BOARD = 76;
/** The strip's height whatever it holds. Every card and the empty state fill it exactly. */
const STRIP_HEIGHT = 124;

export default function OpenGamesStrip() {
  const incomingChallenges = useGameStore((state) => state.incomingChallenges);
  const outgoingChallenge = useGameStore((state) => state.outgoingChallenge);
  const openChallenges = useGameStore((state) => state.openChallenges);
  const challengeNotice = useGameStore((state) => state.challengeNotice);
  const accountId = useGameStore((state) => state.accountId);

  const cards = useMemo(
    () =>
      openGameCards({
        incomingChallenges,
        outgoingChallenge,
        openChallenges,
        challengeNotice,
        accountId,
      }),
    [accountId, challengeNotice, incomingChallenges, openChallenges, outgoingChallenge],
  );

  // No count beside the heading. The cards are the count, and on a phone the
  // top bar is already saying how many people are waiting — two numbers for
  // "waiting" on one screen, counted slightly differently, read as a bug.
  return (
    <View style={styles.section}>
      <SectionHeading title="Open games" />
      <View style={styles.slot}>
        {cards.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nobody is waiting right now</Text>
            <Text numberOfLines={3} style={styles.emptyDetail}>
              A game somebody posts, or a challenge sent to you, shows up here. Press Play to be
              the one waiting.
            </Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.row}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.scroller}
          >
            {cards.map((card) => (
              <GameCard card={card} key={card.key} />
            ))}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

function GameCard({ card }: { card: OpenGameCard }) {
  if (card.kind === 'notice') {
    return (
      <View style={[styles.card, styles.noticeCard]}>
        <Text numberOfLines={5} style={styles.noticeText}>
          {card.message}
        </Text>
      </View>
    );
  }
  return <ChallengeCard card={card} />;
}

type ChallengeCardModel = Exclude<OpenGameCard, { kind: 'notice' }>;

/** A game on offer: the position it starts from, who, on what terms, and the way in. */
function ChallengeCard({ card }: { card: ChallengeCardModel }) {
  const { challenge } = card;
  const mode = useGameStore(
    (state) => state.modes.find((candidate) => candidate.id === challenge.setup.modeId) ?? null,
  );
  const defaultTimeControl = useGameStore((state) => state.defaultTimeControl);
  const terms = setupSummary(challenge.setup, mode, defaultTimeControl);
  const who = titledName(challenge.challenger, 'Someone');

  const title =
    card.kind === 'outgoing'
      ? challenge.targetUsername
        ? `Waiting for ${challenge.targetUsername}`
        : 'Your open game'
      : card.kind === 'incoming'
        ? `${who} challenged you`
        : who;
  const status =
    card.kind === 'outgoing'
      ? challenge.targetUsername
        ? 'they see it when they connect'
        : 'anyone can take it'
      : card.kind === 'incoming'
        ? 'only you can take it'
        : !challenge.present
          ? 'away, we will call them'
          : challenge.queued
            ? 'searching now'
            : 'waiting';

  return (
    <View style={[styles.card, card.kind === 'incoming' && styles.cardForYou]}>
      {/*
        The position the game starts from, which for a custom game is the only
        way to know what you are accepting — and, because each mode marks its
        own board, which mode it is without spending a line on it.
      */}
      <ModePreview mode={mode} position={challenge.setup.startingPosition} size={CARD_BOARD} />
      <View style={styles.cardCopy}>
        <View style={styles.cardText}>
          <View style={styles.cardHead}>
            <Text numberOfLines={1} style={styles.cardMode}>
              {(mode?.name ?? challenge.modeName).toUpperCase()}
            </Text>
            {card.kind === 'incoming' ? <Badge label="FOR YOU" tone="accent" /> : null}
            {card.kind === 'outgoing' ? <Badge label="YOURS" /> : null}
          </View>
          <Text numberOfLines={1} style={styles.cardTitle}>
            {title}
          </Text>
          <Text numberOfLines={1} style={styles.cardMeta}>
            {`${terms} · ${status}`}
          </Text>
        </View>
        <View style={styles.cardActions}>
          <CardActions card={card} who={who} terms={terms} />
        </View>
      </View>
    </View>
  );
}

function CardActions({
  card,
  terms,
  who,
}: {
  card: ChallengeCardModel;
  terms: string;
  who: string;
}) {
  const { challenge } = card;
  const gate = useLobbyGate();
  const accepting = useGameStore((state) => state.acceptingChallengeId === challenge.id);
  const acceptChallenge = useGameStore((state) => state.acceptChallenge);
  const declineChallenge = useGameStore((state) => state.declineChallenge);
  const cancelChallenge = useGameStore((state) => state.cancelChallenge);
  const locked = gate.needsAccount && !challenge.setup.casual;

  if (card.kind === 'outgoing') {
    return (
      <GhostButton
        accessibilityLabel="Cancel your challenge"
        compact
        label="CANCEL"
        onPress={() => cancelChallenge(challenge.id)}
      />
    );
  }
  if (card.kind === 'incoming') {
    return (
      <>
        {locked ? (
          <SignInToPlay />
        ) : (
          <PrimaryButton
            accessibilityLabel={`Accept the challenge from ${who}`}
            compact
            disabled={gate.atBoard || gate.paused}
            label="ACCEPT"
            loading={accepting}
            onPress={() => acceptChallenge(challenge.id)}
          />
        )}
        <TextButton
          accessibilityLabel={`Decline the challenge from ${who}`}
          disabled={accepting}
          label="Decline"
          onPress={() => declineChallenge(challenge.id)}
        />
      </>
    );
  }
  return locked ? (
    <SignInToPlay />
  ) : (
    <PrimaryButton
      accessibilityLabel={`Play ${who}: ${terms}`}
      compact
      label="PLAY ▶"
      loading={accepting}
      onPress={() => acceptChallenge(challenge.id)}
    />
  );
}

/**
 * The button on somebody else's rated game when you have no account.
 *
 * The server refuses a guest a rated game, because the setup belongs to
 * whoever posted it — silently turning their game casual would change what they
 * advertised. So rather than greying the control out, this offers the thing
 * that would make it work. Casual games are unaffected and stay playable.
 */
function SignInToPlay() {
  const router = useRouter();
  return (
    <PrimaryButton
      accessibilityLabel="Sign in to play ranked games"
      compact
      label="SIGN IN"
      onPress={() => router.push(links.account())}
      tone="quiet"
    />
  );
}

const styles = themedSheet(() => ({
  section: { gap: space.medium },
  // The fixed height is the whole trick. Nothing the server sends can change
  // it, so nothing below it can move.
  slot: { height: STRIP_HEIGHT },
  scroller: { flexGrow: 0 },
  row: { gap: space.small, alignItems: 'stretch' },

  card: {
    width: CARD_WIDTH,
    height: STRIP_HEIGHT,
    flexDirection: 'row',
    gap: space.medium,
    padding: space.medium,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  // Addressed to you by name, so it stands out from the row — by its edge, the
  // way every other state on this page does, not by a colour of its own.
  cardForYou: { borderColor: colors.borderLight, backgroundColor: colors.surfaceRaised },
  cardCopy: { flex: 1, minWidth: 0, justifyContent: 'space-between' },
  cardText: { gap: space.hair },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.snug, minHeight: 20 },
  cardMode: { ...type.label, color: colors.textMuted, flexShrink: 1 },
  cardTitle: { ...type.rowTitle, fontSize: 14, color: colors.textStrong },
  cardMeta: { ...type.meta, color: colors.textFaint },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: space.medium },

  noticeCard: { alignItems: 'center', backgroundColor: colors.surfaceRaised },
  noticeText: { ...type.body, flex: 1, color: colors.textSoft },

  // The same height as a card, so the first request to arrive replaces this
  // rather than growing the strip.
  empty: {
    height: STRIP_HEIGHT,
    justifyContent: 'center',
    gap: space.tight,
    paddingHorizontal: space.large,
    borderRadius: radius.large,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
  },
  emptyTitle: { ...type.rowTitle, fontSize: 14, color: colors.text },
  emptyDetail: { ...type.body, color: colors.textMuted },
}));
