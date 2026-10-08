import { matchStateFor, matchesOf } from '@/store/tournamentSelectors';
import type {
  Tournament,
  TournamentMatch,
  TournamentStanding,
} from '@/types/protocol';

export type MatchFilter = 'all' | 'live' | 'upcoming' | 'results';

export const FORMAT_LABELS = {
  round_robin: 'Round robin',
  double_round_robin: 'Double round robin',
  single_elimination: 'Single elimination',
  swiss: 'Swiss',
} as const;

export function matchesForFilter(tournament: Tournament, filter: MatchFilter) {
  return matchesOf(tournament).filter((match) => {
    const live =
      match.result === 'pending' &&
      matchStateFor(tournament, match.matchId).live;
    if (filter === 'live') return live;
    if (filter === 'upcoming') return match.result === 'pending' && !live;
    if (filter === 'results') return match.result !== 'pending';
    return true;
  });
}

/** Byes award points and wins, but aren't played matches or part of win rate. */
export function playedRecord(standing: TournamentStanding) {
  const wins = Math.max(0, standing.wins - (standing.byes ?? 0));
  return {
    wins,
    draws: standing.draws,
    losses: standing.losses,
    winRate:
      standing.played > 0 ? Math.round((wins / standing.played) * 100) : null,
  };
}

/** Keep games that need attention above future pairings and finished results. */
export function overviewMatches(tournament: Tournament, userId?: string) {
  const priority = (match: TournamentMatch) => {
    if (match.result !== 'pending') return 3;
    if (
      userId &&
      [match.player1?.userId, match.player2?.userId].includes(userId)
    )
      return 0;
    return matchStateFor(tournament, match.matchId).live ? 1 : 2;
  };
  return [...matchesOf(tournament)]
    .sort((a, b) => {
      const order = priority(a) - priority(b);
      if (order) return order;
      if (a.result !== 'pending' && b.result !== 'pending')
        return b.updatedAtUnixMs - a.updatedAtUnixMs;
      return a.roundNumber - b.roundNumber || a.matchOrder - b.matchOrder;
    })
    .slice(0, 4);
}
