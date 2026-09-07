package persistence

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// How a tournament decides who plays whom.
//
// The original answer was "everybody plays everybody, in signup order", which
// is the right default and is still the default. The three formats beside it
// exist because a round robin does not scale: sixteen players is 120 games, and
// an event that cannot finish in an evening does not finish at all.
//
// The formats split into two kinds, and the split is the thing to understand
// before changing anything here:
//
//   - **Fixed** formats know the whole schedule the moment the field closes. A
//     round robin's 120 pairings are all created by StartTournament and none of
//     them depend on a result.
//   - **Progressive** formats do not. An elimination bracket's semi-final
//     depends on who won the quarters, and a Swiss round three depends on the
//     standings after round two. These create one round at a time, and the next
//     round is built by AdvanceTournament when the current one finishes.
//
// The consequence is that "is this tournament over" is a different question for
// each kind. For a fixed format it is "are there any pending matches", which is
// what the code has always asked. For a progressive one it is "are there any
// pending matches *and* is there no further round to build", which is why
// SetTournamentMatchResult now asks the format rather than counting rows.

// TournamentFormat is the pairing rule.
type TournamentFormat string

const (
	// FormatRoundRobin is every pairing once. The default, and the only format
	// that existed before this file.
	FormatRoundRobin TournamentFormat = "round_robin"
	// FormatDoubleRoundRobin is every pairing twice, with the seats swapped the
	// second time so nobody opens both games.
	FormatDoubleRoundRobin TournamentFormat = "double_round_robin"
	// FormatSingleElimination is a knockout bracket.
	FormatSingleElimination TournamentFormat = "single_elimination"
	// FormatSwiss is fixed-length pairing by score.
	FormatSwiss TournamentFormat = "swiss"
)

// TournamentFormats is every format, in the order the builder offers them:
// simplest and most common first.
var TournamentFormats = []TournamentFormat{
	FormatRoundRobin,
	FormatDoubleRoundRobin,
	FormatSingleElimination,
	FormatSwiss,
}

// Valid reports whether this is a format the pairing code knows.
func (format TournamentFormat) Valid() bool {
	for _, known := range TournamentFormats {
		if format == known {
			return true
		}
	}
	return false
}

// Progressive reports whether this format builds its rounds one at a time. See
// the note at the top of this file for why it matters.
func (format TournamentFormat) Progressive() bool {
	return format == FormatSingleElimination || format == FormatSwiss
}

// Knockout reports whether losing ends your event, which is the one thing that
// makes elimination standings different: they rank by how far somebody got
// rather than by how many points they collected.
func (format TournamentFormat) Knockout() bool {
	return format == FormatSingleElimination
}

// Label is the format in the words the site uses for it.
func (format TournamentFormat) Label() string {
	switch format {
	case FormatRoundRobin:
		return "Round robin"
	case FormatDoubleRoundRobin:
		return "Double round robin"
	case FormatSingleElimination:
		return "Single elimination"
	case FormatSwiss:
		return "Swiss"
	}
	return string(format)
}

// TournamentField is who may enter.
type TournamentField string

const (
	// FieldOpen takes anybody, engines included. What every event before this
	// was, and still the default.
	FieldOpen TournamentField = "open"
	// FieldHumans bars engines. For an event whose point is the people in it.
	FieldHumans TournamentField = "humans"
	// FieldBots bars people.
	//
	// This is the one the bot-tournament work is about. It is a field rule
	// rather than a separate kind of tournament on purpose: a bot event should
	// be the same object as a human one — same builder, same bracket, same
	// standings, same spectating — differing only in who is allowed to sign up.
	// Anything else means two of everything.
	FieldBots TournamentField = "bots"
)

// TournamentFields is every field rule, in builder order.
var TournamentFields = []TournamentField{FieldOpen, FieldHumans, FieldBots}

// Valid reports whether this is a field rule the signup gate knows.
func (field TournamentField) Valid() bool {
	for _, known := range TournamentFields {
		if field == known {
			return true
		}
	}
	return false
}

// Admits reports whether an account of this kind may enter.
//
// `kind` is persistence.Account.Kind — "human" or "bot". An unrecognised kind
// is admitted by an open field and refused by both narrow ones, which is the
// safe way round: a new kind of account should not silently qualify for an
// event somebody described as bots only.
func (field TournamentField) Admits(kind string) bool {
	switch field {
	case FieldHumans:
		return kind == AccountKindHuman
	case FieldBots:
		return kind == AccountKindBot
	default:
		return true
	}
}

