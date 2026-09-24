package main

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenListenerFromEnvironmentUsesUnixSocket(t *testing.T) {
	socketPath := filepath.Join(shortSocketDirectory(t), "nested", "server.sock")
	t.Setenv(unixSocketEnv, "unix:"+socketPath)
	t.Setenv("PORT", "not-a-port")

	listener, err := openListenerFromEnvironment()
	if err != nil {
		t.Fatalf("open Unix listener: %v", err)
	}
	t.Cleanup(func() { _ = listener.cleanup() })

	if listener.description != "unix:"+socketPath {
		t.Fatalf("unexpected listener description %q", listener.description)
	}
	info, err := os.Lstat(socketPath)
	if err != nil {
		t.Fatalf("inspect Unix socket: %v", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("expected a Unix socket, got mode %s", info.Mode())
	}
	if permissions := info.Mode().Perm(); permissions != unixSocketMode {
		t.Fatalf("expected socket permissions %04o, got %04o", unixSocketMode, permissions)
	}

	if err := listener.cleanup(); err != nil {
		t.Fatalf("clean up Unix listener: %v", err)
	}
	if _, err := os.Lstat(socketPath); !os.IsNotExist(err) {
		t.Fatalf("expected socket removal after cleanup, got %v", err)
	}
}

func TestOpenUnixListenerRecoversStaleSocket(t *testing.T) {
	socketPath := filepath.Join(shortSocketDirectory(t), "server.sock")
	address := &net.UnixAddr{Name: socketPath, Net: "unix"}
	staleListener, err := net.ListenUnix("unix", address)
	if err != nil {
		t.Fatalf("create stale Unix socket: %v", err)
	}
	staleListener.SetUnlinkOnClose(false)
	if err := staleListener.Close(); err != nil {
		t.Fatalf("close stale Unix socket: %v", err)
	}

	listener, err := openUnixListener(socketPath)
	if err != nil {
		t.Fatalf("recover stale Unix socket: %v", err)
	}
	t.Cleanup(func() { _ = listener.cleanup() })

	connection, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("dial recovered Unix socket: %v", err)
	}
	_ = connection.Close()
}

func TestOpenUnixListenerRejectsActiveSocket(t *testing.T) {
	socketPath := filepath.Join(shortSocketDirectory(t), "server.sock")
	address := &net.UnixAddr{Name: socketPath, Net: "unix"}
	activeListener, err := net.ListenUnix("unix", address)
	if err != nil {
		t.Fatalf("create active Unix socket: %v", err)
	}
	t.Cleanup(func() { _ = activeListener.Close() })

	listener, err := openUnixListener(socketPath)
	if listener != nil {
		_ = listener.cleanup()
		t.Fatal("unexpectedly opened a second listener on an active socket")
	}
	if err == nil || !strings.Contains(err.Error(), "already accepting connections") {
		t.Fatalf("expected active socket error, got %v", err)
	}
	if _, err := os.Lstat(socketPath); err != nil {
		t.Fatalf("active socket was removed: %v", err)
	}
}

func TestOpenUnixListenerRefusesToReplaceRegularFile(t *testing.T) {
	socketPath := filepath.Join(shortSocketDirectory(t), "server.sock")
	if err := os.WriteFile(socketPath, []byte("keep me"), 0o600); err != nil {
		t.Fatalf("create sentinel file: %v", err)
	}

	listener, err := openUnixListener(socketPath)
	if listener != nil {
		_ = listener.cleanup()
		t.Fatal("unexpectedly replaced a regular file")
	}
	if err == nil || !strings.Contains(err.Error(), "refusing to replace non-socket") {
		t.Fatalf("expected non-socket error, got %v", err)
	}
	contents, err := os.ReadFile(socketPath)
	if err != nil {
		t.Fatalf("read sentinel file: %v", err)
	}
	if string(contents) != "keep me" {
		t.Fatalf("sentinel file changed to %q", contents)
	}
}

func TestCleanupDoesNotRemoveReplacementSocket(t *testing.T) {
	socketPath := filepath.Join(shortSocketDirectory(t), "server.sock")
	listener, err := openUnixListener(socketPath)
	if err != nil {
		t.Fatalf("open Unix listener: %v", err)
	}
	unixListener := listener.Listener.(*net.UnixListener)
	unixListener.SetUnlinkOnClose(false)
	if err := unixListener.Close(); err != nil {
		t.Fatalf("close original listener: %v", err)
	}
	if err := os.Remove(socketPath); err != nil {
		t.Fatalf("remove original socket: %v", err)
	}

	replacementAddress := &net.UnixAddr{Name: socketPath, Net: "unix"}
	replacement, err := net.ListenUnix("unix", replacementAddress)
	if err != nil {
		t.Fatalf("create replacement socket: %v", err)
	}
	t.Cleanup(func() { _ = replacement.Close() })

	if err := listener.cleanup(); err != nil {
		t.Fatalf("clean up original listener: %v", err)
	}
	if _, err := os.Lstat(socketPath); err != nil {
		t.Fatalf("replacement socket was removed: %v", err)
	}
}

// TestCleanupDoesNotRemoveReplacementSocket only fails where the filesystem
// hands a freed inode number straight back, which ext4 does and APFS and tmpfs
// do not. This is the same rule without that dependence. The file left at the
// path is the listener's own, but once the listener is closed it looks exactly
// like a replacement that was given the same inode number, so cleanup has to
// leave it alone too.
func TestCleanupLeavesSocketOnceListenerIsClosed(t *testing.T) {
	socketPath := filepath.Join(shortSocketDirectory(t), "server.sock")
	listener, err := openUnixListener(socketPath)
	if err != nil {
		t.Fatalf("open Unix listener: %v", err)
	}
	// Closed behind cleanup's back. openUnixListener has turned off the
	// close's own unlink, so the file stays at the path.
	if err := listener.Listener.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}

	if err := listener.cleanup(); err != nil {
		t.Fatalf("clean up closed listener: %v", err)
	}
	if _, err := os.Lstat(socketPath); err != nil {
		t.Fatalf("socket was removed after its listener closed: %v", err)
	}
}

func TestOpenListenerFromEnvironmentFallsBackToTCP(t *testing.T) {
	t.Setenv(unixSocketEnv, "")
	t.Setenv("PORT", "0")

	listener, err := openListenerFromEnvironment()
	if err != nil {
		t.Fatalf("open TCP listener: %v", err)
	}
	t.Cleanup(func() { _ = listener.cleanup() })
	if listener.Listener.Addr().Network() != "tcp" {
		t.Fatalf("expected TCP listener, got %s", listener.Listener.Addr().Network())
	}
}

func shortSocketDirectory(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "rps-sock-")
	if err != nil {
		t.Fatalf("create short socket directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return directory
}
