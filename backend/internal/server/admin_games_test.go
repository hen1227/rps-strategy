package server

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
	"rps-strategy/backend/internal/persistence"
)

const adminRouteToken = "an-admin-token-of-at-least-32-chars"

// recordRouteGame gives the route tests a game that exists in the history, the
// archive, and both players' records.
func recordRouteGame(
	t *testing.T,
	data *persistence.Store,
	gameID string,
	redID string,
	blueID string,
) {
	t.Helper()
	played, err := game.NewGame(
		gameID, game.ModeTotalWar,
		game.PlayerProfile{UserID: redID, Username: redID},
		game.PlayerProfile{UserID: blueID, Username: blueID},
	)
	if err != nil {
		t.Fatal(err)
	}
	state, err := played.Resign(game.Blue)
	if err != nil {
		t.Fatal(err)
	}
	finishedAt := time.Now()
	if _, err := data.RecordCompletedGame(
		t.Context(), state, finishedAt.Add(-time.Minute), finishedAt, true,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := data.ArchiveGame(
		t.Context(), played.Record(), notation.Metadata{Event: "Ranked"}, "",
	); err != nil {
		t.Fatal(err)
	}
}

func TestAdminGameBrowserListsAndDeletes(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	registeredSession(t, data, "red-player", "RedPlayer")
	registeredSession(t, data, "blue-player", "BluePlayer")
	recordRouteGame(t, data, "route-game", "red-player", "blue-player")
	handler := NewWithStoreAndAdminToken(data, nil, adminRouteToken).Routes()

	// Locked to administrators, like everything else on this screen.
	if anonymous := tournamentRequest(
		t, handler, http.MethodGet, "/api/admin/games", nil, "",
	); anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("expected the browser to require an admin, got %d", anonymous.Code)
	}
	if forbidden := tournamentRequest(
		t, handler, http.MethodDelete, "/api/admin/games/route-game", nil, "",
	); forbidden.Code != http.StatusUnauthorized {
		t.Fatalf("expected the delete to require an admin, got %d", forbidden.Code)
	}

	listed := tournamentRequest(
		t, handler, http.MethodGet, "/api/admin/games?query=red-player", nil, adminRouteToken,
	)
	if listed.Code != http.StatusOK {
		t.Fatalf("list games: %d: %s", listed.Code, listed.Body)
	}
	var games []persistence.GameRecord
	if err := json.NewDecoder(listed.Body).Decode(&games); err != nil {
		t.Fatal(err)
	}
	if len(games) != 1 || games[0].GameID != "route-game" {
		t.Fatalf("unexpected game list: %#v", games)
	}

	deleted := tournamentRequest(
		t, handler, http.MethodDelete, "/api/admin/games/route-game", nil, adminRouteToken,
	)
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete game: %d: %s", deleted.Code, deleted.Body)
	}
	var deletion persistence.GameDeletion
	if err := json.NewDecoder(deleted.Body).Decode(&deletion); err != nil {
		t.Fatal(err)
	}
	if !deletion.HistoryDeleted || !deletion.ArchiveDeleted || !deletion.RatingsReverted {
		t.Fatalf("unexpected deletion report: %#v", deletion)
	}
	// Ratings default to being handed back, so the loser is whole again.
	loser, err := data.Account(t.Context(), "blue-player")
	if err != nil {
		t.Fatal(err)
	}
	if loser.GamesPlayed != 0 || loser.ModeElo(game.ModeTotalWar) != persistence.RatingFloor {
		t.Fatalf("the deleted game left its result behind: %#v", loser)
	}

	missing := tournamentRequest(
		t, handler, http.MethodDelete, "/api/admin/games/route-game", nil, adminRouteToken,
	)
	if missing.Code != http.StatusNotFound {
		t.Fatalf("expected a second delete to 404, got %d: %s", missing.Code, missing.Body)
	}

	// The export route shares this path prefix and must still answer.
	export := tournamentRequest(
		t, handler, http.MethodGet, "/api/admin/games/pgn", nil, adminRouteToken,
	)
	if export.Code != http.StatusOK {
		t.Fatalf("the PGN export must still work: %d: %s", export.Code, export.Body)
	}
}

func TestAdminAccountDetailAndPurge(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	registeredSession(t, data, "spammer", "Spammer")
	registeredSession(t, data, "regular", "Regular")
	recordRouteGame(t, data, "spam-game", "spammer", "regular")
	handler := NewWithStoreAndAdminToken(data, nil, adminRouteToken).Routes()

	detail := tournamentRequest(
		t, handler, http.MethodGet, "/api/admin/accounts/spammer", nil, adminRouteToken,
	)
	if detail.Code != http.StatusOK {
		t.Fatalf("account detail: %d: %s", detail.Code, detail.Body)
	}
	var payload struct {
		Account persistence.Account      `json:"account"`
		Bots    []persistence.Bot        `json:"bots"`
		Games   []persistence.GameRecord `json:"games"`
	}
	if err := json.NewDecoder(detail.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Account.UserID != "spammer" || len(payload.Games) != 1 {
		t.Fatalf("unexpected detail: %#v", payload)
	}

	purged := tournamentRequest(
		t, handler, http.MethodDelete, "/api/admin/accounts/spammer/purge", nil, adminRouteToken,
	)
	if purged.Code != http.StatusOK {
		t.Fatalf("purge: %d: %s", purged.Code, purged.Body)
	}
	var purge persistence.AccountPurge
	if err := json.NewDecoder(purged.Body).Decode(&purge); err != nil {
		t.Fatal(err)
	}
	if purge.GamesDeleted != 1 {
		t.Fatalf("unexpected purge report: %#v", purge)
	}
	if _, err := data.Account(t.Context(), "spammer"); err == nil {
		t.Fatal("the purged account is still there")
	}
	// Purging is the neighbour of anonymizing, and the two must not have been
	// wired to the same handler: the other account keeps its row either way,
	// but only a purge would have taken the game with it.
	if _, err := data.Account(t.Context(), "regular"); err != nil {
		t.Fatalf("the opponent must survive: %v", err)
	}
	if missing := tournamentRequest(
		t, handler, http.MethodDelete, "/api/admin/accounts/spammer/purge", nil, adminRouteToken,
	); missing.Code != http.StatusNotFound {
		t.Fatalf("expected a second purge to 404, got %d: %s", missing.Code, missing.Body)
	}
}
