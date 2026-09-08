import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { failureMessage } from '@/errors';
import { useNow } from '@/hooks/useNow';
import { useWatchGame } from '@/hooks/useWatchGame';
import {
  castWeekendVote,
  loadWeekend,
  setWeekendAvailability,
  type WeekendPoll,
  type WeekendSlot,
  type WeekendView,
} from '@/store/api/weekend';
import { useGameStore } from '@/store/gameStore';
import { matchesOf, playedMatchCount, statusOf } from '@/store/tournamentSelectors';
import { colors, contentWidth, radius, space, type } from '@/theme';
import type { Tournament } from '@/types/protocol';
import ScreenShell from '@/ui/ScreenShell';
import { Badge, Banner, EmptyState, Panel, SectionHeading } from '@/ui/primitives';
import TournamentMatchRow from '@/features/tournaments/TournamentMatchRow';

// The weekend bot arena.
//
// One page for a thing that is only actually happening for an hour a week, so
// most of the time it is about the *next* one: a countdown, the two votes, and
// the engines expected to turn up. The other six days are the reason the history
// and the crown are on the same page rather than behind a link.
//
// It reads through one endpoint rather than the tournament store. The store has
// this weekend's event once its doors open — the arena rides the same broadcast
// as every other tournament — but not the schedule, the polls, the roster or the
// crown, and a page assembled from two sources shows them disagreeing.

/**
 * A countdown as words, from a millisecond gap.
 *
 * Says nothing until the browser has a clock. These pages are pre-rendered in
 * Node, and a countdown baked into static HTML is wrong by however long the
 * file sat on a CDN — see useNow.
 */