// Label is the field rule in the words the site uses for it.
func (field TournamentField) Label() string {
	switch field {
	case FieldOpen:
		return "Open to all"
	case FieldHumans:
		return "Humans only"
	case FieldBots:
		return "Bots only"
	}
	return string(field)
}

// TournamentSeeding decides the order the pairing engines read the field in.
type TournamentSeeding string

const (
	// SeedBySignup is the order people entered. Fair in the sense that nothing
	// about it is a judgement, and the original behaviour.
	SeedBySignup TournamentSeeding = "signup"
	// SeedByRating is strongest first, using each entrant's rating in the
	// event's own mode. What a bracket wants, so that the two favourites do not
	// meet in round one.
	SeedByRating TournamentSeeding = "rating"
)

// TournamentSeedings is every seeding rule, in builder order.
var TournamentSeedings = []TournamentSeeding{SeedBySignup, SeedByRating}

// Valid reports whether this is a seeding rule the pairing code knows.
func (seeding TournamentSeeding) Valid() bool {
	return seeding == SeedBySignup || seeding == SeedByRating
}

// Label is the seeding rule in the words the site uses for it.
func (seeding TournamentSeeding) Label() string {
	if seeding == SeedByRating {
		return "Seeded by rating"
	}
	return "Signup order"
}

// TournamentBye is a round somebody sat out.
//
// Its own table rather than a match row, for a reason that is worth writing
// down because the obvious alternative looks cheaper: `tournament_matches` has
// `CHECK (player1_id <> player2_id)` and both player columns are NOT NULL, so a
// bye cannot be a match against nobody or a match against yourself. Relaxing
// either constraint means rebuilding a table that two others hold foreign keys
// into, on a live database, to store a fact that has no board, no clock, no
// game id and no result. A bye is not a match. It gets its own table.
type TournamentBye struct {
	RoundNumber int              `json:"roundNumber"`
	PlayerID    int64            `json:"playerId"`
	Player      TournamentPlayer `json:"player"`
	// Reason is why they sat out, in the words the bracket shows: "odd field"
	// for a Swiss round with nobody left to pair them with, "bracket bye" for
	// the top seeds of a field that is not a power of two.
	Reason string `json:"reason,omitempty"`
}

const (
	byeBracket  = "bracket bye"
	byeOddField = "odd field"
)

// roundPairing is one round's worth of schedule: the games, and whoever sat out.
type roundPairing struct {
	pairs []([2]int64)
	byes  []int64
	// byeReason applies to every player in byes, since a round only ever has
	// byes for one reason.
	byeReason string
}

// fixedSchedule builds the whole schedule of a fixed-format tournament.
//
// `seeds` is the field in seeding order. The returned rounds are played in the
// order given, and every pair is `{player1, player2}` where player1 takes the
// seat that opens — see startTournamentMatch for how that becomes a colour.
func fixedSchedule(format TournamentFormat, seeds []int64) []roundPairing {
	switch format {
	case FormatDoubleRoundRobin:
		first := roundRobinPairs(seeds)
		rounds := make([]roundPairing, 0, len(first)*2)
		for _, pairs := range first {
			rounds = append(rounds, roundPairing{pairs: pairs})
		}
		// The return leg with the seats swapped. Playing the same pairing twice
		// from the same side would hand one player both openings, and in a game
		// where the first move matters that is half a point of head start
		// repeated across the whole event.
		for _, pairs := range first {
			reversed := make([][2]int64, 0, len(pairs))
			for _, pair := range pairs {
				reversed = append(reversed, [2]int64{pair[1], pair[0]})
			}
			rounds = append(rounds, roundPairing{pairs: reversed})
		}
		return rounds
	default:
		first := roundRobinPairs(seeds)
		rounds := make([]roundPairing, 0, len(first))
		for _, pairs := range first {
			rounds = append(rounds, roundPairing{pairs: pairs})
		}
		return rounds
	}
}

// eliminationFirstRound pairs the opening round of a bracket.
//
// A field that is not a power of two gives byes to its top seeds, which is the
// standard arrangement and the only one that makes seeding worth anything: with
// six entrants, seeds one and two sit out while 3–6 play, and the field is four
// for the semi-finals. The alternative — pairing everybody and letting the odd
// one out sit — would put the two favourites in round one, which is the thing
// seeding exists to prevent.
//
// Every later round therefore has a power-of-two field and no byes at all, and
// that is why eliminationNextRound below does not have to think about them.
func eliminationFirstRound(seeds []int64) roundPairing {
	count := len(seeds)
	if count < 2 {
		return roundPairing{}
	}
	slots := 1
	for slots < count {
		slots *= 2
	}
	byes := slots - count
	pairing := roundPairing{byeReason: byeBracket}
	pairing.byes = append(pairing.byes, seeds[:byes]...)
	// The players who do have to play, highest seed against lowest.
	playing := seeds[byes:]
	for index := 0; index < len(playing)/2; index++ {
		pairing.pairs = append(pairing.pairs, [2]int64{
			playing[index],
			playing[len(playing)-1-index],
		})
	}
	return pairing
}

