package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"

	"rps-strategy/backend/internal/game"
)

// Public player pages.
//
// The site has always had every ingredient of one — an account with ratings, a
// game history route, a title collection, a leaderboard — and no page that put
// them together. So a name on the ladder or in somebody's game history was a
// dead end: you could see that Yuki beat you, and nothing else.
//
// Three decisions define what a profile is:
//
//   - **Only for accounts Discord has vouched for.** Not a privacy setting, a
//     consequence: the great majority of accounts on this server are anonymous
//     browser identities called "Guest", generated per browser, and a directory
//     of forty thousand Guests is not a feature. A linked Discord is also the
//     only thing that makes a name durable enough to be worth an address, since
//     it is what stops two people claiming the same one.
//   - **Addressed by username.** `/player?user=yuki` rather than by user id,
//     because the whole point is to be linkable by somebody who knows the name
//     and not the id. Usernames are unique among claimed accounts — see the
//     partial index in ensureAccountAuthColumns — so this is well defined.
//   - **Nothing on it is new information.** Every field below is already served
//     by an existing public route: the account, its history, its titles, the
//     ladder. This page is a join, not a disclosure. That is worth stating
//     because it is the property that has to be preserved when fields are added
//     to it.
type PublicProfile struct {
	UserID   string  `json:"userId"`
	Username string  `json:"username"`
	Title    TitleID `json:"title,omitempty"`
	// Discord is the handle Discord vouched for. Already public on the
	// leaderboard and on GET /api/accounts/{id}; here for the same reason it is
	// there, which is that it is how people find each other to arrange a game.
	Discord string       `json:"discord"`
	Titles  []TitleAward `json:"titles,omitempty"`
	// Kind is "human" or "bot". Engines get profiles too — they are accounts
	// with ratings and histories, and a bot's page is the natural place for its
	// author's description of it.
	Kind             string                     `json:"kind"`
	Elo              int                        `json:"elo"`
	Wins             int                        `json:"wins"`
	Losses           int                        `json:"losses"`
	Draws            int                        `json:"draws"`
	GamesPlayed      int                        `json:"gamesPlayed"`
	ModeRatings      map[game.ModeID]ModeRating `json:"modeRatings"`
	JoinedAtUnixMs   int64                      `json:"joinedAtUnixMs"`
	LastSeenAtUnixMs *int64                     `json:"lastSeenAtUnixMs,omitempty"`
	// RecentGames is the tail of their history, which is the thing a visitor
	// actually came for.
	RecentGames []GameRecord `json:"recentGames"`
	// Tournaments is the events they have entered, most recent first, with
	// where they finished when the event is over.
	Tournaments []ProfileTournament `json:"tournaments,omitempty"`
	// Bots is the engines this account owns, for a profile that belongs to
	// somebody who writes them. Retired ones are left out.
	Bots []ProfileBot `json:"bots,omitempty"`
}

// ProfileTournament is one event on somebody's page.
type ProfileTournament struct {
	TournamentID string           `json:"tournamentId"`
	Name         string           `json:"name"`
	ModeName     string           `json:"modeName"`
	Status       TournamentStatus `json:"status"`
	Format       TournamentFormat `json:"format"`
	// Placement is where they finished, and nil for an event still running or
	// one that never started. FieldSize beside it is what makes a placement
	// mean anything: third is a different result out of four than out of forty.
	Placement *int  `json:"placement,omitempty"`
	FieldSize int   `json:"fieldSize"`
	EnteredAt int64 `json:"enteredAtUnixMs"`
}

