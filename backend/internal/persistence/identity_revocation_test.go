package persistence

import (
	"testing"
	"time"
)

// appleAccountWithToken makes an account that signed in with Apple and kept the
// refresh token the revocation needs.
func appleAccountWithToken(t *testing.T, store *Store, userID, username, subject, token string) {
	t.Helper()
	anonymousAccount(t, store, userID, "Guest")
	if _, err := store.ClaimAccountWithIdentity(
		t.Context(), userID, username, AppleIdentity(subject, token, testAppleClientID),
	); err != nil {
		t.Fatalf("claim %s with apple: %v", userID, err)
	}
}

func dueRevocations(t *testing.T, store *Store) []TokenRevocation {
	t.Helper()
	due, err := store.DueTokenRevocations(t.Context(), time.Now(), 50)
	if err != nil {
		t.Fatal(err)
	}
	return due
}

// Every way an account can leave queues its Apple token: the player deleting
// it (anonymized in place when it has played, removed outright when it has
// not) and an administrator purging it. None of them may forget, which is why
// the queueing is a trigger rather than a step each of them takes.
func TestEveryWayAnAccountLeavesQueuesItsAppleToken(t *testing.T) {
	for name, leave := range map[string]func(t *testing.T, store *Store, userID string){
		"deleted before playing": func(t *testing.T, store *Store, userID string) {
			if _, err := store.AnonymizeAccount(t.Context(), userID); err != nil {
				t.Fatal(err)
			}
		},
		"deleted after playing": func(t *testing.T, store *Store, userID string) {
			anonymousAccount(t, store, "opponent", "Opponent")
			playRankedGame(t, store, "game-1", userID, "opponent")
			if _, err := store.AnonymizeAccount(t.Context(), userID); err != nil {
				t.Fatal(err)
			}
		},
		"purged by an administrator": func(t *testing.T, store *Store, userID string) {
			if _, err := store.PurgeAccount(t.Context(), userID); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			store := authTestStore(t)
			appleAccountWithToken(t, store, "leaver", "Leaver", testAppleSubject, "refresh-token")

			leave(t, store, "leaver")

			due := dueRevocations(t, store)
			if len(due) != 1 {
				t.Fatalf("queued %d revocations, want 1", len(due))
			}
			if due[0].Provider != ProviderApple || due[0].Token != "refresh-token" ||
				due[0].ClientID != testAppleClientID {
				t.Fatalf("queued the wrong thing: %+v", due[0])
			}
			// And the identity is free: the same Apple ID signs up afresh.
			if _, err := store.AccountForIdentity(
				t.Context(), ProviderApple, testAppleSubject,
			); err == nil {
				t.Fatal("the Apple ID still opens the account that left")
			}
		})
	}
}

// Nothing to revoke, nothing queued: a Discord link, and an Apple sign-in whose
// code exchange failed and so left no token.
func TestOnlyAStoredTokenIsQueued(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	anonymousAccount(t, store, "discord", "Guest")
	if _, err := store.ClaimAccountWithIdentity(
		ctx, "discord", "Yuki", DiscordIdentity("80351110224678912", "yuki"),
	); err != nil {
		t.Fatal(err)
	}
	appleAccountWithToken(t, store, "tokenless", "Tokenless", testAppleSubject, "")
	for _, userID := range []string{"discord", "tokenless"} {
		if _, err := store.AnonymizeAccount(ctx, userID); err != nil {
			t.Fatal(err)
		}
	}
	if due := dueRevocations(t, store); len(due) != 0 {
		t.Fatalf("queued %d revocations for accounts with no token: %+v", len(due), due)
	}
}

// A failed attempt waits its turn, and a finished one is forgotten entirely.
func TestARevocationWaitsAfterAFailureAndIsForgottenWhenDone(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	appleAccountWithToken(t, store, "leaver", "Leaver", testAppleSubject, "refresh-token")
	if _, err := store.AnonymizeAccount(ctx, "leaver"); err != nil {
		t.Fatal(err)
	}
	due := dueRevocations(t, store)
	if len(due) != 1 {
		t.Fatalf("queued %d, want 1", len(due))
	}

	next := time.Now().Add(time.Hour)
	if err := store.PostponeTokenRevocation(ctx, due[0].ID, next, "apple was down"); err != nil {
		t.Fatal(err)
	}
	if now := dueRevocations(t, store); len(now) != 0 {
		t.Fatalf("a postponed revocation was due at once: %+v", now)
	}
	later, err := store.DueTokenRevocations(ctx, next.Add(time.Second), 10)
	if err != nil || len(later) != 1 || later[0].Attempts != 1 {
		t.Fatalf("the postponed revocation did not come back counted: %v %+v", err, later)
	}

	if err := store.CompleteTokenRevocation(ctx, due[0].ID); err != nil {
		t.Fatal(err)
	}
	if pending, err := store.PendingTokenRevocations(ctx); err != nil || pending != 0 {
		t.Fatalf("a completed revocation was kept: %d %v", pending, err)
	}
}