// eliminationNextRound pairs the survivors of a completed round.
//
// The survivors arrive in seeding order and are paired highest against lowest,
// which re-seeds the bracket every round rather than holding fixed positions.
// That is a real choice between two legitimate conventions, and this is the one
// that suits an event whose later rounds are built as they are reached: it
// keeps the reward for seeding alive all the way to the final — the top seed
// always draws the weakest survivor — and it needs no stored bracket geometry
// to reconstruct, only who is left.
func eliminationNextRound(survivors []int64) roundPairing {
	pairing := roundPairing{}
	if len(survivors) < 2 {
		return pairing
	}
	// An odd number of survivors cannot happen when the first round has taken
	// the field to a power of two, but a tournament whose matches were edited
	// by hand can produce one. The top seed sits out rather than the round
	// failing to build.
	remaining := survivors
	if len(remaining)%2 == 1 {
		pairing.byes = []int64{remaining[0]}
		pairing.byeReason = byeOddField
		remaining = remaining[1:]
	}
	for index := 0; index < len(remaining)/2; index++ {
		pairing.pairs = append(pairing.pairs, [2]int64{
			remaining[index],
			remaining[len(remaining)-1-index],
		})
	}
	return pairing
}

// swissRoundCount is how many rounds a Swiss event of this size plays.
//
// `configured` is the host's answer, and zero means they did not give one. The
// default is ceil(log2(n)) — the number of rounds it takes for one player to be
// the only one who could still be undefeated, which is the point of a Swiss —
// with a floor of three, because a two-round event does not separate anybody.
// Either way it is capped at n-1: past that the field runs out of opponents
// nobody has played, and the pairing below starts producing rematches.
func swissRoundCount(fieldSize int, configured int) int {
	if fieldSize < 2 {
		return 0
	}
	rounds := configured
	if rounds <= 0 {
		rounds = int(math.Ceil(math.Log2(float64(fieldSize))))
		if rounds < 3 {
			rounds = 3
		}
	}
	if rounds > fieldSize-1 {
		rounds = fieldSize - 1
	}
	if rounds < 1 {
		rounds = 1
	}
	return rounds
}

// swissState is what pairing a Swiss round needs to know about the rounds
// already played.
type swissState struct {
	// points is each player's score so far, on the same 3/1/0 scale the
	// standings use, so that pairing and the table people are reading agree.
	points map[int64]int
	// met records who has already played whom, as the unordered pair key
	// pairKey builds. Swiss's one hard rule is no rematches.
	met map[[2]int64]bool
	// byesTaken is who has already sat one out, so a small odd field spreads
	// its byes around instead of handing them all to the same player.
	byesTaken map[int64]bool
	// openings is how many times each player has taken the seat that moves
	// first, which is what balances colours across the event.
	openings map[int64]int
}

// pairKey is the unordered key of a pairing, so that "A played B" and "B played
// A" are the same fact.
func pairKey(first int64, second int64) [2]int64 {
	if first > second {
		first, second = second, first
	}
	return [2]int64{first, second}
}

