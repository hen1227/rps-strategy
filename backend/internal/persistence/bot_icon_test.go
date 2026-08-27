package persistence

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"testing"

	"rps-strategy/backend/internal/game"
)

// testIcon is a PNG of the given size, drawn rather than fetched so these tests
// need no fixture files.
func testIcon(t *testing.T, width int, height int) []byte {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, width, height))
	for x := range width {
		for y := range height {
			picture.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 0x80, A: 0xFF})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, picture); err != nil {
		t.Fatalf("encode test icon: %v", err)
	}
	return buffer.Bytes()
}

// ownedBot is a registered owner and a bot of theirs that has connected once.
// claimedBot, which does the second half, lives in bot_matches_test.go.
func ownedBot(t *testing.T, store *Store, name string) Bot {
	t.Helper()
	registeredOwner(t, store, "owner-"+name, "Owner"+name)
	return claimedBot(t, store, "owner-"+name, name)
}

func TestAnIconIsStoredAndReadBackAsAPNG(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	bot := ownedBot(t, store, "Iconic")

	if bot.IconSHA256 != "" {
		t.Fatalf("a new bot has no icon, got %q", bot.IconSHA256)
	}
	digest, err := store.SetBotIcon(ctx, bot.BotID, testIcon(t, BotIconPixels, BotIconPixels))
	if err != nil {
		t.Fatalf("set icon: %v", err)
	}
	if len(digest) != 64 {
		t.Fatalf("expected a hex digest, got %q", digest)
	}

	// The digest travels with the bot, because that is what tells a client
	// there is an icon to fetch without reading the image to find out.
	reread, err := store.Bot(ctx, bot.BotID)
	if err != nil {
		t.Fatalf("read bot: %v", err)
	}
	if reread.IconSHA256 != digest {
		t.Fatalf("bot carries %q, want %q", reread.IconSHA256, digest)
	}

	icon, err := store.BotIcon(ctx, bot.BotID)
	if err != nil {
		t.Fatalf("read icon: %v", err)
	}
	config, err := png.DecodeConfig(bytes.NewReader(icon.PNG))
	if err != nil {
		t.Fatalf("what came back is not a PNG: %v", err)
	}
	if config.Width != BotIconPixels || config.Height != BotIconPixels {
		t.Fatalf("stored %dx%d, want %d square", config.Width, config.Height, BotIconPixels)
	}
	if icon.SHA256 != digest || icon.UpdatedAtUnixMs == 0 {
		t.Fatalf("icon metadata is wrong: %+v", icon)
	}
}

// Everywhere a bot has played knows it by its account id, and only its owner's
// page knows the registry id. One endpoint answers to both so that no list has
// to carry an id it needs for nothing else.
func TestAnIconIsFoundByEitherOfABotsIDs(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	bot := ownedBot(t, store, "Ambidextrous")

	digest, err := store.SetBotIcon(ctx, bot.BotID, testIcon(t, 64, 64))
	if err != nil {
		t.Fatalf("set icon: %v", err)
	}
	for _, id := range []string{bot.BotID, bot.UserID} {
		icon, err := store.BotIcon(ctx, id)
		if err != nil {
			t.Fatalf("read icon by %q: %v", id, err)
		}
		if icon.SHA256 != digest {
			t.Fatalf("icon by %q has digest %q, want %q", id, icon.SHA256, digest)
		}
	}
	if !bytes.HasPrefix([]byte(bot.UserID), []byte(BotAccountPrefix)) {
		t.Fatalf("a bot account id must be tellable apart from a bot id, got %q", bot.UserID)
	}
}

func TestOnlySquarePNGsWithinTheLimitAreAccepted(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	bot := ownedBot(t, store, "Picky")

	oversized := testIcon(t, BotIconPixels+1, BotIconPixels+1)
	for name, raw := range map[string][]byte{
		"nothing at all":        {},
		"too many pixels":       oversized,
		"not square":            testIcon(t, BotIconPixels, BotIconPixels/2),
		"not a PNG":             []byte("GIF89a and then some"),
		"a header and no image": append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 32)...),
		"too many bytes":        make([]byte, MaximumBotIconBytes+1),
	} {
		if _, err := store.SetBotIcon(ctx, bot.BotID, raw); !errors.Is(err, ErrBotIconInvalid) {
			t.Errorf("%s should be refused, got %v", name, err)
		}
	}

	// A refusal leaves whatever is there alone, which is what lets the client
	// treat a bad file as "no change" rather than as "take my picture down".
	if _, err := store.SetBotIcon(ctx, bot.BotID, testIcon(t, 32, 32)); err != nil {
		t.Fatalf("a small square is fine: %v", err)
	}
	if _, err := store.SetBotIcon(ctx, bot.BotID, oversized); err == nil {
		t.Fatal("expected the oversized icon to be refused")
	}
	if _, err := store.BotIcon(ctx, bot.BotID); err != nil {
		t.Fatalf("the good icon should have survived a refused one: %v", err)
	}
}

