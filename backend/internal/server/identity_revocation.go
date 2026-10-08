package server

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"rps-strategy/backend/internal/persistence"
)

// Telling Apple that a deleted account's token is no longer wanted.
//
// Deleting an account queues the token in the same transaction — see
// persistence/identity_revocation.go — and this is the other half: a worker
// that works through the queue on its own goroutine, because every attempt is
// a call to Apple and none of them may hold up a deletion or a game. A deletion
// wakes it, so the first attempt follows straight away; after a failure it
// waits, a little longer each time, and keeps trying.

const (
	// revocationSweepInterval is how often the worker looks for revocations
	// that have come due again after a failure.
	revocationSweepInterval = time.Minute
	// revocationBatch bounds one sweep, so a long queue after an outage is
	// worked through over several minutes rather than in one burst at Apple.
	revocationBatch = 20
	// revocationLongestWait caps the backoff. A token that has waited six hours
	// still gets tried four times a day for as long as it takes.
	revocationLongestWait = 6 * time.Hour
)

// runTokenRevocations is the worker. It returns when ctx ends.
func (server *Server) runTokenRevocations(ctx context.Context) {
	if pending, err := server.data.PendingTokenRevocations(ctx); err == nil && pending > 0 {
		log.Printf("%d Apple token revocation(s) still waiting from deleted accounts", pending)
	}
	ticker := time.NewTicker(revocationSweepInterval)
	defer ticker.Stop()
	for {
		server.revokeDueTokens(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-server.revocations:
		}
	}
}

// wakeTokenRevocations asks the worker to look now, which a deletion does. It
// never blocks: a wake that is already pending covers this one too.
func (server *Server) wakeTokenRevocations() {
	select {
	case server.revocations <- struct{}{}:
	default:
	}
}

// revokeDueTokens makes one attempt at each revocation that has come due.
func (server *Server) revokeDueTokens(ctx context.Context) {
	due, err := server.data.DueTokenRevocations(ctx, time.Now(), revocationBatch)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("read token revocations: %v", err)
		}
		return
	}
	for _, revocation := range due {
		if ctx.Err() != nil {
			return
		}
		if err := server.revokeToken(ctx, revocation); err != nil {
			wait := revocationBackoff(revocation.Attempts)
			log.Printf("could not revoke a deleted account's %s token (attempt %d, next in %s): %v",
				revocation.Provider, revocation.Attempts+1, wait, err)
			if err := server.data.PostponeTokenRevocation(
				ctx, revocation.ID, time.Now().Add(wait), err.Error(),
			); err != nil && ctx.Err() == nil {
				log.Printf("postpone token revocation: %v", err)
			}
			continue
		}
		if err := server.data.CompleteTokenRevocation(ctx, revocation.ID); err != nil {
			log.Printf("complete token revocation: %v", err)
		}
	}
}

func (server *Server) revokeToken(ctx context.Context, revocation persistence.TokenRevocation) error {
	switch revocation.Provider {
	case persistence.ProviderApple:
		if !server.apple.enabled {
			// It waits rather than goes. A server whose key was removed may
			// have it put back, and the token is still the only way to do this.
			return errors.New("Sign in with Apple is not configured, so the token waits")
		}
		return server.apple.revoke(ctx, revocation.ClientID, revocation.Token)
	default:
		return fmt.Errorf("this server has no way to revoke a %s token", revocation.Provider)
	}
}

// revocationBackoff is the wait after a revocation has failed `attempts` times
// before this one: a minute, doubling, capped at revocationLongestWait.
func revocationBackoff(attempts int) time.Duration {
	if attempts > 10 {
		return revocationLongestWait
	}
	wait := time.Minute << attempts
	if wait > revocationLongestWait {
		return revocationLongestWait
	}
	return wait
}
