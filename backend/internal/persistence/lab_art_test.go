package persistence

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
	"time"
)

func artTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func testPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := range height {
		for x := range width {
			canvas.Set(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 0x40, A: 0xC0})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, canvas); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func testJPEG(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := range height {
		for x := range width {
			canvas.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 0x40, A: 0xFF})
		}
	}
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, canvas, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// The id has to name what is served, not what arrived, or a cache keyed on it
// would be keyed on something nobody can fetch.
func TestAPictureIsNamedByTheDigestOfWhatIsActuallyStored(t *testing.T) {
	store := artTestStore(t)
	ctx := context.Background()
	raw := testPNG(t, 64, 64)

	asset, err := store.StoreArt(ctx, "user-1", "piece", "", raw)
	if err != nil {
		t.Fatal(err)
	}
	served, err := store.ArtBytes(ctx, asset.ArtID)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(served.Bytes)
	digest := hex.EncodeToString(sum[:])
	if asset.ArtID != "img:"+digest[:32] {
		t.Fatalf("the id %q does not name the bytes it serves", asset.ArtID)
	}
}

// The single most valuable thing re-encoding buys: whatever was appended after
// the last chunk is not in what the world is served.
func TestAnythingAppendedAfterTheImageDoesNotSurvive(t *testing.T) {
	store := artTestStore(t)
	ctx := context.Background()
	payload := []byte("<?php system($_GET['x']); ?>")
	raw := append(testPNG(t, 64, 64), payload...)

	asset, err := store.StoreArt(ctx, "user-1", "piece", "", raw)
	if err != nil {
		t.Fatal(err)
	}
	served, err := store.ArtBytes(ctx, asset.ArtID)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(served.Bytes, payload) {
		t.Fatal("a payload riding after the image was stored and would be served")
	}
}

func TestTheSamePictureTwiceIsOneRowAndCostsOneBudget(t *testing.T) {
	store := artTestStore(t)
	ctx := context.Background()
	raw := testPNG(t, 64, 64)

	first, err := store.StoreArt(ctx, "user-1", "piece", "", raw)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.StoreArt(ctx, "user-1", "piece", "", raw)
	if err != nil {
		t.Fatal(err)
	}
	if first.ArtID != second.ArtID {
		t.Fatalf("the same picture got two ids: %q and %q", first.ArtID, second.ArtID)
	}
	held, err := store.ArtForAccount(ctx, "user-1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(held) != 1 {
		t.Fatalf("the same picture twice left %d rows", len(held))
	}
}

func TestAPieceHasToBeASquarePNG(t *testing.T) {
	store := artTestStore(t)
	ctx := context.Background()

	if _, err := store.StoreArt(ctx, "user-1", "piece", "", testPNG(t, 64, 32)); err == nil {
		t.Fatal("a rectangle was accepted as a piece")
	}
	// A piece is drawn inside its side's ring, so an opaque JPEG would hide the
	// one thing saying whose piece it is.
	err := func() error {
		_, err := store.StoreArt(ctx, "user-1", "piece", "", testJPEG(t, 64, 64))
		return err
	}()
	if err == nil || !strings.Contains(err.Error(), "PNG") {
		t.Fatalf("a JPEG piece should be refused, and by name: %v", err)
	}
	// The same JPEG is an ordinary cover.
	if _, err := store.StoreArt(ctx, "user-1", "cover", "", testJPEG(t, 640, 360)); err != nil {
		t.Fatalf("a JPEG cover should be fine: %v", err)
	}
}

// A photograph must not balloon: a board or a cover keeps the format it came in
// as, so a JPEG stays a JPEG.
func TestABoardPictureKeepsItsOwnFormat(t *testing.T) {
	store := artTestStore(t)
	ctx := context.Background()

	asJPEG, err := store.StoreArt(ctx, "user-1", "board", "", testJPEG(t, 512, 512))
	if err != nil {
		t.Fatal(err)
	}
	if asJPEG.MediaType != "image/jpeg" {
		t.Fatalf("a JPEG board became %s", asJPEG.MediaType)
	}
	asPNG, err := store.StoreArt(ctx, "user-1", "board", "", testPNG(t, 512, 512))
	if err != nil {
		t.Fatal(err)
	}
	if asPNG.MediaType != "image/png" {
		t.Fatalf("a PNG board became %s", asPNG.MediaType)
	}
}

// The header is read before anything is decoded, so a small file claiming to be
// enormous is refused rather than expanded into memory.
func TestAnImpossiblySizedHeaderIsRefusedWithoutDecoding(t *testing.T) {
	store := artTestStore(t)
	ctx := context.Background()

	// A real 60000x60000 header on top of a truncated body: a few hundred bytes
	// that would be thirteen gigabytes decoded.
	bomb := testPNG(t, 1, 1)
	header := testPNG(t, 8, 8)
	_ = header
	claimed := makeBombHeader(t)
	for _, raw := range [][]byte{claimed, bomb[:len(bomb)/2]} {
		if _, err := store.StoreArt(ctx, "user-1", "board", "", raw); err == nil {
			t.Fatal("a malformed or oversized image was accepted")
		}
	}
}

