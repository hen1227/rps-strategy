package spec

// The two shipped modes, written in the rule language.
//
// Their piece ids are `Rock`, `Paper` and `Scissors` — the values `game.Piece`
// already carries — because **a kind's id is the string that appears on a
// tile**. One name per piece, and no table translating between what a rule says
// and what is standing on the square it is about.
//
// Held as the JSON somebody would actually publish rather than as Go literals,
// for three reasons: it is the same text as the worked example in
// `docs/rulespec.md`, it proves the decoder reads a real document rather than a
// convenient in-memory shape, and it is comparable — character for character —
// with the TypeScript copies in `frontend/src/engine/spec/builtin.ts`.
//
// They are the correctness proof for the whole format. `spec_mode_test.go` plays
// seeded random games through `Mode` reading these and through the hand-written
// `game.TotalWarMode` and `game.InfiltrationMode`, and asserts the two agree
// position for position. A format that could not express the games this project
// already ships would be a format that quietly failed on somebody's first
// invention instead.

import "encoding/json"

// TotalWarJSON is Total War: take the enemy off the board, or hold most of it
// when it fills.
//
// The order of the two win conditions is a rule, not a preference. A move that
// takes the last enemy piece *and* claims the last neutral square is an
// annihilation win, because annihilation is checked first — which is exactly what
// `mode_total_war.go` does by returning before it counts territory.
const TotalWarJSON = `{
  "spec": 1,
  "name": "Total War",
  "shortCode": "V5",
  "description": "Pieces and territory.",
  "objective": "Annihilate the enemy or control most territory when the board is filled.",
  "board": { "width": 9, "height": 9 },
  "pieces": [
    { "id": "Rock",     "name": "Rock",     "symbol": "R", "art": "rock" },
    { "id": "Paper",    "name": "Paper",    "symbol": "P", "art": "paper" },
    { "id": "Scissors", "name": "Scissors", "symbol": "S", "art": "scissors" }
  ],
  "beats": [["Rock", "Scissors"], ["Scissors", "Paper"], ["Paper", "Rock"]],
  "startingPosition": { "rows": [
    "...SSS...", "...PPP...", "...RRR...",
    ".........", ".........", ".........",
    "...rrr...", "...ppp...", "...sss..."
  ]},
  "movement": [{ "kind": "step", "dirs": "all8", "distance": 1 }],
  "capture": { "mode": "beats" },
  "effects": [{ "on": "move", "do": [{ "claimTerritory": "mover" }] }],
  "win": [
    { "id": "annihilation",
      "when": { "eq": [{ "count": { "owner": "opponent" } }, 0] },
      "result": "mover", "reason": "annihilation" },
    { "id": "territory",
      "when": { "eq": [{ "count": { "territory": "neutral" } }, 0] },
      "result": { "moreOf": { "red":  { "count": { "territory": "red" } },
                              "blue": { "count": { "territory": "blue" } } } },
      "reason": "territory" }
  ]
}`

// InfiltrationJSON is Infiltration: walk a piece onto the far rank.
//
// No annihilation rule, deliberately, and that absence is a rule of its own.
// Losing every piece leaves the player to move with no legal move, which the
// engine adjudicates as a stalemate draw rather than a loss; `game_test.go`
// asserts it. A spec that "helpfully" added an annihilation condition here would
// be a different game.
const InfiltrationJSON = `{
  "spec": 1,
  "name": "Infiltration",
  "shortCode": "V3",
  "description": "A race to the far rank.",
  "objective": "Move a piece onto the opponent's home rank.",
  "board": { "width": 9, "height": 9 },
  "pieces": [
    { "id": "Rock",     "name": "Rock",     "symbol": "R", "art": "rock" },
    { "id": "Paper",    "name": "Paper",    "symbol": "P", "art": "paper" },
    { "id": "Scissors", "name": "Scissors", "symbol": "S", "art": "scissors" }
  ],
  "beats": [["Rock", "Scissors"], ["Scissors", "Paper"], ["Paper", "Rock"]],
  "startingPosition": { "rows": [
    "...SSS...", "...PPP...", "...RRR...",
    ".........", ".........", ".........",
    "...rrr...", "...ppp...", "...sss..."
  ]},
  "movement": [{ "kind": "step", "dirs": "all8", "distance": 1 }],
  "capture": { "mode": "beats" },
  "win": [
    { "id": "infiltration",
      "when": { "in": ["to", { "home": "opponent" }] },
      "result": "mover", "reason": "infiltration" }
  ]
}`

// MustParse reads a spec that is expected to be correct, and panics otherwise.
// For the built-ins above and for tests: a typo in one of those should stop the
// server starting rather than produce a mode nobody can play.
func MustParse(document string) RuleSpec {
	parsed, report := ValidateJSON([]byte(document))
	if err := report.Err(); err != nil {
		panic(err)
	}
	return parsed
}

var (
	TotalWar     = MustParse(TotalWarJSON)
	Infiltration = MustParse(InfiltrationJSON)
)

// Builtin is the shipped specs by the mode id they correspond to, for the
// differential tests and for the Lab's "start from a mode I know" button.
var Builtin = map[string]RuleSpec{
	"V5": TotalWar,
	"V3": Infiltration,
}

// Encode writes a spec back out as the document it came from. Used by the
// library route and by the conformance corpus, where a case has to carry the
// exact spec it was recorded against.
func Encode(spec RuleSpec) ([]byte, error) { return json.Marshal(spec) }
