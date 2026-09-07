import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import ProfileBots from './ProfileBots';
import ProfileTournaments from './ProfileTournaments';
import { failureMessage } from '@/errors';
import { relativeTime } from '@/features/bots/relativeTime';
import GameHistoryPanel from '@/features/game/GameHistoryPanel';
import { links, shareURL } from '@/navigation/links';
import { up } from '@/navigation/upFrom';
import { playerProfile, type PlayerProfilePage } from '@/store/api/players';
import { useGameStore } from '@/store/gameStore';
import { colors, contentWidth, radius, space, type } from '@/theme';
import BackLink from '@/ui/BackLink';
import CopyLinkButton from '@/ui/CopyLinkButton';
import ScreenShell from '@/ui/ScreenShell';
import TitleTag from '@/ui/TitleTag';
import { Badge, Banner, EmptyState, Panel, SectionHeading } from '@/ui/primitives';

// Somebody else's page.
//
// The site had every ingredient of one and no page that assembled them, so a
// name on the ladder or in your own game history was a dead end: you could see
// that Yuki beat you and learn nothing more. This is the assembly.
//
// Three things worth knowing before changing it:
//
//   - **It is not the account page.** `/account` is where you edit yourself:
//     rename, link Discord, choose which title you wear, manage your bots.
//     Nothing here is editable by anybody, including its subject. Two screens
//     rather than one mode switch on a single screen, because a page that is
//     sometimes a form is a page whose every row has to ask whose it is.
//   - **It reuses `GameHistoryPanel` exactly as it stands.** That panel was
//     written keyed on an account id, with copy that never says "you", against
//     the day a profile page would want it. This is that day, and the panel
//     needed no changes — which is the outcome that comment was aiming at.
//   - **Not everybody has one.** A page exists for accounts Discord has
//     vouched for, and for bots. Everybody else is an anonymous per-browser
//     identity called Guest, and the server answers 404 for them, which is
//     what `notFound` below is showing.

/** How a rating reads when the account has never played the mode. */
const UNRATED = '—';

/** One number with a word under it. The header is a row of these. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'gold' }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, tone === 'gold' && styles.statValueGold]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export interface ProfileScreenProps {
  /**
   * The username or user id from the URL.
   *
   * Either works — the server resolves both — which is what lets a typed
   * `/player?user=yuki` and a badge built from a game record share one page.
   */
  handle: string;
  /**
   * False on the first client render of a pre-rendered page, before the query
   * string exists. See `useSettledSearchParams`: without it this would fetch
   * an empty handle once on every load and show its 404.
   */
  settled: boolean;
}

