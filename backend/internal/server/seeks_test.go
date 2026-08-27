package server

import (
	"strconv"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// testBoard is a seek board with a frozen clock, so a test can say how long
// somebody has been waiting instead of waiting.
func testBoard(onPair func(*Seek, *Seek)) (*seekBoard, func(time.Time)) {
	board := newSeekBoard(onPair)
	now := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	board.now = func() time.Time { return now }
	return board, func(moment time.Time) { now = moment }
}

var testSeekCounter int

// postTestSeek puts one seek on a board, the way postSeek does but without a
// server. Each gets a later JoinedAt than the last, so "oldest first" is the
// order they were written in.
func postTestSeek(board *seekBoard, client *Client, setup game.GameSetup) *Seek {
	testSeekCounter++
	definition := game.ModeDefinition{ID: setup.ModeID}
	seek := &Seek{
		ID:     "seek-" + strconv.Itoa(testSeekCounter),
		Owner:  seekOwnerKey(client),
		Poster: client.profile,
		Setup:  setup.Normalize(definition),
		Elo:    matchmakingElo(client, setup.ModeID),
		// Counted from this board rather than globally, so the same test reads
		// the same whichever tests ran before it.
		JoinedAt: board.now().Add(time.Duration(board.Len()+1) * time.Millisecond),
	}
	seek.bind(client)
	board.Post(seek)
	return seek
}

func standardSeek(board *seekBoard, client *Client, modeID game.ModeID) *Seek {
	return postTestSeek(board, client, game.GameSetup{ModeID: modeID})
}

func TestSeeksPairInTheSameMode(t *testing.T) {
	pairs := 0
	board, _ := testBoard(func(*Seek, *Seek) { pairs++ })
	standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "first"}}, game.ModeTotalWar)
	standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "second"}}, game.ModeTotalWar)

	board.pair()
	if pairs != 1 {
		t.Fatalf("expected one pair, got %d", pairs)
	}
}

func TestSeeksNeverPairDifferentModes(t *testing.T) {
	pairs := 0
	board, _ := testBoard(func(*Seek, *Seek) { pairs++ })
	standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "first"}}, game.ModeTotalWar)
	standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "second"}}, game.ModeID("other"))

	board.pair()
	if pairs != 0 {
		t.Fatal("seeks for different opaque mode IDs must never pair")
	}
}

func TestSeeksNeverPairDifferentTimeControls(t *testing.T) {
	pairs := 0
	board, _ := testBoard(func(*Seek, *Seek) { pairs++ })
	postTestSeek(board, &Client{profile: game.PlayerProfile{UserID: "first"}}, game.GameSetup{
		ModeID:      game.ModeTotalWar,
		TimeControl: game.TimeControl{InitialTimeMs: 60_000, IncrementMs: 1_000},
	})
	postTestSeek(board, &Client{profile: game.PlayerProfile{UserID: "second"}}, game.GameSetup{
		ModeID:      game.ModeTotalWar,
		TimeControl: game.TimeControl{InitialTimeMs: 60_000, IncrementMs: 2_000},
	})

	board.pair()
	if pairs != 0 {
		t.Fatal("seeks asking for different clocks must never pair")
	}
}

// The point of one setup value: two people who wrote out the same unusual game
// find each other without either of them clicking the other's row.
func TestIdenticalCustomSetupsPairThemselves(t *testing.T) {
	var matched [2]QueueEntry
	board, _ := testBoard(func(first, second *Seek) {
		matched = [2]QueueEntry{first.entry(first.Client()), second.entry(second.Client())}
	})
	setup := game.GameSetup{
		ModeID:      game.ModeTotalWar,
		TimeControl: game.TimeControl{InitialTimeMs: 60_000, IncrementMs: 1_000},
		Rules:       game.RuleFlags{NoDrawOffers: true, NoTimeExtensions: true},
		Casual:      true,
	}
	postTestSeek(board, &Client{profile: game.PlayerProfile{UserID: "first"}}, setup)
	postTestSeek(board, &Client{profile: game.PlayerProfile{UserID: "second"}}, setup)

	board.pair()
	if matched[0].Client == nil || matched[1].Client == nil {
		t.Fatal("expected two identical custom setups to pair")
	}
	if matched[0].Setup.Rules != setup.Rules || matched[1].Setup.Rules != setup.Rules {
		t.Fatalf("paired seats lost their rules: %#v", matched)
	}
	if matched[0].Setup.Ranked() {
		t.Fatal("a casual setup must not produce a rated seat")
	}
}