// A bot reconnects on every network hiccup and re-asserts its whole config each
// time. None of that should rewrite a blob that has not changed.
func TestReSendingTheSameIconDoesNotRewriteIt(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	bot := ownedBot(t, store, "Repeater")
	raw := testIcon(t, BotIconPixels, BotIconPixels)

	first, err := store.SetBotIcon(ctx, bot.BotID, raw)
	if err != nil {
		t.Fatalf("set icon: %v", err)
	}
	// A sentinel timestamp rather than comparing two real ones: both writes
	// would land in the same millisecond and the test would pass either way.
	const sentinel = 4242
	if _, err := store.db.ExecContext(ctx,
		`UPDATE bot_icons SET updated_at_unix_ms = ? WHERE bot_id = ?`, sentinel, bot.BotID,
	); err != nil {
		t.Fatalf("mark the row: %v", err)
	}

	second, err := store.SetBotIcon(ctx, bot.BotID, raw)
	if err != nil {
		t.Fatalf("set icon again: %v", err)
	}
	if first != second {
		t.Fatalf("the same image gave two digests: %q then %q", first, second)
	}
	after, err := store.BotIcon(ctx, bot.BotID)
	if err != nil {
		t.Fatalf("read icon again: %v", err)
	}
	if after.UpdatedAtUnixMs != sentinel {
		t.Fatalf("an unchanged icon was rewritten: timestamp moved to %d", after.UpdatedAtUnixMs)
	}

	// A different image does write, or nothing would ever change.
	if _, err := store.SetBotIcon(ctx, bot.BotID, testIcon(t, 96, 96)); err != nil {
		t.Fatalf("set a different icon: %v", err)
	}
	changed, err := store.BotIcon(ctx, bot.BotID)
	if err != nil {
		t.Fatalf("read the new icon: %v", err)
	}
	if changed.UpdatedAtUnixMs == sentinel || changed.SHA256 == first {
		t.Fatalf("a changed icon was not stored: %+v", changed)
	}
}

func TestClearingAnIconRemovesItAndSaysNothingWhenThereIsNone(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	bot := ownedBot(t, store, "Bare")

	// Clearing an icon that was never set is how a client with no `icon` line
	// connects, so it has to be silent.
	if err := store.ClearBotIcon(ctx, bot.BotID); err != nil {
		t.Fatalf("clearing nothing should be fine: %v", err)
	}
	if _, err := store.SetBotIcon(ctx, bot.BotID, testIcon(t, 128, 128)); err != nil {
		t.Fatalf("set icon: %v", err)
	}
	if err := store.ClearBotIcon(ctx, bot.BotID); err != nil {
		t.Fatalf("clear icon: %v", err)
	}
	if _, err := store.BotIcon(ctx, bot.BotID); !errors.Is(err, ErrBotNotFound) {
		t.Fatalf("expected the icon to be gone, got %v", err)
	}
	reread, err := store.Bot(ctx, bot.BotID)
	if err != nil {
		t.Fatalf("read bot: %v", err)
	}
	if reread.IconSHA256 != "" {
		t.Fatalf("the digest should be gone too, got %q", reread.IconSHA256)
	}
}

// The bot ladder draws the engines it ranks, so the board has to carry the
// digest. The human board must not: people have no portrait here.
func TestTheBotLadderCarriesIconDigests(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	bot := ownedBot(t, store, "Ranked")
	digest, err := store.SetBotIcon(ctx, bot.BotID, testIcon(t, 128, 128))
	if err != nil {
		t.Fatalf("set icon: %v", err)
	}
	// Seeded rather than played: the board reads ratings and counts, so a real
	// game here would only put a board engine between the test and the query.
	seedRecord(t, store, bot.UserID, 1400, 6)

	for _, modeID := range []string{"", string(game.ModeTotalWar)} {
		entries, err := store.Leaderboard(ctx, LeaderboardFilter{
			ModeID: modeID,
			Kind:   LeaderboardKindBot,
		})
		if err != nil {
			t.Fatalf("leaderboard(%q): %v", modeID, err)
		}
		if len(entries) != 1 {
			t.Fatalf("leaderboard(%q) listed %d bots, want 1", modeID, len(entries))
		}
		if entries[0].IconSHA256 != digest {
			t.Fatalf("leaderboard(%q) carries %q, want %q",
				modeID, entries[0].IconSHA256, digest)
		}
	}
}
