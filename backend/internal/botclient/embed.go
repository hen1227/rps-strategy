// Package botclient serves the Python client and the example engine.
//
// They live inside a Go package because go:embed cannot reach outside its own
// directory, and that constraint is worth accepting: the script a player
// downloads is then always the one that matches the protocol this build
// speaks, rather than a copy that drifted. There is deliberately no second
// copy under frontend/public.
package botclient

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

//go:embed rpsbot.py
var script string

//go:embed example_engine.py
var exampleEngine string

//go:embed yardstick_random.py
var yardstickEngine string

//go:embed yardstick_greedy.py
var greedyEngine string

// The documents the website serves, so it can show exactly what the repository
// documents. go:embed cannot reach outside this directory, so these are copies
// of docs/bots.md, docs/rpsi.md and docs/notation.md — and `docs_test.go` fails
// the build if they stop matching, which is what keeps "a copy" from becoming
// "a different one".
//
//go:embed bots.md
var guideMarkdown string

//go:embed rpsi.md
var protocolMarkdown string

//go:embed notation.md
var notationMarkdown string

// MinimumVersion is the oldest client this server will talk to.
//
// Kept separate from the current version so that a release which only adds
// something optional does not lock out everyone who has not re-downloaded. It
// moves when a change makes an older client genuinely unable to play, and 1.4
// is the first move it has made.
//
// What makes 1.4 that kind of change is the rules underneath the notation: the
// board's orientation and two win conditions moved on 3 September 2026, and 1.4
// is the client that prints which rules its engine is playing under and says
// when they are not the ones that machine last saw. An engine written against
// the old board does not fail on connect — it plays legal moves into a position
// it has misread, and loses games its author then diagnoses from the outside.
// Refusing the older clients is how that is said once, at the door, instead.
const MinimumVersion = "1.4"

// versionPattern reads the version out of the script itself.
//
// Parsed rather than restated in Go, because two declarations of the same
// number are two chances to ship a mismatch — and a mismatch here means the
// server tells people to upgrade to the version they already have.
var versionPattern = regexp.MustCompile(`(?m)^CLIENT_VERSION = "([0-9]+(?:\.[0-9]+)*)"`)

// Version is the version of the embedded client.
func Version() string {
	match := versionPattern.FindStringSubmatch(script)
	if len(match) != 2 {
		// Unreachable in a build that passes its tests, and a panic here is far
		// better than silently serving an unversioned client.
		panic("botclient: rpsbot.py has no parseable CLIENT_VERSION")
	}
	return match[1]
}

// Script is the client, and the hex SHA-256 a player can check it against.
//
// The account page shows the same digest, so anyone can confirm the file they
// downloaded is the file the server is publishing before running it.
func Script() (string, string) {
	return script, digest(script)
}

// ExampleEngine is a complete working bot, short enough to read in one go.
func ExampleEngine() (string, string) {
	return exampleEngine, digest(exampleEngine)
}

// YardstickEngine is the anchor: the engine rating 1 is defined as.
//
// Published rather than kept in the deployment, and the digest beside it is the
// reason. Every rating on this server is a distance from this file, so anybody
// who wants to check what "no better than chance" actually means — or run their
// own copy to test against before entering the pool — can read it and confirm
// the server is running the same one.
func YardstickEngine() (string, string) {
	return yardstickEngine, digest(yardstickEngine)
}

// GreedyEngine is the rung above the anchor: capture when you can.
//
// Published for the same reason and with the same digest beside it. It is the
// rung most authors will actually be measured against on their first day — a
// first submission sits somewhere near it — so being able to read what it does
// and run a copy is the difference between a rating and a number.
func GreedyEngine() (string, string) {
	return greedyEngine, digest(greedyEngine)
}

// Guide is the bot-author README, Protocol the full RPSI reference, and
// Notation how a stored game is written down.
func Guide() string    { return guideMarkdown }
func Protocol() string { return protocolMarkdown }
func Notation() string { return notationMarkdown }

// CompareVersions orders two dotted numeric versions, returning -1, 0, or 1.
//
// A version it cannot read sorts before everything, so a client that sends
// nothing — or sends nonsense — is treated as ancient and told to upgrade
// rather than being let through.
func CompareVersions(left string, right string) int {
	leftParts, rightParts := versionParts(left), versionParts(right)
	for index := 0; index < len(leftParts) || index < len(rightParts); index++ {
		var leftValue, rightValue int
		if index < len(leftParts) {
			leftValue = leftParts[index]
		}
		if index < len(rightParts) {
			rightValue = rightParts[index]
		}
		if leftValue != rightValue {
			if leftValue < rightValue {
				return -1
			}
			return 1
		}
	}
	return 0
}

func versionParts(version string) []int {
	version = strings.TrimSpace(version)
	if version == "" {
		return []int{-1}
	}
	fields := strings.Split(version, ".")
	parts := make([]int, 0, len(fields))
	for _, field := range fields {
		value, err := strconv.Atoi(field)
		if err != nil {
			return []int{-1}
		}
		parts = append(parts, value)
	}
	return parts
}

// Outdated reports whether a client should be told to upgrade, and whether it
// is too old to be allowed to play at all.
func Outdated(clientVersion string) (upgradeAvailable bool, mustUpgrade bool) {
	return CompareVersions(clientVersion, Version()) < 0,
		CompareVersions(clientVersion, MinimumVersion) < 0
}

// UpgradeMessage is what a client too old to connect is told.
//
// The URL may still be empty — a caller can reach the server without a usable
// Host header, and RPS_PUBLIC_URL need not be set. Printing a bare path into
// somebody's terminal would be worse than saying nothing, so in that case the
// message points at the website instead.
func UpgradeMessage(downloadURL string) string {
	where := "the Bots page on the website"
	if strings.HasPrefix(downloadURL, "http://") || strings.HasPrefix(downloadURL, "https://") {
		where = downloadURL
	}
	return fmt.Sprintf(
		"this copy of rpsbot.py is too old for this server (needs %s or newer). Download the current one from %s",
		MinimumVersion, where,
	)
}

func digest(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}
