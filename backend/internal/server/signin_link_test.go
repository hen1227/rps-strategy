package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"rps-strategy/backend/internal/persistence"
)

// The naming step's other door: somebody whose Apple ID is new here, but who
// already plays under Discord, signs in with Discord and hands the Apple ticket
// back with the session, rather than making a second account.

// linkTicketAt posts a held ticket to /api/auth/link under a session.
func linkTicketAt(t *testing.T, server *Server, session, ticket string) (signInReply, *string, int) {
	t.Helper()
	recorder := routeRequest(t, server, http.MethodPost, "/api/auth/link",
		signInTicketRequest{Ticket: ticket}, session)
	var reply signInReply
	_ = json.Unmarshal(recorder.Body.Bytes(), &reply)
	body := recorder.Body.String()
	return reply, &body, recorder.Code
}

// discordAccount makes the account the fake Discord identity opens, the way a
// returning player already has one.
func discordAccount(t *testing.T, data *persistence.Store, userID, username string) {
	t.Helper()
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), userID, "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := data.ClaimAccountWithIdentity(
		t.Context(), userID, username, persistence.DiscordIdentity("80351110224678912", "yuki"),
	); err != nil {
		t.Fatal(err)
	}
}

func TestANewAppleIDLinksToTheDiscordAccountSignedIntoNext(t *testing.T) {
	server, data, fake := appleTestServer(t)
	discordAccount(t, data, "player", "Yuki")

	// Apple first, signed out: the Apple ID is new, so the naming step opens.
	apple, status := appleSignIn(t, server, fake, "", "", "code")
	if status != http.StatusOK || !apple.NeedsUsername || apple.Ticket == "" {
		t.Fatalf("a new Apple ID should ask for a name: %d %+v", status, apple)
	}
	// "I already have an account": Discord, signed out, finds it.
	state := beginDiscordSignIn(t, server, "", "")
	discordTicket, _ := followDiscordCallback(t, server, state)
	discord, status := redeemDiscordTicket(t, server, discordTicket)
	if status != http.StatusOK || discord.Token == "" || discord.Account.UserID != "player" {
		t.Fatalf("Discord did not open the existing account: %d %+v", status, discord)
	}

	linked, body, status := linkTicketAt(t, server, discord.Token, apple.Ticket)
	if status != http.StatusOK || linked.Account == nil || linked.Account.UserID != "player" ||
		linked.Account.Username != "Yuki" || linked.Provider != persistence.ProviderApple {
		t.Fatalf("link: %d %s", status, *body)
	}
	if linked.Token != "" {
		t.Fatalf("a link minted a second session: %s", *body)
	}
	methods, err := data.SignInMethods(t.Context(), "player")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(methods.Methods, ",") != "discord,apple" {
		t.Fatalf("methods: %v", methods.Methods)
	}
	// And Apple alone now opens the same account, with no naming step.
	again, status := appleSignIn(t, server, fake, "", "", "later-code")
	if status != http.StatusOK || again.NeedsUsername || again.Account == nil ||
		again.Account.UserID != "player" {
		t.Fatalf("Apple did not open the linked account: %d %+v", status, again)
	}
	// The ticket was spent by the link.
	if _, _, status := linkTicketAt(t, server, discord.Token, apple.Ticket); status != http.StatusUnauthorized {
		t.Fatalf("a spent ticket linked again: %d", status)
	}
}

// The other order: Discord is the new one, and the account signs in with Apple.
func TestANewDiscordLinksToTheAppleAccountSignedIntoNext(t *testing.T) {
	server, _, fake := appleTestServer(t)
	first, _ := appleSignIn(t, server, fake, "", "", "code")
	made, status := completeSignInAt(t, server, first.Ticket, "Orchard")
	if status != http.StatusOK || made.Account == nil {
		t.Fatalf("setup: %d %+v", status, made)
	}

	state := beginDiscordSignIn(t, server, "", "")
	discordTicket, _ := followDiscordCallback(t, server, state)
	pending, status := redeemDiscordTicket(t, server, discordTicket)
	if status != http.StatusOK || !pending.NeedsUsername {
		t.Fatalf("a new Discord should ask for a name: %d %+v", status, pending)
	}
	apple, status := appleSignIn(t, server, fake, "", "", "second-code")
	if status != http.StatusOK || apple.Token == "" || apple.Account.UserID != made.Account.UserID {
		t.Fatalf("Apple did not open the account: %d %+v", status, apple)
	}

	linked, body, status := linkTicketAt(t, server, apple.Token, discordTicket)
	if status != http.StatusOK || linked.Account == nil || !linked.Account.DiscordVerified ||
		linked.Account.Username != "Orchard" {
		t.Fatalf("link: %d %s", status, *body)
	}
}

