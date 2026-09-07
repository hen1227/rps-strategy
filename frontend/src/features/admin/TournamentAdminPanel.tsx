import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import ConfirmButton from './ConfirmButton';
import TournamentBuilder from './TournamentBuilder';
import { adminStyles } from './adminStyles';
import { failureMessage } from '@/errors';
import type { AdminToken } from '@/hooks/useAdminToken';
import { enrollBotsInTournament } from '@/store/api/bots';
import { links } from '@/navigation/links';
import {
  advanceTournament,
  cancelTournament,
  createTournament,
  deleteTournament,
  listAdminTournaments,
  publishTournament,
  setTournamentHidden,
  startTournament,
  unpublishTournament,
  updateTournament,
  withdrawTournamentPlayer,
  type TournamentConfig,
} from '@/store/api/tournaments';
import { statusOf } from '@/store/tournamentSelectors';
import { colors, radius, space, type } from '@/theme';
import type { Tournament } from '@/types/protocol';
import {
  Badge,
  Banner,
  EmptyState,
  GhostButton,
  GhostLink,
  Panel,
  PrimaryButton,
  SectionHeading,
} from '@/ui/primitives';

// Running the tournaments.
//
// Its own tab, because a tournament is the one thing on this screen with a
// lifecycle rather than a set of properties:
//
//	draft ──publish──▶ registration ──start──▶ in_progress ──▶ completed
//	                        └───────── cancel ─────────┘
//
// The buttons a row offers depend entirely on where in that lifecycle it is, and
// the four booleans derived at the top of each row — `draft`, `open`,
// `running`, `over` — are what decide. Keeping them together and naming them is
// what stops a host being offered START on an event nobody has entered, or
// PUBLISH on one that is already public.
//
// Getting an event off the board is three different operations, and the long
// note under the list is the explanation a host reads. In short: cancel ends
// one that is still going, hide tidies away one that is over, and delete
// destroys it — including, invisibly, the champion's title, which is worked out
// from the events on record rather than stored.
//
// The public tournaments page keeps the match-day half — recording results
// while you watch the bracket — because that is done with the standings in
// front of you. Everything about what an event *is* happens here.

/** How a format reads in a row. */
const FORMAT_LABEL: Record<string, string> = {
  round_robin: 'Round robin',
  double_round_robin: 'Double round robin',
  single_elimination: 'Single elimination',
  swiss: 'Swiss',
};

/** How a field rule reads in a row, and only when it is not the default. */
const FIELD_LABEL: Record<string, string> = {
  humans: 'humans only',
  bots: 'bots only',
};

/** One line summarising what an event is, under its name. */
const summarise = (tournament: Tournament): string => {
  const parts = [
    tournament.modeName,
    FORMAT_LABEL[tournament.format] ?? tournament.format,
    `${tournament.players.length}${
      tournament.maxPlayers ? `/${tournament.maxPlayers}` : ''
    } entered`,
  ];
  if (FIELD_LABEL[tournament.field]) parts.push(FIELD_LABEL[tournament.field]);
  if (tournament.gamesPerMatch > 1) parts.push(`${tournament.gamesPerMatch} games per match`);
  if (tournament.seeding === 'rating') parts.push('seeded by rating');
  if (tournament.rounds) {
    const played = tournament.matches.length
      ? Math.max(...tournament.matches.map((match) => match.roundNumber))
      : 0;
    parts.push(
      tournament.status === 'in_progress'
        ? `round ${played} of ${tournament.rounds}`
        : `${tournament.rounds} rounds`,
    );
  }
  return parts.join(' · ');
};

/** How many of an event's scheduled matches are still to be played. */
const pending = (tournament: Tournament) =>
  tournament.matches.filter((match) => match.result === 'pending').length;

export interface TournamentAdminPanelProps {
  admin: AdminToken;
}