// ProfileBot is one engine on its owner's page.
type ProfileBot struct {
	BotID       string `json:"botId"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	IconSHA256  string `json:"iconSha256,omitempty"`
	Elo         int    `json:"elo"`
	Username    string `json:"username"`
	UserID      string `json:"userId"`
}

// ProfileSummary is one row of the player directory.
//
// A projection rather than a whole PublicProfile, for the reason
// AccountSummary gives: a page of fifty needs a name, a rating and a title, not
// fifty game histories.
type ProfileSummary struct {
	UserID      string  `json:"userId"`
	Username    string  `json:"username"`
	Discord     string  `json:"discord"`
	Title       TitleID `json:"title,omitempty"`
	Kind        string  `json:"kind"`
	Elo         int     `json:"elo"`
	GamesPlayed int     `json:"gamesPlayed"`
	TitleCount  int     `json:"titleCount"`
}

// ErrProfileNotFound is a name nobody has claimed, or an account with no linked
// Discord — which from the outside are the same thing, and are answered the
// same way. See PublicProfile's note about who gets a page.
var ErrProfileNotFound = errors.New("no such player")

// PublicProfile reads one player's page by username or by user id.
//
// Both, because the two arrive from different places: a link somebody typed
// carries a name, and a link built from a game record carries an id. Trying the
// name first, since that is the addressable form.
func (store *Store) PublicProfile(
	ctx context.Context,
	handle string,
	historyLimit int,
) (PublicProfile, error) {
	handle = strings.TrimSpace(handle)
	if handle == "" {
		return PublicProfile{}, ErrProfileNotFound
	}
	if historyLimit <= 0 || historyLimit > 100 {
		historyLimit = 20
	}

	var userID string
	var discordUserID string
	err := store.db.QueryRowContext(ctx, `
SELECT user_id, discord_user_id FROM accounts
WHERE username_lower = ? OR user_id = ?
`, UsernameKey(handle), handle).Scan(&userID, &discordUserID)
	if errors.Is(err, sql.ErrNoRows) {
		return PublicProfile{}, ErrProfileNotFound
	}
	if err != nil {
		return PublicProfile{}, fmt.Errorf("read profile: %w", err)
	}

	account, err := store.Account(ctx, userID)
	if err != nil {
		return PublicProfile{}, err
	}
	// A bot has no Discord of its own — it has an owner who does — so the
	// linked-identity rule is applied to people only. Without this exception
	// no engine would have a page, which is the opposite of what is wanted:
	// a bot's page is where its rating and its record live.
	if discordUserID == "" && account.Kind != AccountKindBot {
		return PublicProfile{}, ErrProfileNotFound
	}
	// A disabled account keeps no page. Anonymized ones are disabled too — see
	// AnonymizeAccount — so this is also what stops "Deleted player" having an
	// address.
	if account.Disabled {
		return PublicProfile{}, ErrProfileNotFound
	}

	profile := PublicProfile{
		UserID:         account.UserID,
		Username:       account.Username,
		Title:          account.Title,
		Discord:        account.Discord,
		Titles:         account.Titles,
		Kind:           account.Kind,
		Elo:            account.Elo,
		Wins:           account.Wins,
		Losses:         account.Losses,
		Draws:          account.Draws,
		GamesPlayed:    account.GamesPlayed,
		ModeRatings:    account.ModeRatings,
		JoinedAtUnixMs: account.CreatedAtUnixMs,
	}
	// The strongest mode rating, matching what the ladder and the admin browser
	// show. `accounts.elo` is only the seed a new mode starts from — see
	// AccountSummary.Elo — so publishing it as "rating" would show every active
	// player at the default.
	for _, rating := range account.ModeRatings {
		if rating.Elo > profile.Elo {
			profile.Elo = rating.Elo
		}
	}

	games, err := store.GameHistory(ctx, userID, historyLimit, 0)
	if err != nil {
		return PublicProfile{}, err
	}
	profile.RecentGames = games
	// When they were last here, taken from their own history rather than from
	// a session or a login timestamp: the games are the public record, and
	// "last played" is the honest version of "last seen" for a site whose
	// entire purpose is playing.
	if len(games) > 0 {
		lastSeen := games[0].FinishedAtUnixMs
		profile.LastSeenAtUnixMs = &lastSeen
	}

	tournaments, err := store.profileTournaments(ctx, userID)
	if err != nil {
		return PublicProfile{}, err
	}
	profile.Tournaments = tournaments

	if account.Kind != AccountKindBot {
		bots, err := store.profileBots(ctx, userID)
		if err != nil {
			return PublicProfile{}, err
		}
		profile.Bots = bots
	}
	return profile, nil
}

// profileTournaments is the events an account has entered, newest first.
//
// The placement comes from re-reading each event and finding this player in its
// standings, rather than from a stored column. That is deliberately the slow
// way round, and it is the right way round: standings are derived from the
// match results, a stored placement would be a second copy of them, and the
// copy is what goes stale the first time a host edits a result.
//
// Capped, because the cost is one tournament read each and a profile page does
// not need somebody's entire competitive history on first load.
func (store *Store) profileTournaments(
	ctx context.Context,
	userID string,
) ([]ProfileTournament, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT p.tournament_id, p.joined_at_unix_ms
FROM tournament_players p
JOIN tournaments t ON t.tournament_id = p.tournament_id
WHERE p.user_id = ?
  AND t.published_at_unix_ms IS NOT NULL
ORDER BY t.created_at_unix_ms DESC
LIMIT 10
`, userID)
	if err != nil {
		return nil, fmt.Errorf("read profile tournaments: %w", err)
	}
	type entered struct {
		tournamentID string
		joinedAt     int64
	}
	entries := make([]entered, 0, 10)
	for rows.Next() {
		var entry entered
		if err := rows.Scan(&entry.tournamentID, &entry.joinedAt); err != nil {
			rows.Close()
			return nil, fmt.Errorf("read profile tournament: %w", err)
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("read profile tournaments: %w", err)
	}
	rows.Close()

	results := make([]ProfileTournament, 0, len(entries))
	for _, entry := range entries {
		tournament, err := store.Tournament(ctx, entry.tournamentID)
		if errors.Is(err, ErrTournamentNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		result := ProfileTournament{
			TournamentID: tournament.TournamentID,
			Name:         tournament.Name,
			ModeName:     tournament.ModeName,
			Status:       tournament.Status,
			Format:       tournament.Format,
			FieldSize:    len(tournament.Players),
			EnteredAt:    entry.joinedAt,
		}
		if tournament.Status == TournamentCompleted {
			for _, standing := range tournament.Standings {
				if playerIsAccount(tournament, standing.PlayerID, userID) {
					rank := standing.Rank
					result.Placement = &rank
					break
				}
			}
		}
		results = append(results, result)
	}
	return results, nil
}

// playerIsAccount reports whether a standings row belongs to an account.
//
// Standings are keyed on the tournament's own player id rather than on a user
// id, because an entrant is a signup and not necessarily an account. This is
// the lookup back.
func playerIsAccount(tournament Tournament, playerID int64, userID string) bool {
	for _, player := range tournament.Players {
		if player.PlayerID == playerID {
			return player.UserID == userID
		}
	}
	return false
}

// profileBots is the engines an account owns.
func (store *Store) profileBots(ctx context.Context, userID string) ([]ProfileBot, error) {
	bots, err := store.BotsForOwner(ctx, userID)
	if err != nil {
		return nil, err
	}
	profiles := make([]ProfileBot, 0, len(bots))
	for _, bot := range bots {
		// A retired engine is off the ladder and off its owner's page. An
		// unclaimed slot — a registry row whose owner has not connected
		// anything to it yet — has no name and is not a bot to anybody outside
		// the owner's own bots page.
		if bot.Retired || strings.TrimSpace(bot.Name) == "" {
			continue
		}
		entry := ProfileBot{
			BotID:       bot.BotID,
			Name:        bot.Name,
			Description: bot.Description,
			IconSHA256:  bot.IconSHA256,
			UserID:      bot.UserID,
			Username:    bot.Name,
		}
		if bot.UserID != "" {
			if account, err := store.Account(ctx, bot.UserID); err == nil {
				entry.Username = account.Username
				entry.Elo = account.Elo
				for _, rating := range account.ModeRatings {
					if rating.Elo > entry.Elo {
						entry.Elo = rating.Elo
					}
				}
			}
		}
		profiles = append(profiles, entry)
	}
	sort.SliceStable(profiles, func(first, second int) bool {
		return profiles[first].Elo > profiles[second].Elo
	})
	return profiles, nil
}

// PublicProfiles is the player directory: everybody with a page, searchable.
//
// The same population rule as PublicProfile, expressed once in SQL here and
// once in Go there. They have to agree, and the shape of the agreement is the
// clause below: a linked Discord, or a bot account, and not disabled.
func (store *Store) PublicProfiles(
	ctx context.Context,
	query string,
	limit int,
	offset int,
) ([]ProfileSummary, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	pattern := "%" + UsernameKey(query) + "%"
	rows, err := store.db.QueryContext(ctx, `
SELECT a.user_id, a.username, a.discord, a.title, a.kind,
       COALESCE((SELECT MAX(r.elo) FROM account_mode_ratings r
                  WHERE r.user_id = a.user_id), a.elo),
       a.games_played,
       (SELECT COUNT(*) FROM account_titles t WHERE t.user_id = a.user_id)
FROM accounts a
WHERE a.disabled = 0
  AND (a.discord_user_id <> '' OR a.kind = ?)
  AND a.username_lower <> ''
  AND (? = '%%' OR a.username_lower LIKE ?)
ORDER BY 6 DESC, a.games_played DESC
LIMIT ? OFFSET ?
`, AccountKindBot, pattern, pattern, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("list profiles: %w", err)
	}
	defer rows.Close()
	summaries := make([]ProfileSummary, 0, limit)
	for rows.Next() {
		var summary ProfileSummary
		if err := rows.Scan(
			&summary.UserID, &summary.Username, &summary.Discord, &summary.Title,
			&summary.Kind, &summary.Elo, &summary.GamesPlayed, &summary.TitleCount,
		); err != nil {
			return nil, fmt.Errorf("read profile row: %w", err)
		}
		summaries = append(summaries, summary)
	}
	return summaries, rows.Err()
}

// profileHistoryDefault is how much of somebody's history a page opens with.
// Enough to fill the panel, few enough that it is one indexed read.
const profileHistoryDefault = 20

// ProfileHistoryPage is a page of somebody's games, for the profile page's
// "show more". A thin wrapper over GameHistory that exists so the route reads
// the same way as the rest of this file.
func (store *Store) ProfileHistoryPage(
	ctx context.Context,
	userID string,
	limit int,
	offset int,
) ([]GameRecord, error) {
	if limit <= 0 || limit > 100 {
		limit = profileHistoryDefault
	}
	return store.GameHistory(ctx, userID, limit, offset)
}