func TestLinkingATicketNeedsASession(t *testing.T) {
	server, _, fake := appleTestServer(t)
	apple, _ := appleSignIn(t, server, fake, "", "", "code")
	if _, _, status := linkTicketAt(t, server, "", apple.Ticket); status != http.StatusUnauthorized {
		t.Fatalf("a link without a session answered %d", status)
	}
	// And the refusal leaves the ticket for the naming step it came from.
	if done, status := completeSignInAt(t, server, apple.Ticket, "Orchard"); status != http.StatusOK ||
		done.Account == nil {
		t.Fatalf("the ticket did not survive a refused link: %d %+v", status, done)
	}
}

// A Discord account that already opens somebody else's account is not moved:
// the refusal says where it leads.
func TestLinkingATicketHeldByAnotherAccountIsRefusedWithTheWayOut(t *testing.T) {
	server, data, fake := appleTestServer(t)
	discordAccount(t, data, "player", "Yuki")
	first, _ := appleSignIn(t, server, fake, "", "", "code")
	other, status := completeSignInAt(t, server, first.Ticket, "Orchard")
	if status != http.StatusOK {
		t.Fatalf("setup: %d", status)
	}

	state := beginDiscordSignIn(t, server, "", "")
	discordTicket, _ := followDiscordCallback(t, server, state)
	_, body, status := linkTicketAt(t, server, other.Token, discordTicket)
	if status != http.StatusConflict || !strings.Contains(*body, "sign in with Discord to use it") {
		t.Fatalf("linking a Discord held elsewhere answered %d: %s", status, *body)
	}
	methods, err := data.SignInMethods(t.Context(), other.Account.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(methods.Methods, ",") != "apple" {
		t.Fatalf("a refused link changed the account: %v", methods.Methods)
	}
}

func TestLinkingASecondAppleIDIsRefused(t *testing.T) {
	server, data, fake := appleTestServer(t)
	discordAccount(t, data, "player", "Yuki")
	if _, err := data.LinkIdentity(
		t.Context(), "player", persistence.AppleIdentity("000999.other.0001", "", ""),
	); err != nil {
		t.Fatal(err)
	}
	session, err := data.CreateSession(t.Context(), "player")
	if err != nil {
		t.Fatal(err)
	}

	apple, _ := appleSignIn(t, server, fake, "", "", "code")
	if !apple.NeedsUsername {
		t.Fatalf("setup: the test Apple ID should be new: %+v", apple)
	}
	_, body, status := linkTicketAt(t, server, session, apple.Ticket)
	if status != http.StatusConflict || !strings.Contains(*body, "different Apple ID") {
		t.Fatalf("a second Apple ID answered %d: %s", status, *body)
	}
}

func TestAStoreReviewSessionIsRefusedALinkedTicket(t *testing.T) {
	server, data, fake := appleTestServer(t)
	reset, err := data.ResetStoreReviewAccount(t.Context(), "apple",
		persistence.StoreReviewOptions{Username: "ReviewAda"})
	if err != nil {
		t.Fatal(err)
	}
	session, err := data.CreateSession(t.Context(), reset.UserID)
	if err != nil {
		t.Fatal(err)
	}
	apple, _ := appleSignIn(t, server, fake, "", "", "code")
	_, body, status := linkTicketAt(t, server, session, apple.Ticket)
	if status != http.StatusForbidden || !strings.Contains(*body, "can't link an Apple ID") {
		t.Fatalf("a review session was not refused: %d %s", status, *body)
	}
}
