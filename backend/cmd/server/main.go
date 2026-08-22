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

	select {
	case err := <-serveErrors:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve HTTP: %w", err)
	case <-ctx.Done():
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
	if archived := gameServer.ArchiveLiveGames(shutdownContext); archived > 0 {
		log.Printf("archived %d unfinished game(s) during shutdown", archived)
	}
	return nil
}