func TestSeeksNeverPairDifferentRules(t *testing.T) {
	pairs := 0
	board, _ := testBoard(func(*Seek, *Seek) { pairs++ })
	postTestSeek(board, &Client{profile: game.PlayerProfile{UserID: "first"}}, game.GameSetup{
		ModeID: game.ModeTotalWar,
		Rules:  game.RuleFlags{NoRepetitionDraw: true},
	})
	standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "second"}}, game.ModeTotalWar)

	board.pair()
	if pairs != 0 {
		t.Fatal("a seek with a rule switched off must not pair with a normal game")
	}
}

func TestSeeksNeverPairRatedWithCasual(t *testing.T) {
	pairs := 0
	board, _ := testBoard(func(*Seek, *Seek) { pairs++ })
	postTestSeek(board, &Client{profile: game.PlayerProfile{UserID: "first"}}, game.GameSetup{
		ModeID: game.ModeTotalWar,
		Casual: true,
	})
	standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "second"}}, game.ModeTotalWar)

	board.pair()
	if pairs != 0 {
		t.Fatal("a casual seek must not be seated against a rated one")
	}
}

// A seat preference is the one difference that still leaves two people offering
// each other the same game — unless they both want the same seat.
func TestSeatPreferencesDecideColoursAndCompatibility(t *testing.T) {
	var red, blue *Client
	board, _ := testBoard(func(first, second *Seek) {
		redSeek, blueSeek := seatOrder(first, second)
		red, blue = redSeek.Client(), blueSeek.Client()
	})
	wantsBlue := &Client{profile: game.PlayerProfile{UserID: "wants-blue"}}
	noPreference := &Client{profile: game.PlayerProfile{UserID: "no-preference"}}
	postTestSeek(board, wantsBlue, game.GameSetup{
		ModeID:         game.ModeTotalWar,
		PreferredColor: game.Blue,
	})
	standardSeek(board, noPreference, game.ModeTotalWar)

	board.pair()
	if red != noPreference || blue != wantsBlue {
		t.Fatal("the seek that asked for Blue must get Blue")
	}

	pairs := 0
	contested, _ := testBoard(func(*Seek, *Seek) { pairs++ })
	for _, userID := range []string{"first", "second"} {
		postTestSeek(contested, &Client{profile: game.PlayerProfile{UserID: userID}}, game.GameSetup{
			ModeID:         game.ModeTotalWar,
			PreferredColor: game.Red,
		})
	}
	contested.pair()
	if pairs != 0 {
		t.Fatal("two seeks that both want Red cannot be seated together")
	}
}

// A private challenge waits for the person it names, however long that is.
func TestPrivateSeeksAreNeverPairedAutomatically(t *testing.T) {
	pairs := 0
	board, _ := testBoard(func(*Seek, *Seek) { pairs++ })
	first := standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "first"}}, game.ModeTotalWar)
	first.TargetUsername = "Bob"
	second := standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "second"}}, game.ModeTotalWar)
	second.TargetUsername = "Alice"

	board.pair()
	if pairs != 0 {
		t.Fatal("seeks addressed to a person must not be paired with a stranger")
	}
}

func TestSeeksDoNotPairTwoConnectionsForSameAccount(t *testing.T) {
	pairs := 0
	board, _ := testBoard(func(*Seek, *Seek) { pairs++ })
	standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "shared"}}, game.ModeTotalWar)
	standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "shared"}}, game.ModeTotalWar)

	board.pair()
	if pairs != 0 {
		t.Fatal("two browser connections for one account must not play each other")
	}
}

