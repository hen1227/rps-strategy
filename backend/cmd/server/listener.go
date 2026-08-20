package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultPort        = "8080"
	unixSocketEnv      = "RPS_UNIX_SOCKET"
	unixSocketMode     = 0o660
	socketProbeTimeout = 250 * time.Millisecond
)

type configuredListener struct {
	net.Listener
	description string
	socketPath  string
	socketInfo  os.FileInfo

	cleanupOnce sync.Once
	cleanupErr  error
}

func openListenerFromEnvironment() (*configuredListener, error) {
	if socketPath := strings.TrimSpace(os.Getenv(unixSocketEnv)); socketPath != "" {
		return openUnixListener(socketPath)
	}

	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = defaultPort
	}
	listener, err := net.Listen("tcp", ":"+port)
	if err != nil {
		return nil, fmt.Errorf("listen on TCP port %s: %w", port, err)
	}
	return &configuredListener{
		Listener:    listener,
		description: listener.Addr().String(),
	}, nil
}

func openUnixListener(socketPath string) (*configuredListener, error) {
	socketPath = strings.TrimSpace(socketPath)
	socketPath = strings.TrimPrefix(socketPath, "unix:")
	socketPath = filepath.Clean(socketPath)
	if !filepath.IsAbs(socketPath) {
		return nil, fmt.Errorf("%s must be an absolute path: %q", unixSocketEnv, socketPath)
	}

	directory := filepath.Dir(socketPath)
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return nil, fmt.Errorf("create Unix socket directory %s: %w", directory, err)
	}
	if err := removeStaleUnixSocket(socketPath); err != nil {
		return nil, err
	}

	address := &net.UnixAddr{Name: socketPath, Net: "unix"}
	listener, err := net.ListenUnix("unix", address)
	if err != nil {
		return nil, fmt.Errorf("listen on Unix socket %s: %w", socketPath, err)
	}
	listener.SetUnlinkOnClose(true)
	if err := os.Chmod(socketPath, unixSocketMode); err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("set Unix socket permissions on %s: %w", socketPath, err)
	}
	socketInfo, err := os.Lstat(socketPath)
	if err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("inspect Unix socket %s: %w", socketPath, err)
	}

	return &configuredListener{
		Listener:    listener,
		description: "unix:" + socketPath,
		socketPath:  socketPath,
		socketInfo:  socketInfo,
	}, nil
}

func removeStaleUnixSocket(socketPath string) error {
	info, err := os.Lstat(socketPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect existing Unix socket %s: %w", socketPath, err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("refusing to replace non-socket path at %s", socketPath)
	}

	connection, dialErr := net.DialTimeout("unix", socketPath, socketProbeTimeout)
	if dialErr == nil {
		_ = connection.Close()
		return fmt.Errorf("Unix socket %s is already accepting connections", socketPath)
	}
	if errors.Is(dialErr, syscall.ENOENT) {
		return nil
	}
	if !errors.Is(dialErr, syscall.ECONNREFUSED) {
		return fmt.Errorf("probe existing Unix socket %s: %w", socketPath, dialErr)
	}
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove stale Unix socket %s: %w", socketPath, err)
	}
	return nil
}

func (listener *configuredListener) cleanup() error {
	listener.cleanupOnce.Do(func() {
		if err := listener.Listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			listener.cleanupErr = fmt.Errorf("close listener: %w", err)
		}
		if listener.socketPath == "" || listener.socketInfo == nil {
			return
		}

		currentInfo, err := os.Lstat(listener.socketPath)
		if errors.Is(err, os.ErrNotExist) {
			return
		}
		if err != nil {
			listener.cleanupErr = errors.Join(
				listener.cleanupErr,
				fmt.Errorf("inspect Unix socket during cleanup: %w", err),
			)
			return
		}
		if !os.SameFile(listener.socketInfo, currentInfo) {
			return
		}
		if err := os.Remove(listener.socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			listener.cleanupErr = errors.Join(
				listener.cleanupErr,
				fmt.Errorf("remove Unix socket during cleanup: %w", err),
			)
		}
	})
	return listener.cleanupErr
}