const countdown = (until: number, now: number | null): string => {
  if (now === null) return '—';
  const seconds = Math.max(0, Math.floor((until - now) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
};

const timeOfDay = (unixMs?: number) =>
  unixMs
    ? new Date(unixMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '—';

/**
 * A moment as a weekday and a time, both in the reader's own zone.
 *
 * The weekday is not decoration. A weekly event has to say *which* night it
 * means, and the host's answer does not survive the trip: the slot the host
 * calls Saturday 21:00 is Sunday lunchtime in Auckland. Naming the day from the
 * instant is the only way both readers see something true.
 */
const dayAndTime = (unixMs?: number) =>
  unixMs
    ? `${new Date(unixMs).toLocaleDateString(undefined, { weekday: 'long' })} ${timeOfDay(unixMs)}`
    : '—';

/** The weekday name the host's schedule is written in, for the plan line. */
const HOST_DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** The reader's own zone, as a short name to put beside a time. */
const localZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone.split('/').pop()
      ?.replace(/_/g, ' ') ?? 'your time';
  } catch {
    return 'your time';
  }
};

/** One day of the reader's own week, and the slots that fall on it. */
interface SlotDay {
  key: string;
  day: string;
  date: string;
  slots: WeekendSlot[];
}

/**
 * The window, cut into the reader's own days.
 *
 * Chronological, and grouped by the local date of each slot rather than by
 * anything the server said — which is what makes the Saturday heading a
 * Saturday for the person reading it. Thirty-six hours is two of the host's
 * days and can be three of anybody else's; the grouping does not care, and that
 * is the point.
 *
 * Slots with no instant are dropped rather than drawn. That only happens
 * against a server older than this build, and a cell labelled January 1970 is
 * worse than one cell fewer.
 */
const groupByDay = (slots: WeekendSlot[]): SlotDay[] => {
  const days: SlotDay[] = [];
  for (const slot of [...slots]
    .filter((entry) => entry.atUnixMs > 0)
    .sort((left, right) => left.atUnixMs - right.atUnixMs)) {
    const when = new Date(slot.atUnixMs);
    const key = when.toDateString();
    const last = days[days.length - 1];
    if (last?.key === key) {
      last.slots.push(slot);
      continue;
    }
    days.push({
      key,
      day: when.toLocaleDateString(undefined, { weekday: 'long' }),
      date: when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      slots: [slot],
    });
  }
  return days;
};

export default function WeekendScreen() {
  const sessionToken = useGameStore((state) => state.sessionToken);
  const accountId = useGameStore((state) => state.accountId);
  const watchGame = useWatchGame();
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const spectatedGameId = useGameStore((state) => state.spectatedGameId);
  // A second is the right granularity for a countdown and cheap enough: this
  // page has nothing else moving.
  const now = useNow(1000);

  const [view, setView] = useState<WeekendView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [voting, setVoting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await loadWeekend(sessionToken));
      setError(null);
    } catch (requestError) {
      setError(failureMessage(requestError, 'The weekend arena could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

  useEffect(() => {
    void refresh();
    // Slow, because nothing here changes second to second except the countdown,
    // which is local. This is for the roster filling up and the votes coming in.
    const timer = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const vote = async (kind: 'clock', choice: string) => {
    if (!sessionToken) return;
    setVoting(`${kind}:${choice}`);
    setError(null);
    try {
      setView(await castWeekendVote(sessionToken, choice));
    } catch (requestError) {
      setError(failureMessage(requestError, 'Your vote could not be counted.'));
    } finally {
      setVoting(null);
    }
  };

  /**
   * Toggling a slot sends the whole set back.
   *
   * Optimistic on the pressed cell only: the grid is thirty-six targets and
   * people sweep across several, so waiting for a round trip before the cell
   * fills in makes it feel broken.
   */
  const toggleSlot = async (slot: number) => {
    if (!sessionToken || !view) return;
    const wanted = new Set(
      view.availability.slots.filter((entry) => entry.mine).map((entry) => entry.slot),
    );
    if (wanted.has(slot)) wanted.delete(slot);
    else wanted.add(slot);
    setVoting(`slot:${slot}`);
    setError(null);
    try {
      setView(await setWeekendAvailability(sessionToken, [...wanted]));
    } catch (requestError) {
      setError(failureMessage(requestError, 'That could not be saved.'));
    } finally {
      setVoting(null);
    }
  };

  const tournament = view?.tournament ?? null;
  const expected = useMemo(() => view?.expected ?? [], [view]);
  const eligible = useMemo(
    () => expected.filter((engine) => !engine.reason).length,
    [expected],
  );
  const live = tournament?.status === 'in_progress';
  const spectateDisabled = connectionStatus !== 'connected' || Boolean(spectatedGameId);

  if (loading) {
    return (
      <ScreenShell width={contentWidth.standard}>
        <View style={styles.loading}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell width={contentWidth.standard}>
      <>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>RPS STRATEGY</Text>
          <Text style={styles.title}>Weekend Bot Arena</Text>
          <Text style={styles.blurb}>
            Every engine that is online, once a weekend.
          </Text>
        </View>

        {error ? (
          <View style={styles.banner}>
            <Banner message={error} onDismiss={() => setError(null)} tone="error" />
          </View>
        ) : null}

        {!view?.enabled ? (
          <Panel>
            <EmptyState
              detail="The host has not switched the weekend arena on yet. When they do, this page is where it happens."
              title="No weekend arena scheduled"
            />
          </Panel>
        ) : null}

        {view?.enabled ? (
          <Panel tone={live ? 'accent' : 'default'}>
            <SectionHeading
              eyebrow={tournament ? 'THIS WEEKEND' : 'NEXT UP'}
              title={tournament?.name ?? `Arena on ${dayAndTime(view.startsAtUnixMs)}`}
              trailing={
                tournament ? (
                  <Badge label={statusOf(tournament).label} tone={statusOf(tournament).tone} />
                ) : null
              }
            />
            <View style={styles.stats}>
              <Stat
                label={live ? 'Playing' : tournament ? 'Starts in' : 'Doors open in'}
                value={
                  live
                    ? `${playedMatchCount(tournament)}/${matchesOf(tournament).length}`
                    : countdown(
                        (tournament ? view.startsAtUnixMs : view.doorsAtUnixMs) ?? 0,
                        now,
                      )
                }
              />
              <Stat
                label="Field"
                value={
                  tournament && tournament.players.length > 0
                    ? `${tournament.players.length} engines`
                    : `${eligible} expected`
                }
              />
              <Stat
                label="Clock"
                value={
                  tournament && tournament.status !== 'registration'
                    ? `${Math.round((tournament.initialTimeMs ?? 0) / 1000)}s +${Math.round(
                        (tournament.incrementMs ?? 0) / 1000,
                      )}`
                    : view.clock.leading
                }
              />
              <Stat label="Games per match" value={String(view.gamesPerMatch)} />
            </View>
            <Text style={styles.plan}>
              {view.modeName} · rated · colours swap every game ·{' '}
              {eligible <= view.roundRobinMax
                ? 'everybody plays everybody'
                : 'Swiss pairing'}{' '}
              · needs {view.minimumField} engines to run · the host&apos;s clock says{' '}
              {HOST_DAYS[view.startDay] ?? 'Saturday'} {view.startLocal}{' '}
              {view.zone.replace(/^.*\//, '').replace(/_/g, ' ')}
            </Text>
          </Panel>
        ) : null}

        {live && tournament ? (
          <Panel>
            <SectionHeading eyebrow="ON THE BOARDS" title="Live now" />
            {matchesOf(tournament)
              .filter((match) => match.result === 'pending')
              .slice(0, 8)
              .map((match) => (
                <TournamentMatchRow
                  accountId={accountId}
                  key={match.matchId}
                  match={match}
                  onWatch={watchGame}
                  spectateDisabled={spectateDisabled}
                  tournament={tournament}
                />
              ))}
          </Panel>
        ) : null}

        {tournament && tournament.standings.length > 0 ? (
          <Panel>
            <SectionHeading eyebrow="THE TABLE" title="Standings" />
            {tournament.standings.slice(0, 12).map((standing) => (
              <View key={standing.playerId} style={styles.standing}>
                <Text style={styles.rank}>{standing.rank}</Text>
                <Text style={styles.standingName} numberOfLines={1}>
                  {standing.ign}
                </Text>
                <Text style={styles.standingMeta}>
                  {standing.wins}–{standing.losses}–{standing.draws}
                </Text>
                <Text style={styles.points}>{standing.points}</Text>
              </View>
            ))}
          </Panel>
        ) : null}

        {view?.enabled ? (
          <Panel>
            <SectionHeading
              eyebrow="YOU DECIDE"
              title="This weekend's time control"
              trailing={
                <Badge
                  label={view.clock.open ? `${view.clock.votes} VOTES` : 'LOCKED'}
                  tone={view.clock.open ? 'accent' : 'neutral'}
                />
              }
            />
            <PollRows
              busy={voting}
              kind="clock"
              onVote={vote}
              poll={view.clock}
              signedIn={Boolean(sessionToken)}
            />
            {view.clock.votes < view.clock.minimumVotes ? (
              <Text style={styles.pollNote}>
                {`${view.clock.minimumVotes} votes are needed to carry the ballot and there ${
                  view.clock.votes === 1 ? 'is 1 so far' : `are ${view.clock.votes} so far`
                }, so this weekend plays ${view.clock.leading} unless that changes.`}
              </Text>
            ) : null}
            <Text style={styles.pollNote}>
              {view.clock.open
                ? `Closes ${dayAndTime(view.clock.closesAtUnixMs)}. Change your mind as often as you like until then.`
                : 'Voting has closed for this weekend. The next ballot opens when this event finishes.'}
            </Text>
          </Panel>
        ) : null}

        {/*
          Hidden rather than drawn empty when the window has no slots, which
          happens against a server older than this build. A panel headed "when
          can you play" with nothing under it is worse than no panel.
        */}
        {view?.enabled && view.availability.slots.length > 0 ? (
          <Panel>
            <SectionHeading
              eyebrow="YOU DECIDE"
              title="When can you play?"
              trailing={
                <Badge
                  label={`${view.availability.answered} ANSWERED`}
                  tone={view.availability.answered > 0 ? 'accent' : 'neutral'}
                />
              }
            />
            <Text style={styles.pollNote}>
              Both the day and the time are in YOUR time zone: {localZone()}. The same
              slot is Saturday evening for some people and Sunday morning for others,
              so tick the ones that work where you are.
            </Text>
            <SlotGrid
              busy={voting}
              days={groupByDay(view.availability.slots)}
              leading={view.availability.leading}
              onToggle={toggleSlot}
              signedIn={Boolean(sessionToken)}
            />
            <Text style={styles.pollNote}>
              {view.availability.leadingAtUnixMs
                ? `Leading: ${dayAndTime(view.availability.leadingAtUnixMs)} your time. `
                : ''}
              Whatever leads when this weekend&apos;s event starts becomes next
              weekend&apos;s slot, so the schedule only ever moves a week ahead. A tie
              holds it where it is.
            </Text>
          </Panel>
        ) : null}

        {expected.length > 0 ? (
          <Panel>
            <SectionHeading
              eyebrow="WHO IS COMING"
              title="Expected field"
              trailing={<Badge label={`${eligible} ELIGIBLE`} tone="accent" />}
            />
            {expected.map((engine) => (
              <View key={engine.userId || engine.name} style={styles.engine}>
                <View
                  style={[styles.dot, engine.reason ? styles.dotOut : styles.dotIn]}
                />
                <View style={styles.engineCopy}>
                  <Text style={styles.engineName} numberOfLines={1}>
                    {engine.name}
                  </Text>
                  <Text style={styles.engineMeta} numberOfLines={1}>
                    {engine.reason
                      ? engine.reason
                      : engine.author
                        ? `by ${engine.author}`
                        : 'online'}
                  </Text>
                </View>
              </View>
            ))}
          </Panel>
        ) : null}

        {(view?.crown?.length ?? 0) > 0 ? (
          <Panel>
            <SectionHeading eyebrow="THE LAST 90 DAYS" title="Reigning champion" />
            {(view?.crown ?? []).map((holder) => (
              <View key={holder.userId} style={styles.engine}>
                <Text style={styles.crown}>♛</Text>
                <View style={styles.engineCopy}>
                  <Text style={styles.engineName}>{holder.name}</Text>
                  <Text style={styles.engineMeta}>
                    {holder.wins} weekend{holder.wins === 1 ? '' : 's'} won
                  </Text>
                </View>
              </View>
            ))}
            <Text style={styles.pollNote}>
              Held by whoever has won the most weekends in the last ninety days, and lost
              the moment somebody passes them.
            </Text>
          </Panel>
        ) : null}

        {(view?.recent?.length ?? 0) > 0 ? (
          <Panel>
            <SectionHeading eyebrow="THE SERIES" title="Recent weekends" />
            {(view?.recent ?? []).map((event: Tournament) => (
              <View key={event.tournamentId} style={styles.night}>
                <Text style={styles.nightName} numberOfLines={1}>
                  {event.name}
                </Text>
                <Text style={styles.nightMeta} numberOfLines={1}>
                  {event.status === 'completed'
                    ? `${event.standings[0]?.ign ?? 'nobody'} won · ${event.players.length} engines`
                    : event.status === 'cancelled'
                      ? 'called off'
                      : statusOf(event).label.toLowerCase()}
                </Text>
              </View>
            ))}
          </Panel>
        ) : null}
      </>
    </ScreenShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

interface SlotGridProps {
  busy: string | null;
  days: SlotDay[];
  leading: number;
  onToggle: (slot: number) => void;
  signedIn: boolean;
}

/**
 * Thirty-six hours as a grid you fill in, cut into days.
 *
 * A grid rather than thirty-six bars because the shape is the information: the
 * point of asking a worldwide field when it can play is to *see* where the
 * overlap is, and a tall list of near-identical rows hides exactly that.
 *
 * The day headings are the part weekly scheduling made mandatory. A row of bare
 * times cannot say which night it means, and the answer differs per reader — so
 * each run of cells sits under the name of the day it falls on where the reader
 * is, and the host's own weekday is never shown. Nobody in Seoul should have to
 * work out whose Saturday is meant.
 */
function SlotGrid({ busy, days, leading, onToggle, signedIn }: SlotGridProps) {
  const most = Math.max(
    1,
    ...days.flatMap((day) => day.slots.map((entry) => entry.people)),
  );
  return (
    <View style={styles.grid}>
      {days.map((day) => (
        <View key={day.key} style={styles.day}>
          <View style={styles.dayHeading}>
            <Text style={styles.dayName}>{day.day}</Text>
            <Text style={styles.dayDate}>{day.date}</Text>
          </View>
          <View style={styles.dayCells}>
            {day.slots.map((entry) => {
              const share = entry.people / most;
              const pending = busy === `slot:${entry.slot}`;
              return (
                <Pressable
                  accessibilityLabel={`${day.day} ${timeOfDay(entry.atUnixMs)}, ${entry.people} available`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: entry.mine, disabled: !signedIn }}
                  disabled={!signedIn || Boolean(busy)}
                  key={entry.slot}
                  onPress={() => onToggle(entry.slot)}
                  style={({ pressed }) => [
                    styles.cell,
                    // The fill is the crowd; the border is you. Two channels, so
                    // a popular slot you cannot make still reads as popular.
                    entry.people > 0 && {
                      backgroundColor: colors.accentSurfaceQuiet,
                      opacity: 0.35 + share * 0.65,
                    },
                    entry.mine && styles.cellMine,
                    entry.slot === leading && styles.cellLeading,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.cellTime, entry.mine && styles.cellTimeMine]}>
                    {timeOfDay(entry.atUnixMs)}
                  </Text>
                  <Text style={styles.cellCount}>{pending ? '…' : entry.people}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      {!signedIn ? <Text style={styles.pollNote}>Sign in to mark your slots.</Text> : null}
    </View>
  );
}

interface PollRowsProps {
  busy: string | null;
  kind: 'clock';
  onVote: (kind: 'clock', choice: string) => void;
  poll: WeekendPoll;
  signedIn: boolean;
}

/**
 * A poll as a row of bars.
 *
 * The whole ballot is drawn, not just the options somebody has voted for: an
 * option with no votes is the one most worth being able to click.
 */
function PollRows({ busy, kind, onVote, poll, signedIn }: PollRowsProps) {
  // Defensive on both lists: Go marshals an empty slice as null, and a page
  // that blanks because nobody has voted yet is the worst possible first
  // impression of a voting feature.
  const tallies = poll.tallies ?? [];
  const options = poll.options ?? [];
  const most = Math.max(1, ...tallies.map((tally) => tally.votes));
  return (
    <View style={styles.poll}>
      {options.map((option) => {
        const votes = tallies.find((tally) => tally.choice === option)?.votes ?? 0;
        const mine = poll.mine === option;
        const leading = poll.leading === option;
        const pending = busy === `${kind}:${option}`;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: mine, disabled: !poll.open || !signedIn }}
            disabled={!poll.open || !signedIn || Boolean(busy)}
            key={option}
            onPress={() => onVote(kind, option)}
            style={({ pressed }) => [
              styles.pollRow,
              mine && styles.pollRowMine,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.pollLabel}>
              <Text style={[styles.pollOption, leading && styles.pollOptionLeading]}>
                {option}
              </Text>
              {/*
                The tag rather than the bar colour alone. "Leading" used to be
                nothing but a green fill, which is invisible on an option with
                no votes — and the option with no votes is exactly the one that
                leads whenever the turnout floor has not been met and the
                host's default is standing in. That read as the site colouring
                bars at random.
              */}
              {leading ? <Text style={styles.pollPlays}>PLAYS</Text> : null}
            </View>
            <View style={styles.pollTrack}>
              <View
                style={[
                  styles.pollFill,
                  leading && styles.pollFillLeading,
                  { width: `${Math.round((votes / most) * 100)}%` },
                ]}
              />
            </View>
            <Text style={styles.pollVotes}>{pending ? '…' : votes}</Text>
          </Pressable>
        );
      })}
      {!signedIn ? (
        <Text style={styles.pollNote}>Sign in to vote.</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 60, alignItems: 'center' },
  hero: { paddingTop: space.small, paddingBottom: space.medium },
  eyebrow: { color: colors.textFaint, ...type.eyebrow },
  title: { color: colors.text, ...type.screenTitle, marginTop: space.tight },
  blurb: {
    color: colors.textMuted,
    ...type.body,
    marginTop: space.snug,
    maxWidth: contentWidth.reading,
  },
  banner: { marginBottom: space.medium },

  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.small,
    marginTop: space.medium,
  },
  stat: {
    flexGrow: 1,
    flexBasis: 130,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.medium,
    padding: space.medium - 2,
  },
  statLabel: { color: colors.textFaint, ...type.label, fontSize: 9 },
  statValue: { color: colors.text, fontSize: 20, fontWeight: '900', marginTop: space.tight },
  plan: { color: colors.textFaint, ...type.meta, marginTop: space.medium },

  poll: { marginTop: space.small },
  pollRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small + 2,
    paddingVertical: space.snug,
    paddingHorizontal: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: 'transparent',
    marginTop: space.tight,
  },
  pollRowMine: {
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurfaceQuiet,
  },
  pressed: { opacity: 0.75 },
  pollLabel: {
    width: 92,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.snug,
  },
  pollOption: { color: colors.textMuted, ...type.rowTitle },
  pollPlays: {
    color: colors.accentText,
    ...type.label,
    fontSize: 8,
    letterSpacing: 1,
  },
  pollOptionLeading: { color: colors.text },
  pollTrack: {
    flex: 1,
    minWidth: 0,
    height: 20,
    borderRadius: radius.small,
    backgroundColor: colors.surfaceSunken,
    overflow: 'hidden',
  },
  pollFill: { height: '100%', backgroundColor: colors.surfaceMuted },
  pollFillLeading: { backgroundColor: colors.accent },
  pollVotes: { color: colors.textFaint, ...type.meta, width: 26, textAlign: 'right' },
  pollNote: { color: colors.textFaint, ...type.meta, marginTop: space.small },

  grid: { marginTop: space.small },
  day: { marginTop: space.medium },
  // A rule under the day rather than a chip beside it: the heading has to read
  // as owning the cells below it, not as one more thing in the row.
  dayHeading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.small,
    paddingBottom: space.snug,
    marginBottom: space.small,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  dayName: { color: colors.text, fontSize: 13, fontWeight: '900' },
  dayDate: { color: colors.textFaint, ...type.meta },
  dayCells: { flexDirection: 'row', flexWrap: 'wrap', gap: space.snug },
  // Every cell the same width, and none of them growing. A day whose slots do
  // not divide evenly into rows leaves a short last row, which is tidy; letting
  // them grow instead stretches that row's one orphan across the full width,
  // which is not. It is also the truthful shape: the fill opacity is the crowd,
  // so a wider cell reads as a more popular hour when it is only a remainder.
  cell: {
    flexGrow: 0,
    flexBasis: 92,
    width: 92,
    alignItems: 'center',
    paddingVertical: space.small,
    paddingHorizontal: space.tight,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceSunken,
  },
  cellMine: { borderColor: colors.accent, borderWidth: 2 },
  cellLeading: { backgroundColor: colors.accentSurfaceRaised, opacity: 1 },
  cellTime: { color: colors.textMuted, ...type.meta, fontWeight: '800' },
  cellTimeMine: { color: colors.text },
  cellCount: { color: colors.textFaint, ...type.meta, marginTop: space.hair },

  engine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small + 2,
    paddingVertical: space.snug,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotIn: { backgroundColor: colors.accent },
  dotOut: { backgroundColor: colors.borderStrong },
  engineCopy: { flex: 1, minWidth: 0 },
  engineName: { color: colors.text, ...type.rowTitle },
  engineMeta: { color: colors.textFaint, ...type.meta, marginTop: space.hair },
  crown: { color: colors.goldBright, fontSize: 16 },

  standing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.medium,
    paddingVertical: space.snug,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  rank: { color: colors.textFaint, ...type.meta, width: 20 },
  standingName: { color: colors.text, ...type.rowTitle, flex: 1, minWidth: 0 },
  standingMeta: { color: colors.textFaint, ...type.meta },
  points: { color: colors.accentSoft, ...type.rowTitle, width: 34, textAlign: 'right' },

  night: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.medium,
    paddingVertical: space.snug,
  },
  nightName: { color: colors.text, ...type.rowTitle, flexShrink: 1 },
  nightMeta: { color: colors.textFaint, ...type.meta, flexShrink: 1 },
});