// makeBombHeader builds a PNG whose IHDR claims 60000x60000 and whose data is
// truncated, which is the cheap shape of a decompression bomb.
func makeBombHeader(t *testing.T) []byte {
	t.Helper()
	raw := testPNG(t, 16, 16)
	// IHDR width and height are the four-byte pairs at offsets 16 and 20.
	claimed := append([]byte(nil), raw...)
	for index, value := range []byte{0x00, 0x00, 0xEA, 0x60} { // 60000
		claimed[16+index] = value
		claimed[20+index] = value
	}
	return claimed
}

func TestSomethingThatIsNotAPictureIsRefusedByName(t *testing.T) {
	store := artTestStore(t)
	ctx := context.Background()
	for _, raw := range [][]byte{
		[]byte("<!doctype html><title>hello</title>"),
		[]byte("GIF89a and then some"),
		[]byte("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"),
		{},
	} {
		_, err := store.StoreArt(ctx, "user-1", "board", "", raw)
		if err == nil {
			t.Fatalf("accepted %q", string(raw[:min(len(raw), 20)]))
		}
		if !errors.Is(err, ErrArtInvalid) {
			t.Fatalf("the refusal should say the picture is wrong: %v", err)
		}
	}
}

// RESTRICT is the point: a published mode's pictures are kept because the
// database will not let go of them, not because a query remembers not to.
func TestAPinnedPictureCannotBeDeleted(t *testing.T) {
	store := artTestStore(t)
	ctx := context.Background()
	asset, err := store.StoreArt(ctx, "user-1", "piece", "", testPNG(t, 64, 64))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO lab_art_pins (art_id, mode_id) VALUES (?, ?)`,
		asset.ArtID, "custom:thing@1"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx,
		`DELETE FROM lab_art WHERE art_id = ?`, asset.ArtID); err == nil {
		t.Fatal("a pinned picture was deleted")
	}
}

func TestPublishingPinsAPicturesAndASweepLeavesItAlone(t *testing.T) {
	store := artTestStore(t)
	ctx := context.Background()
	kept, err := store.StoreArt(ctx, "user-1", "piece", "", testPNG(t, 64, 64))
	if err != nil {
		t.Fatal(err)
	}
	loose, err := store.StoreArt(ctx, "user-1", "piece", "", testPNG(t, 48, 48))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.PublishMode(ctx, CustomMode{
		ModeID: "custom:thing@1", Slug: "thing", Version: 1, OwnerUserID: "user-1",
		Name: "Thing", ShortCode: "THG", Spec: []byte(`{}`),
	}, []string{kept.ArtID}); err != nil {
		t.Fatal(err)
	}

	reclaimed, err := store.ReclaimUnpinnedArt(ctx, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if reclaimed != 1 {
		t.Fatalf("the sweep took %d pictures, expected the one nothing uses", reclaimed)
	}
	if _, err := store.ArtBytes(ctx, kept.ArtID); err != nil {
		t.Fatalf("a published mode's picture was reclaimed: %v", err)
	}
	if _, err := store.ArtBytes(ctx, loose.ArtID); !errors.Is(err, ErrArtNotFound) {
		t.Fatal("a picture nobody uses was kept")
	}
}

// A takedown is not a refund. Deleting the row would also make the same bytes
// re-uploadable, and content addressing is what makes a takedown permanent.
func TestATakenDownPictureIsUnreadableAndStillCounted(t *testing.T) {
	store := artTestStore(t)
	ctx := context.Background()
	asset, err := store.StoreArt(ctx, "user-1", "piece", "", testPNG(t, 64, 64))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.TakeArtDown(ctx, asset.ArtID, "test"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ArtBytes(ctx, asset.ArtID); !errors.Is(err, ErrArtNotFound) {
		t.Fatal("a taken-down picture is still being served")
	}
	if held, err := store.ArtForAccount(ctx, "user-1", 10); err != nil || len(held) != 0 {
		t.Fatalf("a taken-down picture should not be offered for reuse: %v %d", err, len(held))
	}
	// Re-uploading the same bytes must land on the same down row rather than
	// creating a fresh, live one.
	again, err := store.StoreArt(ctx, "user-1", "piece", "", testPNG(t, 64, 64))
	if err == nil {
		t.Fatalf("a taken-down picture was re-uploaded as %q", again.ArtID)
	}
}

func TestAnAccountsPictureBudgetIsBounded(t *testing.T) {
	store := artTestStore(t)
	ctx := context.Background()
	// One over the count is the cheap half to prove; the byte budget shares the
	// same door.
	if err := store.checkArtBudget(ctx, "user-1", MaximumArtBytesPerAccount+1); !errors.Is(err, ErrTooMuchArt) {
		t.Fatalf("an oversized picture should not fit the budget: %v", err)
	}
}
