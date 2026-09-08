package botclient

import (
	"strings"
	"testing"
)

// The version is declared once, in the Python file, and read back out of the
// very bytes the server serves. A regression here means the server tells
// people to upgrade to the version they are already running.
func TestVersionIsReadFromTheScriptThatIsServed(t *testing.T) {
	version := Version()
	if version == "" {
		t.Fatal("no version")
	}
	body, _ := Script()
	if !strings.Contains(body, `CLIENT_VERSION = "`+version+`"`) {
		t.Fatalf("version %q is not the one in the served script", version)
	}
	if CompareVersions(version, MinimumVersion) < 0 {
		t.Fatalf("the shipped client %q is older than the minimum %q", version, MinimumVersion)
	}
}

func TestVersionsCompareNumericallyNotAsText(t *testing.T) {
	for _, testCase := range []struct {
		left, right string
		want        int
	}{
		{"1.0", "1.0", 0},
		{"1.0", "1.1", -1},
		{"1.10", "1.9", 1}, // text comparison would get this backwards
		{"2", "1.9", 1},
		{"1.0.1", "1.0", 1},
	} {
		if got := CompareVersions(testCase.left, testCase.right); got != testCase.want {
			t.Errorf("compare(%q, %q) = %d, want %d",
				testCase.left, testCase.right, got, testCase.want)
		}
	}
}

// A client that sends no version, or something unreadable, is a client that
// predates versioning. It must be told to upgrade rather than let through.
func TestUnreadableVersionsAreTreatedAsAncient(t *testing.T) {
	for _, version := range []string{"", "   ", "junk", "1.x", "v1.0"} {
		upgrade, must := Outdated(version)
		if !upgrade || !must {
			t.Errorf("%q should be refused: upgrade=%v must=%v", version, upgrade, must)
		}
	}
	// The shipped one is neither.
	if upgrade, must := Outdated(Version()); upgrade || must {
		t.Errorf("the current version should be accepted: upgrade=%v must=%v", upgrade, must)
	}
}

func TestExampleEngineIsServedAndHashed(t *testing.T) {
	body, sum := ExampleEngine()
	if !strings.Contains(body, "bestmove") || len(sum) != 64 {
		t.Fatalf("example engine looks wrong: %d bytes, digest %q", len(body), sum)
	}
}

// A server that does not know its own public address must not put a bare path
// into somebody's terminal. This is what happened in development: the download
// link came back as "/api/bot/rpsbot.py", which resolves against whatever
// origin the page came from — the Expo dev server — and served the lobby back.
func TestUpgradeMessageNeverPrintsABarePath(t *testing.T) {
	for _, unusable := range []string{"", "/api/bot/rpsbot.py", "api/bot/rpsbot.py"} {
		message := UpgradeMessage(unusable)
		if strings.Contains(message, "/api/bot/rpsbot.py") {
			t.Errorf("a relative link reached the message for %q: %s", unusable, message)
		}
		if !strings.Contains(message, "the website") {
			t.Errorf("expected a pointer to the website for %q: %s", unusable, message)
		}
	}
	absolute := UpgradeMessage("https://api-rps.example/api/bot/rpsbot.py")
	if !strings.Contains(absolute, "https://api-rps.example/api/bot/rpsbot.py") {
		t.Errorf("an absolute link should be used verbatim: %s", absolute)
	}
}
