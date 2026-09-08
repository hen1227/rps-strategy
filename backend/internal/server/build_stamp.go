package server

import (
	"os"
	"strconv"
	"sync"
)

// Which binary is answering.
//
// A deploy replaces the file, restarts the service, and then wants to know that
// the process now serving is the new one. /healthz cannot answer that on its
// own — the old build says "ok" just as cheerfully — so it carries a stamp, and
// deploy-backend.sh compares the stamp before and after. Without it the script
// would be reduced to sleeping and hoping, which is exactly the check that
// passes on a server that failed to restart.
//
// Two sources, in order:
//
//   - `-ldflags "-X rps-strategy/backend/internal/server.build=..."`, which is
//     what the deploy script sets, and which can be anything identifying: a
//     commit, a timestamp, the digest of the file.
//   - failing that, the size and modification time of the running executable.
//     Not pretty, and good enough for the one question being asked: two
//     different builds of this server essentially never share both.
//
// The fallback matters because this repository is not a git checkout on every
// machine it is built from, so `debug.ReadBuildInfo` has no VCS stamp to read,
// and `-trimpath -ldflags=-s -w` strips most of what is left.

// build is set at link time. Empty in a `go build` with no flags, and in tests.
var build string

var (
	stampOnce  sync.Once
	stampValue string
)

// buildStamp identifies this binary. Computed once: it cannot change while the
// process runs, and /healthz is polled.
func buildStamp() string {
	stampOnce.Do(func() {
		if build != "" {
			stampValue = build
			return
		}
		stampValue = executableStamp()
	})
	return stampValue
}

func executableStamp() string {
	path, err := os.Executable()
	if err != nil {
		return "unknown"
	}
	info, err := os.Stat(path)
	if err != nil {
		return "unknown"
	}
	return strconv.FormatInt(info.Size(), 36) + "-" +
		strconv.FormatInt(info.ModTime().UnixNano(), 36)
}