// One seek per client, enforced by the board rather than checked by its callers.
func TestPostingReplacesTheClientsPreviousSeek(t *testing.T) {
	board, _ := testBoard(func(*Seek, *Seek) {})
	client := &Client{profile: game.PlayerProfile{UserID: "restless"}}
	first := standardSeek(board, client, game.ModeTotalWar)
	second := standardSeek(board, client, game.ModeInfiltration)

	if board.Len() != 1 {
		t.Fatalf("expected one seek for one client, got %d", board.Len())
	}
	if board.Get(first.ID) != nil {
		t.Fatal("the replaced seek is still addressable")
	}
	if board.ForClient(client) != second {
		t.Fatal("the client is not behind their newest seek")
	}
}

func TestSeekCountsAreGroupedByModeAndExcludePrivateOnes(t *testing.T) {
	board, _ := testBoard(func(*Seek, *Seek) {})
	standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "a"}}, game.ModeTotalWar)
	standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "b"}}, game.ModeTotalWar)
	standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "c"}}, game.ModeInfiltration)
	private := standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "d"}}, game.ModeTotalWar)
	private.TargetUsername = "Bob"

	counts := board.CountsByMode()
	if counts[game.ModeTotalWar] != 2 || counts[game.ModeInfiltration] != 1 {
		t.Fatalf("unexpected waiting counts: %#v", counts)
	}
	if counts[game.ModeID("V7")] != 0 {
		t.Fatalf("a mode nobody is waiting in must report zero, got %#v", counts)
	}
}

// Only one caller can claim a seek, which is what makes an open game safe to
// publish to everybody at once.
func TestOnlyOneClaimSucceeds(t *testing.T) {
	board, _ := testBoard(func(*Seek, *Seek) {})
	seek := standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "poster"}}, game.ModeTotalWar)

	if board.Claim(seek.ID) == nil {
		t.Fatal("the first claim must win the seek")
	}
	if board.Claim(seek.ID) != nil {
		t.Fatal("a second claim must find nothing")
	}
}

func TestClaimFromRefusesAnotherClientsSeek(t *testing.T) {
	board, _ := testBoard(func(*Seek, *Seek) {})
	owner := &Client{profile: game.PlayerProfile{UserID: "owner"}}
	seek := standardSeek(board, owner, game.ModeTotalWar)
	stranger := &Client{profile: game.PlayerProfile{UserID: "stranger"}}

	if board.ClaimFrom(stranger, seek.ID) != nil {
		t.Fatal("a stranger cancelled somebody else's seek")
	}
	if board.ClaimFrom(owner, seek.ID) == nil {
		t.Fatal("the author could not cancel their own seek")
	}
}

// A plain search waits indefinitely; a posted game does not.
func TestOnlySeeksWithADeadlineExpire(t *testing.T) {
	board, setNow := testBoard(func(*Seek, *Seek) {})
	searching := standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "searching"}}, game.ModeTotalWar)
	searching.Queued = true
	posted := standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "posted"}}, game.ModeTotalWar)
	posted.ExpiresAt = posted.JoinedAt.Add(challengeLifetime)

	setNow(posted.ExpiresAt.Add(time.Second))
	expired := board.TakeExpired(board.now())
	if len(expired) != 1 || expired[0] != posted {
		t.Fatalf("expected only the posted game to expire, got %#v", expired)
	}
	if board.Get(searching.ID) == nil {
		t.Fatal("a plain search must not be swept off the board")
	}
	if len(board.Open(board.now())) != 1 {
		t.Fatal("the surviving search should still be on the public board")
	}
}

// An expired seek is off the board for every purpose, including pairing, before
// the sweep gets to it.
func TestExpiredSeeksDoNotPair(t *testing.T) {
	pairs := 0
	board, setNow := testBoard(func(*Seek, *Seek) { pairs++ })
	first := standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "first"}}, game.ModeTotalWar)
	first.ExpiresAt = first.JoinedAt.Add(time.Minute)
	standardSeek(board, &Client{profile: game.PlayerProfile{UserID: "second"}}, game.ModeTotalWar)

	setNow(first.ExpiresAt.Add(time.Second))
	board.pair()
	if pairs != 0 {
		t.Fatal("an expired seek must not be seated")
	}
}