export default function TournamentAdminPanel({ admin }: TournamentAdminPanelProps) {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Which event's builder is open, `'new'` for a fresh draft, null for none.
  const [editing, setEditing] = useState<string | null>(null);
  // Whose entrants are listed. Separate from `editing` so a host can look at
  // the field without the whole form in the way.
  const [showingField, setShowingField] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!admin.token) return;
    setLoading(true);
    try {
      setTournaments((await listAdminTournaments(admin.token)) ?? []);
      setError(null);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [admin.token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // `successNotice` is optional because two of the actions here report their
  // own scope — the enrol sweep lists what it skipped, and a delete names what
  // it removed — and a generic sentence written over the top of either of those
  // loses the only part worth reading.
  // Only offered where it can do anything: an event that admits no engines has
  // no enrol step, and a button whose only outcome is a list of refusals is not
  // a button.
  const enrol = (tournament: Tournament) =>
    run(async () => {
      const result = await enrollBotsInTournament(admin.token, tournament.tournamentId);
      const skipped = Object.entries(result.skipped ?? {});
      setNotice(
        `Enrolled ${result.enrolled?.length ?? 0} engine(s)` +
          (result.enrolled?.length ? `: ${result.enrolled.join(', ')}` : '') +
          '.' +
          (skipped.length
            ? ` Skipped: ${skipped.map(([name, why]) => `${name} (${why})`).join(', ')}.`
            : ''),
      );
    });

  const run = async (action: () => Promise<unknown>, successNotice?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (successNotice) setNotice(successNotice);
      await refresh();
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  const save = (tournamentId: string | null, config: TournamentConfig) =>
    run(
      async () => {
        if (tournamentId) await updateTournament(admin.token, tournamentId, config);
        else await createTournament(admin.token, config);
        setEditing(null);
      },
      tournamentId
        ? 'Saved.'
        : 'Draft created. It is not public and takes no signups until you publish it.',
    );

  return (
    <>
      <Panel style={adminStyles.panel}>
        <SectionHeading
          eyebrow="ADMINISTRATION"
          title="Tournaments"
          trailing={
            <View style={styles.headerActions}>
              <GhostButton
                compact
                disabled={loading}
                label={loading ? 'LOADING' : 'REFRESH'}
                onPress={refresh}
              />
              <GhostButton
                compact
                disabled={busy}
                label={editing === 'new' ? 'CLOSE' : 'NEW EVENT'}
                onPress={() => setEditing(editing === 'new' ? null : 'new')}
              />
            </View>
          }
        />
        {error ? (
          <Banner message={error} onDismiss={() => setError(null)} tone="error" />
        ) : null}
        {notice ? <Banner message={notice} onDismiss={() => setNotice(null)} /> : null}

        {editing === 'new' ? (
          <TournamentBuilder
            busy={busy}
            locked={{ rules: false, cap: false }}
            onCancel={() => setEditing(null)}
            onSubmit={(config) => save(null, config)}
            tournament={null}
          />
        ) : null}

        {tournaments.length === 0 ? (
          <EmptyState
            detail="Press NEW EVENT to write one down. It stays private until you publish it."
            title="No tournaments yet"
          />
        ) : (
          <View style={adminStyles.list}>
            {tournaments.map((tournament) => {
              const status = statusOf(tournament);
              const draft = tournament.status === 'draft';
              const open = tournament.status === 'registration';
              const running = tournament.status === 'in_progress';
              const over =
                tournament.status === 'completed' || tournament.status === 'cancelled';
              const stuck = running && pending(tournament) === 0;
              const hidden = tournament.hiddenAtUnixMs !== undefined;
              return (
                <View key={tournament.tournamentId}>
                  <View style={adminStyles.row}>
                    <View style={adminStyles.rowCopy}>
                      <Text numberOfLines={1} style={adminStyles.rowName}>
                        {tournament.name}
                      </Text>
                      <Text numberOfLines={2} style={adminStyles.rowMeta}>
                        {summarise(tournament)}
                      </Text>
                    </View>
                    <Badge label={status.label} tone={status.tone} />
                    {/*
                      Worth its own badge rather than folding into the status:
                      hidden is orthogonal to where an event got to, and a host
                      looking at a completed event needs to know which of the two
                      reasons it is not on the board.
                    */}
                    {hidden ? <Badge label="HIDDEN" tone="neutral" /> : null}
                    {/*
                      A progressive format whose current round is complete but
                      which has not built the next one. It normally cannot
                      happen — the round builds itself as the last result lands
                      — so when it does, it is the one thing on this screen a
                      host would otherwise have to reach into the database for.
                    */}
                    {stuck ? <Badge label="NEEDS ADVANCING" tone="live" /> : null}

                    {draft ? null : (
                      <GhostLink
                        compact
                        href={links.tournaments(tournament.tournamentId)}
                        label="OPEN"
                      />
                    )}
                    <GhostButton
                      compact
                      disabled={busy}
                      label={
                        editing === tournament.tournamentId ? 'CLOSE' : over ? 'WORDS' : 'EDIT'
                      }
                      onPress={() =>
                        setEditing(
                          editing === tournament.tournamentId ? null : tournament.tournamentId,
                        )
                      }
                    />
                    {tournament.players.length > 0 ? (
                      <GhostButton
                        compact
                        disabled={busy}
                        label={
                          showingField === tournament.tournamentId
                            ? 'HIDE FIELD'
                            : `FIELD (${tournament.players.length})`
                        }
                        onPress={() =>
                          setShowingField(
                            showingField === tournament.tournamentId
                              ? null
                              : tournament.tournamentId,
                          )
                        }
                      />
                    ) : null}

                    {draft ? (
                      <PrimaryButton
                        compact
                        disabled={busy}
                        label="PUBLISH"
                        onPress={() =>
                          run(
                            () => publishTournament(admin.token, tournament.tournamentId),
                            `${tournament.name} is on the board and taking signups.`,
                          )
                        }
                      />
                    ) : null}

                    {open ? (
                      <>
                        {tournament.field === 'humans' ? null : (
                          <GhostButton
                            compact
                            disabled={busy}
                            label="ENROL ONLINE BOTS"
                            onPress={() => enrol(tournament)}
                          />
                        )}
                        {tournament.players.length === 0 ? (
                          <GhostButton
                            compact
                            disabled={busy}
                            label="UNPUBLISH"
                            onPress={() =>
                              run(
                                () => unpublishTournament(admin.token, tournament.tournamentId),
                                `${tournament.name} is a draft again.`,
                              )
                            }
                          />
                        ) : null}
                        <PrimaryButton
                          compact
                          disabled={busy || tournament.players.length < 2}
                          label="START"
                          onPress={() =>
                            run(
                              () => startTournament(admin.token, tournament.tournamentId),
                              `${tournament.name} has started. The field is closed and the schedule is built.`,
                            )
                          }
                        />
                      </>
                    ) : null}

                    {stuck ? (
                      <GhostButton
                        compact
                        disabled={busy}
                        label="ADVANCE"
                        onPress={() =>
                          run(
                            () => advanceTournament(admin.token, tournament.tournamentId),
                            'Built the next round.',
                          )
                        }
                      />
                    ) : null}

                    {/*
                      Cancelling ends an event that is still going. It is not
                      offered on one that has already finished or been called
                      off, which is what `over` is.
                    */}
                    {draft || over ? null : (
                      <ConfirmButton
                        armed={confirming === `cancel:${tournament.tournamentId}`}
                        busy={busy}
                        label="CANCEL EVENT"
                        onArm={() => setConfirming(`cancel:${tournament.tournamentId}`)}
                        onConfirm={() =>
                          run(
                            () =>
                              cancelTournament(
                                admin.token,
                                tournament.tournamentId,
                                'called off by the host',
                              ),
                            `${tournament.name} is cancelled. Everything that was played is kept.`,
                          )
                        }
                        tone="quiet"
                      />
                    )}

                    {/*
                      Hiding is the housekeeping answer and sits *before* delete
                      deliberately: it is what a host clearing an old board
                      almost always wants, and it takes nothing away. Only
                      offered once an event is over, because one people can
                      still enter is one they need to find.
                    */}
                    {over ? (
                      <GhostButton
                        compact
                        disabled={busy}
                        label={hidden ? 'SHOW' : 'HIDE'}
                        onPress={() =>
                          run(
                            () =>
                              setTournamentHidden(
                                admin.token,
                                tournament.tournamentId,
                                !hidden,
                              ),
                            hidden
                              ? `${tournament.name} is back on the board.`
                              : `${tournament.name} is off the board. It is still counted, and its page still works.`,
                          )
                        }
                      />
                    ) : null}

                    <ConfirmButton
                      armed={confirming === `delete:${tournament.tournamentId}`}
                      busy={busy}
                      label="DELETE"
                      onArm={() => setConfirming(`delete:${tournament.tournamentId}`)}
                      onConfirm={() =>
                        run(async () => {
                          const deletion = await deleteTournament(
                            admin.token,
                            tournament.tournamentId,
                          );
                          // The champion is named in the notice because the
                          // title going with the event is the part nobody
                          // expects. See TournamentDeletion.championUserIds.
                          const crowned = deletion.championUserIds?.length
                            ? ` The Tournament Champion title has been taken from ${deletion.championUserIds.join(', ')}.`
                            : '';
                          setNotice(
                            `Deleted ${deletion.name}: ${deletion.playersDeleted} entrants, ` +
                              `${deletion.matchesDeleted} matches. ` +
                              `${deletion.gamesKept} recorded games were kept.${crowned}`,
                          );
                        })
                      }
                    />
                  </View>

                  {editing === tournament.tournamentId ? (
                    <View style={adminStyles.detail}>
                      <TournamentBuilder
                        busy={busy}
                        locked={{ rules: !draft, cap: running || over }}
                        onCancel={() => setEditing(null)}
                        onSubmit={(config) => save(tournament.tournamentId, config)}
                        tournament={tournament}
                      />
                    </View>
                  ) : null}

                  {showingField === tournament.tournamentId ? (
                    <View style={adminStyles.detail}>
                      <Text style={adminStyles.detailHeading}>ENTRANTS</Text>
                      {tournament.players.map((player) => (
                        <View key={player.playerId} style={adminStyles.subRow}>
                          <View style={adminStyles.rowCopy}>
                            <Text numberOfLines={1} style={adminStyles.subRowName}>
                              {player.seed ? `${player.seed}. ` : ''}
                              {player.ign}
                            </Text>
                            <Text numberOfLines={1} style={adminStyles.rowMeta}>
                              {player.discord} · {player.userId}
                            </Text>
                          </View>
                          {/*
                            Withdrawing is only offered while the field is open.
                            Removing somebody from a started event would delete
                            match rows other people's standings are computed
                            from — a half-played round robin minus one player is
                            not a smaller round robin. The result editor on the
                            event's own page is the tool for that.
                          */}
                          {draft || open ? (
                            <ConfirmButton
                              armed={confirming === `withdraw:${player.playerId}`}
                              busy={busy}
                              label="WITHDRAW"
                              onArm={() => setConfirming(`withdraw:${player.playerId}`)}
                              onConfirm={() =>
                                run(
                                  () =>
                                    withdrawTournamentPlayer(
                                      admin.token,
                                      tournament.tournamentId,
                                      player.playerId,
                                    ),
                                  `${player.ign} withdrawn.`,
                                )
                              }
                              tone="quiet"
                            />
                          ) : (
                            <Text style={styles.locked}>field closed</Text>
                          )}
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
      </Panel>
    </>
  );
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  locked: {
    ...type.meta,
    color: colors.textFaint,
    paddingHorizontal: space.snug,
    borderRadius: radius.small,
  },
  // The three verbs in the note below the list, so a host scanning it can find
  // the one they mean without reading the paragraph.
  term: { color: colors.textSubtle, fontWeight: '800' },
});