// swissRound pairs one round by score.
//
// Two things are going on, and they are worth separating because the second one
// is where the bugs live.
//
// **The order.** The field is sorted by score, then by seed. Within a score
// group, the preferred opponent is the one half a group away — the top of the
// group plays the middle, the second plays the one after that, and so on. That
// is the standard split-the-group pairing, and it is what stops the two
// favourites meeting in round one: with four players on nothing, it pairs 1v3
// and 2v4 rather than 1v2 and 3v4.
//
// **The rematch rule.** Swiss's one hard constraint is that nobody plays the
// same opponent twice, and satisfying it is not a greedy problem. Take five
// players where One has met Two and Three, and Two has met Five: pairing One
// with its best remaining option leaves Two and Five with only each other,
// whom they have already played — while One–Five, Two–Four would have worked.
// A pairing that takes the best option at each step and never reconsiders
// produces exactly that rematch, and it took a five-player test to find it.
//
// So this searches. It tries the preferred opponent first and backs up when the
// rest of the field cannot then be paired, which finds a rematch-free pairing
// whenever one exists and keeps the pairings as close to the score order as the
// constraint allows. The search is bounded — see pairingBudget — and falls back
// to allowing rematches if it runs out or if no legal pairing exists, because a
// round that cannot be paired at all is worse than a repeated fixture.
func swissRound(seeds []int64, state swissState) roundPairing {
	if len(seeds) < 2 {
		return roundPairing{}
	}
	seedOrder := make(map[int64]int, len(seeds))
	for index, playerID := range seeds {
		seedOrder[playerID] = index
	}
	ordered := append([]int64(nil), seeds...)
	sort.SliceStable(ordered, func(first, second int) bool {
		firstPoints, secondPoints := state.points[ordered[first]], state.points[ordered[second]]
		if firstPoints != secondPoints {
			return firstPoints > secondPoints
		}
		return seedOrder[ordered[first]] < seedOrder[ordered[second]]
	})

	pairing := roundPairing{}
	// An odd field byes its lowest-placed player who has not had one yet. Lowest
	// placed because a bye is worth a full point and the player who least needs
	// the gift is the one at the top; "not had one yet" because two byes in a
	// five-player event is most of somebody's tournament played against nobody.
	if len(ordered)%2 == 1 {
		byeIndex := -1
		for index := len(ordered) - 1; index >= 0; index-- {
			if !state.byesTaken[ordered[index]] {
				byeIndex = index
				break
			}
		}
		if byeIndex < 0 {
			byeIndex = len(ordered) - 1
		}
		pairing.byes = []int64{ordered[byeIndex]}
		pairing.byeReason = byeOddField
		ordered = append(ordered[:byeIndex:byeIndex], ordered[byeIndex+1:]...)
	}

	budget := pairingBudget
	pairs, ok := searchPairing(ordered, state, &budget)
	if !ok {
		// No rematch-free pairing, or the search gave up. Pair adjacently and
		// accept the repeats — see the note above.
		pairs = adjacentPairing(ordered)
	}
	for _, pair := range pairs {
		pairing.pairs = append(pairing.pairs, swissSeats(pair[0], pair[1], state, seedOrder))
	}
	return pairing
}

// pairingBudget caps the pairing search.
//
// The search is exponential in the worst case, and the worst case is a late
// round of a small field where almost every fixture has already been played.
// Ten thousand steps is far more than any event this server will host needs —
// a sixteen-player round eight resolves in a few hundred — and it is a hard
// guarantee that pairing a round cannot hang the lobby ticker.
const pairingBudget = 10_000

// searchPairing finds a rematch-free pairing of an even-sized field.
//
// `ordered` is the field in pairing order. Returns the pairs and whether it
// succeeded; a false means either no such pairing exists or the budget ran out,
// and the caller treats those the same way.
func searchPairing(
	ordered []int64,
	state swissState,
	budget *int,
) ([][2]int64, bool) {
	if len(ordered) == 0 {
		return nil, true
	}
	if *budget <= 0 {
		return nil, false
	}
	*budget--

	first := ordered[0]
	for _, index := range candidateOrder(ordered, state) {
		opponent := ordered[index]
		if state.met[pairKey(first, opponent)] {
			continue
		}
		remaining := make([]int64, 0, len(ordered)-2)
		for position, playerID := range ordered {
			if position == 0 || position == index {
				continue
			}
			remaining = append(remaining, playerID)
		}
		rest, ok := searchPairing(remaining, state, budget)
		if !ok {
			continue
		}
		return append([][2]int64{{first, opponent}}, rest...), true
	}
	return nil, false
}

// candidateOrder is which opponents to try for the field's top player, best
// first.
//
// The preferred one is half a score group away — see the note on swissRound —
// and the rest fan out from there, so backing off the ideal opponent moves to
// the next most similar rather than to the bottom of the field.
func candidateOrder(ordered []int64, state swissState) []int {
	if len(ordered) < 2 {
		return nil
	}
	// How much of the field shares the top player's score. Everybody below
	// that has floated down and is a worse pairing than anybody inside it.
	group := 1
	topPoints := state.points[ordered[0]]
	for group < len(ordered) && state.points[ordered[group]] == topPoints {
		group++
	}
	target := group / 2
	if target < 1 {
		target = 1
	}
	if target > len(ordered)-1 {
		target = len(ordered) - 1
	}
	candidates := make([]int, 0, len(ordered)-1)
	for index := 1; index < len(ordered); index++ {
		candidates = append(candidates, index)
	}
	sort.SliceStable(candidates, func(first, second int) bool {
		return abs(candidates[first]-target) < abs(candidates[second]-target)
	})
	return candidates
}

