package main

import (
	"context"
	"errors"
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	allowedOrigins := strings.Split(os.Getenv("RPS_ALLOWED_ORIGINS"), ",")
	databasePath := os.Getenv("RPS_DATABASE_PATH")
	if databasePath == "" {
		databasePath = "data/rps-strategy.sqlite"
	}
	if directory := filepath.Dir(databasePath); directory != "." {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			log.Fatalf("create database directory: %v", err)
		}
	}
	dataStore, err := persistence.Open(databasePath)
	if err != nil {
		log.Fatalf("initialize persistent data: %v", err)
	}
	defer func() {
		if err := dataStore.Close(); err != nil {
			log.Printf("close persistent data: %v", err)
		}
	}()
	gameServer := serverpkg.NewWithStore(dataStore, allowedOrigins)
	httpServer := &http.Server{
		Addr:              ":" + port,
		Handler:           gameServer.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go gameServer.Run(ctx)
	go func() {
		log.Printf("RPS strategy server listening on %s", httpServer.Addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-ctx.Done()
	shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownContext); err != nil {
		log.Printf("shutdown: %v", err)
	}
}
