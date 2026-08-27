package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"rps-strategy/backend/internal/notation"
)

// Folding a guest account into a Discord account that has never played.
//
// The narrow rule is what makes this affordable. A general two-way merge would
// have to arbitrate two Elos, reconcile two head-to-head records, and cope with
// the two accounts having played *each other* — which `game_history` forbids
// outright, since it carries CHECK (red_player_id <> blue_player_id) and a
// reassignment would put the same id in both seats. Restricting the merge to a
// target with no games removes all three problems at once: there is nothing to
// arbitrate, nothing to reconcile, and no game either of them could share.
//
// Everything moves in one transaction. A half-merged pair of accounts is worse
// than either outcome it sits between.

// ErrMergeTargetHasHistory is returned when the surviving account has already
// played. The caller should sign in and leave the guest account alone.
var ErrMergeTargetHasHistory = errors.New("the target account already has games")

// ErrMergeSourceIsRegistered is returned when the account being folded in is
// not an anonymous one. Only a guest identity may be absorbed.
var ErrMergeSourceIsRegistered = errors.New("only an anonymous account can be merged")

// MergeAccountHistory moves a guest account's games, record and ratings onto
// another account, then retires the guest row.
//
// Returns the number of archived records rewritten, which is the figure worth
// reporting back: it is what the player would recognise as "my games".
func (store *Store) MergeAccountHistory(
	ctx context.Context,
	fromUserID string,
	intoUserID string,
) (int, error) {
	fromUserID = strings.TrimSpace(fromUserID)
	intoUserID = strings.TrimSpace(intoUserID)
	if fromUserID == "" || intoUserID == "" || fromUserID == intoUserID {
		return 0, ErrAccountNotFound
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("merge account: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	source, err := readMergeAccount(ctx, transaction, fromUserID)
	if err != nil {
		return 0, err
	}
	target, err := readMergeAccount(ctx, transaction, intoUserID)
	if err != nil {
		return 0, err
	}
	if source.kind != AccountKindHuman || target.kind != AccountKindHuman {
		return 0, ErrInvalidProfileKey
	}
	if target.disabled != 0 || source.disabled != 0 {
		return 0, ErrAccountDisabled
	}
	if accountIsRegistered(source.passwordHash, source.discordUserID) {
		return 0, ErrMergeSourceIsRegistered
	}
	if target.gamesPlayed > 0 {
		return 0, ErrMergeTargetHasHistory
	}
	// Not reachable today, because owning a bot requires being registered and
	// the source never is. Carried anyway: the day bot ownership is re-gated,
	// the alternative is a foreign-key error nobody can interpret.
	var liveBots int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM bots WHERE owner_user_id = ? AND retired_at_unix_ms IS NULL
`, fromUserID).Scan(&liveBots); err != nil {
		return 0, fmt.Errorf("merge account: count bots: %w", err)
	}
	if liveBots > 0 {
		return 0, fmt.Errorf("retire the merged account's %d bot(s) first", liveBots)
	}

	// game_history moves every column of a row at once, and it has to.
	//
	// The table carries CHECK (winner_player_id IN (red_player_id,
	// blue_player_id)), so moving the seat in one statement and the winner in
	// the next fails on the row in between — a constraint violation caused
	// entirely by the order the work was done in. All the assignments below
	// read the pre-update row, so one statement sees a consistent picture.
	//
	// `winner_player_id` is also the column AnonymizeAccount never touches,
	// because that only rewrites names. A merge moves ids, so leaving it would
	// point the winner of a moved game at a row about to be deleted.
	//
	// tournament_matches looks like it needs the same treatment and does not:
	// its player columns reference tournament_players(player_id), the signup
	// row, not the account.
	for _, statement := range []string{
		`
UPDATE game_history
SET red_player_id = CASE WHEN red_player_id = ?2 THEN ?1 ELSE red_player_id END,
    red_username = CASE WHEN red_player_id = ?2 THEN ?3 ELSE red_username END,
    blue_player_id = CASE WHEN blue_player_id = ?2 THEN ?1 ELSE blue_player_id END,
    blue_username = CASE WHEN blue_player_id = ?2 THEN ?3 ELSE blue_username END,
    winner_player_id = CASE WHEN winner_player_id = ?2 THEN ?1 ELSE winner_player_id END
WHERE red_player_id = ?2 OR blue_player_id = ?2 OR winner_player_id = ?2`,
		`
UPDATE game_pgn
SET red_player_id = CASE WHEN red_player_id = ?2 THEN ?1 ELSE red_player_id END,
    red_username = CASE WHEN red_player_id = ?2 THEN ?3 ELSE red_username END,
    blue_player_id = CASE WHEN blue_player_id = ?2 THEN ?1 ELSE blue_player_id END,
    blue_username = CASE WHEN blue_player_id = ?2 THEN ?3 ELSE blue_username END
WHERE red_player_id = ?2 OR blue_player_id = ?2`,
		`UPDATE game_accuracy SET user_id = ?1 WHERE user_id = ?2`,
		`UPDATE tournament_players SET user_id = ?1 WHERE user_id = ?2`,
	} {
		if _, err := transaction.ExecContext(
			ctx, statement, intoUserID, fromUserID, target.username,
		); err != nil {
			return 0, fmt.Errorf("merge account: move records: %w", err)
		}
	}

	// These cascade on delete, so they have to move rather than be left behind.
	// OR REPLACE because the target may hold a row with the same key — its own
	// default rating in a mode, say — and the guest's is the one with the games
	// behind it, which is the whole reason this merge is allowed at all.
	for _, statement := range []string{
		`UPDATE OR REPLACE account_mode_ratings SET user_id = ?1 WHERE user_id = ?2`,
		`UPDATE OR REPLACE account_titles SET user_id = ?1 WHERE user_id = ?2`,
		`UPDATE OR REPLACE push_subscriptions SET user_id = ?1 WHERE user_id = ?2`,
	} {
		if _, err := transaction.ExecContext(ctx, statement, intoUserID, fromUserID); err != nil {
			return 0, fmt.Errorf("merge account: move account rows: %w", err)
		}
	}

	// The PGN carries its own copy of both the id and the name, and an exported
	// archive is the copy a player actually keeps.
	rewritten, err := reseatArchive(ctx, transaction, fromUserID, intoUserID, target.username)
	if err != nil {
		return 0, err
	}

	// The record itself. The target has no games, so this is a move rather than
	// a sum — there is nothing on the other side to add.
	if _, err := transaction.ExecContext(ctx, `
UPDATE accounts
SET elo = ?, wins = ?, losses = ?, draws = ?, games_played = ?, updated_at_unix_ms = ?
WHERE user_id = ?
`,
		source.elo, source.wins, source.losses, source.draws, source.gamesPlayed,
		time.Now().UnixMilli(), intoUserID,
	); err != nil {
		return 0, fmt.Errorf("merge account: move record: %w", err)
	}

	// Nothing refers to the guest row now, so it goes entirely rather than
	// being left sealed. A row with no history is not worth the confusion of
	// finding it later.
	if _, err := transaction.ExecContext(ctx,
		`DELETE FROM accounts WHERE user_id = ?`, fromUserID,
	); err != nil {
		return 0, fmt.Errorf("merge account: delete merged account: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return 0, fmt.Errorf("merge account: commit: %w", err)
	}
	return rewritten, nil
}

type mergeAccount struct {
	kind          string
	disabled      int
	passwordHash  string
	discordUserID string
	username      string
	elo           int
	wins          int
	losses        int
	draws         int
	gamesPlayed   int
}

func readMergeAccount(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
) (mergeAccount, error) {
	var account mergeAccount
	err := transaction.QueryRowContext(ctx, `
SELECT kind, disabled, password_hash, discord_user_id, username,
       elo, wins, losses, draws, games_played
FROM accounts WHERE user_id = ?
`, userID).Scan(
		&account.kind, &account.disabled, &account.passwordHash, &account.discordUserID,
		&account.username, &account.elo, &account.wins, &account.losses,
		&account.draws, &account.gamesPlayed,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return mergeAccount{}, ErrAccountNotFound
	}
	if err != nil {
		return mergeAccount{}, fmt.Errorf("merge account: read %s: %w", userID, err)
	}
	return account, nil
}

// reseatArchive rewrites the id and name inside every stored record the merged
// account appears in. Read fully before writing, because the rows being updated
// are the rows being iterated.
func reseatArchive(
	ctx context.Context,
	transaction *sql.Tx,
	fromUserID string,
	intoUserID string,
	username string,
) (int, error) {
	rows, err := transaction.QueryContext(ctx, `
SELECT game_id, pgn FROM game_pgn WHERE red_player_id = ?1 OR blue_player_id = ?1
`, intoUserID)
	if err != nil {
		return 0, fmt.Errorf("merge account: read records: %w", err)
	}
	rewrites := make(map[string]string)
	for rows.Next() {
		var gameID, pgn string
		if err := rows.Scan(&gameID, &pgn); err != nil {
			rows.Close()
			return 0, fmt.Errorf("merge account: read record: %w", err)
		}
		rewrites[gameID] = notation.ReseatParticipant(pgn, fromUserID, intoUserID, username)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	for gameID, pgn := range rewrites {
		if _, err := transaction.ExecContext(ctx,
			`UPDATE game_pgn SET pgn = ? WHERE game_id = ?`, pgn, gameID,
		); err != nil {
			return 0, fmt.Errorf("merge account: rewrite record: %w", err)
		}
	}
	return len(rewrites), nil
}