export default function ProfileScreen({ handle, settled }: ProfileScreenProps) {
  // The catalogue, so a rating row can say "Total War" rather than "V5". It
  // arrives with the socket connection; before that the id stands in, which is
  // the same fallback the ladder uses.
  const modes = useGameStore((state) => state.modes);
  const [profile, setProfile] = useState<PlayerProfilePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Distinguished from `error`, because the two want different pages: a name
  // nobody has is an ordinary outcome of following an old link, and a server
  // that could not be reached is a fault.
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!settled) return undefined;
    const wanted = handle.trim();
    if (!wanted) {
      setLoading(false);
      setNotFound(true);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setError(null);
    playerProfile(wanted)
      .then((page) => {
        if (!cancelled) setProfile(page);
      })
      .catch((caught) => {
        if (cancelled) return;
        // The store answers 404 both for a name nobody has claimed and for an
        // account with no linked Discord, deliberately: from out here they are
        // the same thing.
        if ((caught as { status?: number } | null)?.status === 404) setNotFound(true);
        else setError(failureMessage(caught));
        setProfile(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [handle, settled]);

  if (!settled || loading) {
    return (
      <ScreenShell width={contentWidth.standard}>
        <BackLink href={up.player.href} label={up.player.label} />
        <Panel>
          <Text style={styles.note}>Loading…</Text>
        </Panel>
      </ScreenShell>
    );
  }

  if (notFound) {
    return (
      <ScreenShell width={contentWidth.reading}>
        <BackLink href={up.player.href} label={up.player.label} />
        <Panel>
          <SectionHeading eyebrow="PLAYER" title="No such player" />
          <Text style={styles.note}>
            Nobody here goes by {handle.trim() ? `“${handle.trim()}”` : 'that name'}. Player
            pages exist for accounts that have signed in with Discord, and for engines — an
            anonymous guest has no page, because the name is this browser&apos;s rather than a
            person&apos;s.
          </Text>
        </Panel>
      </ScreenShell>
    );
  }

  if (error || !profile) {
    return (
      <ScreenShell width={contentWidth.reading}>
        <BackLink href={up.player.href} label={up.player.label} />
        <Panel>
          <SectionHeading eyebrow="PLAYER" title="Could not load" />
          <Banner message={error ?? 'That player could not be loaded.'} tone="error" />
        </Panel>
      </ScreenShell>
    );
  }

  const isBot = profile.kind === 'bot';
  const record = `${profile.wins}W ${profile.losses}L ${profile.draws}D`;
  // The modes they have actually played, strongest first. A mode somebody has
  // never touched is not a row: it would read as a rating of 1200 rather than
  // as an absence, which is the same mistake `accounts.elo` invites.
  const rated = Object.entries(profile.modeRatings ?? {})
    .filter(([, rating]) => Boolean(rating) && (rating?.gamesPlayed ?? 0) > 0)
    .sort(([, first], [, second]) => (second?.elo ?? 0) - (first?.elo ?? 0));

  return (
    <ScreenShell width={contentWidth.standard}>
      {/*
        The same control in the same corner as everywhere else, and this page
        needs it more than most: it is reached from a name on the ladder, from a
        row of somebody's game history, or from a link somebody pasted, and the
        sidebar lights nothing up for it because a player is not a section.
      */}
      <BackLink href={up.player.href} label={up.player.label} />
      <Panel>
        <View style={styles.identity}>
          <View style={styles.nameBlock}>
            <View style={styles.nameRow}>
              <TitleTag size="large" title={profile.title} />
              <Text numberOfLines={1} style={styles.name}>
                {profile.username}
              </Text>
              {isBot ? <Badge label="BOT" tone="cool" /> : null}
            </View>
            <Text style={styles.meta}>
              {profile.discord ? `${profile.discord} · ` : ''}
              joined {relativeTime(profile.joinedAtUnixMs)}
              {profile.lastSeenAtUnixMs
                ? ` · last played ${relativeTime(profile.lastSeenAtUnixMs)}`
                : ''}
            </Text>
          </View>
          {/*
            The page's own address, because the reason somebody is on it is
            often that they want to send it to somebody else.
          */}
          <CopyLinkButton
            accessibilityLabel={`Copy a link to ${profile.username}'s page`}
            compact
            url={shareURL(links.player(profile.username))}
          />
        </View>

        <View style={styles.statRow}>
          <Stat label="RATING" tone="gold" value={String(profile.elo)} />
          <Stat label="GAMES" value={String(profile.gamesPlayed)} />
          <Stat label="RECORD" value={record} />
          <Stat
            label="TITLES"
            value={String(profile.titles?.length ?? 0)}
          />
        </View>

        {profile.titles?.length ? (
          <View style={styles.titleRow}>
            {profile.titles.map((award) => (
              <View key={award.id} style={styles.titleChip}>
                <TitleTag size="small" title={award.id} />
                <Text numberOfLines={1} style={styles.titleName}>
                  {award.name}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </Panel>

      <Panel>
        <SectionHeading eyebrow="RATINGS" title="By game mode" />
        {rated.length === 0 ? (
          <EmptyState
            detail="Every mode rates separately, and a rating appears once a ranked game in it has finished."
            title="No rated games yet"
          />
        ) : (
          <View style={styles.modeList}>
            {rated.map(([modeId, rating]) => (
              <View key={modeId} style={styles.modeRow}>
                <Text numberOfLines={1} style={styles.modeName}>
                  {modes.find((mode) => mode.id === modeId)?.name ?? modeId}
                </Text>
                <Text style={styles.modeElo}>{rating?.elo ?? UNRATED}</Text>
                <Text style={styles.modeRecord}>
                  {rating?.wins ?? 0}W {rating?.losses ?? 0}L {rating?.draws ?? 0}D
                </Text>
              </View>
            ))}
          </View>
        )}
      </Panel>

      <ProfileTournaments tournaments={profile.tournaments ?? []} />

      {/*
        Unchanged from the account page's copy of it: the panel was written
        against this moment. See the note at the top of this file.
      */}
      <GameHistoryPanel eyebrow="HISTORY" title="Games" userId={profile.userId} />

      <ProfileBots bots={profile.bots ?? []} owner={profile.username} />
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  identity: { flexDirection: 'row', alignItems: 'flex-start', gap: space.small },
  // minWidth zero so a long username wraps rather than pushing the copy button
  // off the row — see the note in the react-native-web layout traps.
  nameBlock: { flex: 1, minWidth: 0, gap: space.tight },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.snug, flexWrap: 'wrap' },
  name: { ...type.sectionTitle, color: colors.textStrong },
  meta: { ...type.meta, color: colors.textFaint },

  statRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.medium,
    marginTop: space.medium,
  },
  stat: { minWidth: 72, gap: 2 },
  statValue: { ...type.cardTitle, color: colors.text },
  statValueGold: { color: colors.goldBright },
  statLabel: { ...type.label, color: colors.textFaint },

  titleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.snug,
    marginTop: space.medium,
  },
  titleChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.tight,
    paddingHorizontal: space.small,
    paddingVertical: space.tight,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceMuted,
    maxWidth: 240,
  },
  titleName: { ...type.meta, color: colors.textMuted, flexShrink: 1, minWidth: 0 },

  modeList: { marginTop: space.small },
  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    paddingVertical: space.snug,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  modeName: { ...type.body, color: colors.text, flex: 1, minWidth: 0 },
  modeElo: { ...type.body, color: colors.goldBright, fontWeight: '800' },
  modeRecord: { ...type.meta, color: colors.textFaint, minWidth: 110, textAlign: 'right' },

  note: { ...type.body, color: colors.textMuted },
});