// adjacentPairing is the last resort: pair the field two at a time in order,
// rematches and all.
func adjacentPairing(ordered []int64) [][2]int64 {
	pairs := make([][2]int64, 0, len(ordered)/2)
	for index := 0; index+1 < len(ordered); index += 2 {
		pairs = append(pairs, [2]int64{ordered[index], ordered[index+1]})
	}
	return pairs
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

// swissSeats decides which of a pair takes the opening seat.
//
// Whoever has opened fewer games so far, and the higher seed when that is level.
// Colour balance matters more in this game than in most: the first move is a
// real advantage, and over five rounds an unbalanced draw is worth more than
// most of the pairing decisions above it.
func swissSeats(
	first int64,
	second int64,
	state swissState,
	seedOrder map[int64]int,
) [2]int64 {
	firstOpenings, secondOpenings := state.openings[first], state.openings[second]
	if firstOpenings != secondOpenings {
		if firstOpenings > secondOpenings {
			return [2]int64{second, first}
		}
		return [2]int64{first, second}
	}
	if seedOrder[first] <= seedOrder[second] {
		return [2]int64{first, second}
	}
	return [2]int64{second, first}
}

// plannedRounds is how many rounds this tournament will play in total.
//
// Published on the tournament so a bracket can say "round 2 of 3" while it is
// still being built a round at a time. For a fixed format it is exactly the
// length of the schedule; for a progressive one it is the count the format
// implies from the field size.
func plannedRounds(format TournamentFormat, fieldSize int, swissRounds int) int {
	if fieldSize < 2 {
		return 0
	}
	switch format {
	case FormatSingleElimination:
		return int(math.Ceil(math.Log2(float64(fieldSize))))
	case FormatSwiss:
		return swissRoundCount(fieldSize, swissRounds)
	default:
		return len(fixedSchedule(format, make([]int64, fieldSize)))
	}
}

// validateTournamentConfig checks a builder's answers before they are stored.
//
// One function rather than checks spread through the write paths, because
// create and update both take the same set of answers and a rule enforced in
// only one of them is a rule somebody can get around by saving twice.
func validateTournamentConfig(config TournamentConfig) error {
	if utf8Runes(config.Name) < 1 || utf8Runes(config.Name) > 80 {
		return fmt.Errorf("%w: name must be between 1 and 80 characters", ErrInvalidTournament)
	}
	if utf8Runes(config.Description) > 2000 {
		return fmt.Errorf(
			"%w: description must be at most 2000 characters", ErrInvalidTournament,
		)
	}
	if !config.Format.Valid() {
		return fmt.Errorf("%w: unknown format %q", ErrInvalidTournament, config.Format)
	}
	if !config.Field.Valid() {
		return fmt.Errorf("%w: unknown field rule %q", ErrInvalidTournament, config.Field)
	}
	if !config.Seeding.Valid() {
		return fmt.Errorf("%w: unknown seeding %q", ErrInvalidTournament, config.Seeding)
	}
	if config.MaxPlayers < 0 || config.MaxPlayers > 512 {
		return fmt.Errorf(
			"%w: player cap must be between 0 (uncapped) and 512", ErrInvalidTournament,
		)
	}
	if config.MaxPlayers > 0 && config.MaxPlayers < 2 {
		return fmt.Errorf("%w: a tournament needs room for two players", ErrInvalidTournament)
	}
	if config.SwissRounds < 0 || config.SwissRounds > 32 {
		return fmt.Errorf("%w: Swiss rounds must be between 0 (auto) and 32", ErrInvalidTournament)
	}
	// Zero means "the server's default time control", which is what every event
	// before this used and what leaving the fields blank should mean.
	if config.InitialTimeMs < 0 || config.IncrementMs < 0 {
		return fmt.Errorf("%w: time control cannot be negative", ErrInvalidTournament)
	}
	if config.InitialTimeMs > 0 && config.InitialTimeMs < 10_000 {
		return fmt.Errorf("%w: give each player at least ten seconds", ErrInvalidTournament)
	}
	if config.StartsAtUnixMs != nil && *config.StartsAtUnixMs < 0 {
		return fmt.Errorf("%w: start time must be a valid instant", ErrInvalidTournament)
	}
	return nil
}

// utf8Runes is the length check the validators above share.
func utf8Runes(text string) int {
	return len([]rune(strings.TrimSpace(text)))
}