func TestSearchRangeWidensUntilItIsFullyOpen(t *testing.T) {
	joinedAt := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	seek := &Seek{JoinedAt: joinedAt}
	if got := seek.SearchRange(joinedAt); got != matchmakingInitialEloRange {
		t.Fatalf("expected initial range %d, got %d", matchmakingInitialEloRange, got)
	}
	midpoint := joinedAt.Add(matchmakingFullyOpenAfter / 2)
	if got := seek.SearchRange(midpoint); got != 2575 {
		t.Fatalf("expected quadratic midpoint range 2575, got %d", got)
	}
	fullyOpen := joinedAt.Add(matchmakingFullyOpenAfter)
	if got := seek.SearchRange(fullyOpen); got != matchmakingMaximumEloRange ||
		!seek.searchIsFullyOpen(fullyOpen) {
		t.Fatalf("expected a fully open search, got range=%d", got)
	}
}

func TestPairingWaitsBeforeSeatingDistantRatings(t *testing.T) {
	pairs := 0
	board, setNow := testBoard(func(*Seek, *Seek) { pairs++ })
	baseTime := board.now()
	standardSeek(board, ratedClient("first", 1200), game.ModeTotalWar)
	standardSeek(board, ratedClient("second", 1800), game.ModeTotalWar)

	board.pair()
	if pairs != 0 {
		t.Fatal("distant ratings must not match inside the initial search range")
	}
	setNow(baseTime.Add(matchmakingFullyOpenAfter / 2))
	board.pair()
	if pairs != 1 {
		t.Fatal("the widening range should eventually admit a distant opponent")
	}
}

func TestFullyOpenSearchIsNotConfinedByElo(t *testing.T) {
	pairs := 0
	board, setNow := testBoard(func(*Seek, *Seek) { pairs++ })
	baseTime := board.now()
	standardSeek(board, ratedClient("first", 1200), game.ModeTotalWar)
	standardSeek(board, ratedClient("second", 25000), game.ModeTotalWar)
	setNow(baseTime.Add(matchmakingFullyOpenAfter + time.Minute))

	board.pair()
	if pairs != 1 {
		t.Fatal("after two minutes, waiting time must take precedence over Elo")
	}
}

func TestPairingChoosesClosestEligibleRating(t *testing.T) {
	var opponent *Client
	board, setNow := testBoard(func(first, second *Seek) { opponent = second.Client() })
	baseTime := board.now()
	standardSeek(board, ratedClient("first", 1200), game.ModeTotalWar)
	standardSeek(board, ratedClient("farther", 1280), game.ModeTotalWar)
	closer := ratedClient("closer", 1210)
	standardSeek(board, closer, game.ModeTotalWar)
	setNow(baseTime.Add(time.Second))

	board.pair()
	if opponent != closer {
		t.Fatal("the oldest seek should be paired with the closest eligible rating")
	}
}

func ratedClient(userID string, elo int) *Client {
	return &Client{
		profile: game.PlayerProfile{UserID: userID},
		account: persistence.Account{UserID: userID, Elo: elo},
	}
}

func TestSeeksWaitAtTheRatingOfTheChosenMode(t *testing.T) {
	client := ratedClient("mode-rated", 1200)
	client.account.ModeRatings = map[game.ModeID]persistence.ModeRating{
		game.ModeTotalWar: {ModeID: game.ModeTotalWar, Elo: 1500},
	}
	board, _ := testBoard(func(*Seek, *Seek) {})

	if seek := standardSeek(board, client, game.ModeTotalWar); seek.Elo != 1500 {
		t.Fatalf("expected the Total War rating, got %d", seek.Elo)
	}
	if seek := standardSeek(board, client, game.ModeInfiltration); seek.Elo != 1200 {
		t.Fatalf("an unplayed mode should wait at the shared seed, got %d", seek.Elo)
	}
}
