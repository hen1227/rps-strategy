package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	// The IANA zone database, embedded in the binary.
	//
	// The weekend arena runs on a wall clock in a named zone — "eight o'clock in New
	// York", which is a different UTC instant in July and in November — so
	// time.LoadLocation has to work. Without this it reads /usr/share/zoneinfo,
	// which a slim container image does not have, and the event would silently
	// not run rather than running at the wrong hour. See persistence/weekend.go.
	_ "time/tzdata"

	"rps-strategy/backend/internal/persistence"
	serverpkg "rps-strategy/backend/internal/server"
)

func main() {
	if err := run(); err != nil {
		log.Printf("RPS strategy server stopped: %v", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	allowedOrigins := strings.Split(os.Getenv("RPS_ALLOWED_ORIGINS"), ",")
	adminToken := strings.TrimSpace(os.Getenv("RPS_ADMIN_TOKEN"))
	if adminToken != "" && len(adminToken) < 32 {
		return errors.New("RPS_ADMIN_TOKEN must contain at least 32 characters")
	}
	databasePath := os.Getenv("RPS_DATABASE_PATH")
	if databasePath == "" {
		databasePath = "data/rps-strategy.sqlite"
	}
	if directory := filepath.Dir(databasePath); directory != "." {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			return fmt.Errorf("create database directory: %w", err)
		}
	}
	dataStore, err := persistence.Open(databasePath)
	if err != nil {
		return fmt.Errorf("initialize persistent data: %w", err)
	}
	defer func() {
		if err := dataStore.Close(); err != nil {
			log.Printf("close persistent data: %v", err)
		}
	}()

	listener, err := openListenerFromEnvironment()
	if err != nil {
		return err
	}
	defer func() {
		if err := listener.cleanup(); err != nil {
			log.Printf("listener cleanup: %v", err)
		}
	}()

	gameServer := serverpkg.NewWithStoreAndAdminToken(
		dataStore,
		allowedOrigins,
		adminToken,
	)
	// Optional: the download links a bot author pastes into a terminal are
	// built from the address a request arrived on when this is empty. Set it to
	// publish a different address than callers happen to connect to.
	gameServer.SetPublicBaseURL(os.Getenv("RPS_PUBLIC_URL"))
	httpServer := &http.Server{
		Addr:              listener.description,
		Handler:           gameServer.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go gameServer.Run(ctx)
	serveErrors := make(chan error, 1)
	go func() {
		log.Printf("RPS strategy server listening on %s", httpServer.Addr)
		serveErrors <- httpServer.Serve(listener.Listener)
	}()

	// Three ways this process ends, and by the time any of them fires they all
	// mean the same thing.
	//
	// A signal is the blunt one and stays blunt: `systemctl restart` or a Ctrl-C
	// stops the server now, and whatever was on the board is archived
	// unfinished below. That is the escape hatch, and it is why the drain is
	// not wired to SIGTERM — a server somebody needs to kill should die when
	// they say so, not wait out a game.
	//
	// A finished drain is the ordinary deploy: an administrator asked over
	// HTTP, the server stopped taking new games, the last one on the board
	// finished, and there is nothing left to lose by stopping. systemd's
	// Restart=always brings the new binary straight back up. See
	// internal/server/deploy_drain.go.
	select {
	case err := <-serveErrors:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve HTTP: %w", err)
	case <-ctx.Done():
		log.Printf("stopping on signal")
	case <-gameServer.UpdateFinished():
		log.Printf("stopping to be replaced by a new build")
		// Released now rather than by the deferred stop below, so a SIGTERM
		// arriving while the shutdown is under way is handled by Go's default
		// disposition and kills the process. Without this a deploy that wedges
		// in Shutdown would ignore the signal systemd sends to hurry it along,
		// and have to be waited out to TimeoutStopSec and SIGKILLed.
		stop()
	}

	shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownContext); err != nil {
		_ = httpServer.Close()
		return fmt.Errorf("gracefully shut down HTTP server: %w", err)
	}
	if err := <-serveErrors; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve HTTP during shutdown: %w", err)
	}
	// Games still on the board when the process stops are archived unfinished
	// rather than discarded, so a restart never loses the moves already played.
	//
	// A drain that ran its course leaves nothing here, which is the whole point
	// of it: the count below is zero on a clean deploy, and non-zero only when a
	// signal cut in or the drain ran out of patience.
	if archived := gameServer.ArchiveLiveGames(shutdownContext); archived > 0 {
		log.Printf("archived %d unfinished game(s) during shutdown", archived)
	}
	return nil
}
