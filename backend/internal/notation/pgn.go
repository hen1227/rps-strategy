package notation

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
)

// Generator identifies the dialect a stored game was written with, so a later
// format change can be detected in an archive rather than guessed at.
const Generator = "rps-strategy-pgn/1"

const (
	ResultRedWin     = "1-0"
	ResultBlueWin    = "0-1"
	ResultDraw       = "1/2-1/2"
	ResultUnfinished = "*"
)

const wrapColumn = 80

var ErrInvalidPGN = errors.New("invalid PGN")

// Metadata is everything worth archiving that the game engine does not know:
// what the game was for, and what it did to the players' ratings.
type Metadata struct {
	Event        string
	Site         string
	Round        string
	Ranked       bool
	TournamentID string

	RedEloBefore  int
	RedEloAfter   int
	BlueEloBefore int
	BlueEloAfter  int

	FinishedAt time.Time
}

type Tag struct {
	Name  string
	Value string
}

// ParsedGame is one game read back out of a PGN archive.
type ParsedGame struct {
	Tags     []Tag
	Record   game.Record
	Metadata Metadata
	Result   string
}

func (parsed ParsedGame) Tag(name string) string {
	for _, tag := range parsed.Tags {
		if tag.Name == name {
			return tag.Value
		}
	}
	return ""
}

// Encode writes a complete game as PGN. The tag pairs describe the game, the
// movetext replays it, and together they are self-sufficient: nothing in the
// database is needed to reconstruct the game from this text.
func Encode(record game.Record, metadata Metadata) string {
	tags := buildTags(record, metadata)
	builder := strings.Builder{}
	for _, tag := range tags {
		fmt.Fprintf(&builder, "[%s %q]\n", tag.Name, tag.Value)
	}
	builder.WriteString("\n")
	builder.WriteString(wrapTokens(movetextTokens(record)))
	builder.WriteString("\n")
	return builder.String()
}

func buildTags(record game.Record, metadata Metadata) []Tag {
	final := record.Final
	startedAt := time.UnixMilli(record.StartedAtUnixMs).UTC()
	finishedAt := metadata.FinishedAt.UTC()
	if metadata.FinishedAt.IsZero() {
		finishedAt = startedAt
	}
	eventName := metadata.Event
	if eventName == "" {
		eventName = "Casual"
	}
	site := metadata.Site
	if site == "" {
		site = "RPS Strategy"
	}
	round := metadata.Round
	if round == "" {
		round = "-"
	}

	tags := []Tag{
		{"Event", eventName},
		{"Site", site},
		{"Date", startedAt.Format("2006.01.02")},
		{"Round", round},
		{"Red", displayName(record.RedPlayer)},
		{"Blue", displayName(record.BluePlayer)},
		{"Result", Result(final)},
		{"GameId", record.GameID},
		{"Variant", record.Mode.Name},
		{"ModeId", string(record.Mode.ID)},
		{"BoardSize", strconv.Itoa(game.BoardSize)},
		{"TimeControl", FormatTimeControl(record.TimeControl)},
		{"SetUp", "1"},
		{"FEN", EncodeStartingPosition(record.StartingPosition())},
	}
	tags = appendIfSet(tags, "RedId", record.RedPlayer.UserID)
	tags = appendIfSet(tags, "BlueId", record.BluePlayer.UserID)
	if metadata.RedEloBefore > 0 {
		tags = append(tags, Tag{"RedElo", strconv.Itoa(metadata.RedEloBefore)})
	}
	if metadata.BlueEloBefore > 0 {
		tags = append(tags, Tag{"BlueElo", strconv.Itoa(metadata.BlueEloBefore)})
	}
	if metadata.RedEloAfter > 0 {
		tags = append(tags, Tag{"RedEloAfter", strconv.Itoa(metadata.RedEloAfter)})
		tags = append(tags, Tag{"RedRatingDiff", signed(metadata.RedEloAfter - metadata.RedEloBefore)})
	}
	if metadata.BlueEloAfter > 0 {
		tags = append(tags, Tag{"BlueEloAfter", strconv.Itoa(metadata.BlueEloAfter)})
		tags = append(tags, Tag{"BlueRatingDiff", signed(metadata.BlueEloAfter - metadata.BlueEloBefore)})
	}
	tags = append(tags, Tag{"Ranked", strconv.FormatBool(metadata.Ranked)})
	tags = appendIfSet(tags, "TournamentId", metadata.TournamentID)
	tags = append(tags,
		Tag{"Termination", Termination(final)},
		Tag{"EndReason", string(final.EndReason)},
		Tag{"PlyCount", strconv.Itoa(record.PlyCount())},
		// The engine's own move counter is written alongside the ply count so
		// a mode that counts moves its own way still round-trips.
		Tag{"MoveNumber", strconv.Itoa(final.MoveNumber)},
		Tag{"UTCDate", startedAt.Format("2006.01.02")},
		Tag{"UTCTime", startedAt.Format("15:04:05")},
		Tag{"StartTimeUnixMs", strconv.FormatInt(record.StartedAtUnixMs, 10)},
		Tag{"EndTimeUnixMs", strconv.FormatInt(finishedAt.UnixMilli(), 10)},
		Tag{"FinalFEN", EncodePosition(final.Grid, final.CurrentTurn)},
		Tag{"Generator", Generator},
	)
	return tags
}

func appendIfSet(tags []Tag, name, value string) []Tag {
	if strings.TrimSpace(value) == "" {
		return tags
	}
	return append(tags, Tag{name, value})
}

func displayName(profile game.PlayerProfile) string {
	if name := strings.TrimSpace(profile.Username); name != "" {
		return name
	}
	if id := strings.TrimSpace(profile.UserID); id != "" {
		return id
	}
	return "?"
}

func signed(value int) string {
	if value > 0 {
		return "+" + strconv.Itoa(value)
	}
	return strconv.Itoa(value)
}

// Result is the PGN result token for a game state.
func Result(state game.GameState) string {
	if state.Status != game.Finished {
		return ResultUnfinished
	}
	switch state.Winner {
	case game.Red:
		return ResultRedWin
	case game.Blue:
		return ResultBlueWin
	default:
		return ResultDraw
	}
}

func winnerFromResult(result string) (game.PlayerColor, error) {
	switch result {
	case ResultRedWin:
		return game.Red, nil
	case ResultBlueWin:
		return game.Blue, nil
	case ResultDraw, ResultUnfinished:
		return game.Neutral, nil
	default:
		return game.Neutral, fmt.Errorf("%w: unknown result %q", ErrInvalidPGN, result)
	}
}

// Termination is a human sentence for the tag of the same name.
func Termination(state game.GameState) string {
	if state.Status != game.Finished {
		return "unterminated"
	}
	reason := strings.ReplaceAll(string(state.EndReason), "_", " ")
	if state.Winner == game.Neutral {
		return "draw by " + reason
	}
	return string(state.Winner) + " wins by " + reason
}

// FormatTimeControl writes "initial+increment" in seconds, keeping millisecond
// precision when a control needs it.
func FormatTimeControl(control game.TimeControl) string {
	return formatSecondsValue(control.InitialTimeMs) + "+" + formatSecondsValue(control.IncrementMs)
}

func ParseTimeControl(text string) (game.TimeControl, error) {
	initial, increment, found := strings.Cut(strings.TrimSpace(text), "+")
	if !found {
		return game.TimeControl{}, fmt.Errorf("%w: bad time control %q", ErrInvalidPGN, text)
	}
	initialMs, err := parseSecondsValue(initial)
	if err != nil {
		return game.TimeControl{}, err
	}
	incrementMs, err := parseSecondsValue(increment)
	if err != nil {
		return game.TimeControl{}, err
	}
	return game.TimeControl{InitialTimeMs: initialMs, IncrementMs: incrementMs}, nil
}

// formatSecondsValue writes milliseconds as seconds without trailing zeros:
// 300000 becomes "300" and 1500 becomes "1.5".
func formatSecondsValue(milliseconds int64) string {
	whole := milliseconds / 1000
	fraction := milliseconds % 1000
	if fraction == 0 {
		return strconv.FormatInt(whole, 10)
	}
	return strings.TrimRight(fmt.Sprintf("%d.%03d", whole, fraction), "0")
}

// parseSecondsValue is exact where a float would not be: the archive stores
// clocks in milliseconds and must read back the same integers.
func parseSecondsValue(text string) (int64, error) {
	text = strings.TrimSpace(text)
	whole, fraction, _ := strings.Cut(text, ".")
	seconds, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: bad seconds value %q", ErrInvalidPGN, text)
	}
	milliseconds := seconds * 1000
	if fraction == "" {
		return milliseconds, nil
	}
	for len(fraction) < 3 {
		fraction += "0"
	}
	if len(fraction) > 3 {
		fraction = fraction[:3]
	}
	part, err := strconv.ParseInt(fraction, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: bad seconds value %q", ErrInvalidPGN, text)
	}
	return milliseconds + part, nil
}

func formatClock(milliseconds int64) string {
	if milliseconds < 0 {
		milliseconds = 0
	}
	hours := milliseconds / 3600000
	minutes := (milliseconds % 3600000) / 60000
	seconds := (milliseconds % 60000) / 1000
	fraction := milliseconds % 1000
	return fmt.Sprintf("%d:%02d:%02d.%03d", hours, minutes, seconds, fraction)
}

func parseClock(text string) (int64, error) {
	parts := strings.Split(strings.TrimSpace(text), ":")
	if len(parts) != 3 {
		return 0, fmt.Errorf("%w: bad clock %q", ErrInvalidPGN, text)
	}
	hours, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: bad clock %q", ErrInvalidPGN, text)
	}
	minutes, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: bad clock %q", ErrInvalidPGN, text)
	}
	seconds, err := parseSecondsValue(parts[2])
	if err != nil {
		return 0, err
	}
	return hours*3600000 + minutes*60000 + seconds, nil
}

// FormatMove writes one move: the piece, the square it left, "-" or "x", and
// the square it entered. A capture normally leaves the victim unwritten
// because the rules fix it; a mode that lets a piece take something other than
// what it beats gets the victim spelled out instead.
func FormatMove(event game.Event, endsGame bool) string {
	token := strings.Builder{}
	token.WriteString(pieceLetter(event.Piece))
	token.WriteString(FormatSquare(event.From))
	if event.Captured == game.Empty {
		token.WriteString("-")
	} else {
		token.WriteString("x")
		if event.Captured != Defeats(event.Piece) {
			token.WriteString(pieceLetter(event.Captured))
		}
	}
	token.WriteString(FormatSquare(event.To))
	if endsGame {
		token.WriteString("#")
	}
	return token.String()
}

var movePattern = regexp.MustCompile(`^([RPS])([a-i][1-9])([-x])([RPS]?)([a-i][1-9])(#?)$`)

func ParseMove(token string) (game.Event, error) {
	match := movePattern.FindStringSubmatch(token)
	if match == nil {
		return game.Event{}, fmt.Errorf("%w: %q is not a move", ErrInvalidPGN, token)
	}
	piece, _ := pieceFromLetter(match[1])
	from, err := ParseSquare(match[2])
	if err != nil {
		return game.Event{}, err
	}
	to, err := ParseSquare(match[5])
	if err != nil {
		return game.Event{}, err
	}
	captured := game.Empty
	if match[3] == "x" {
		captured = Defeats(piece)
		if match[4] != "" {
			captured, _ = pieceFromLetter(match[4])
		}
	}
	return game.Event{
		Kind:     game.EventMove,
		Piece:    piece,
		From:     from,
		To:       to,
		Captured: captured,
	}, nil
}

func movetextTokens(record game.Record) []string {
	tokens := make([]string, 0, len(record.Events)*3+8)
	moveNumber := 1
	for index, event := range record.Events {
		switch event.Kind {
		case game.EventMove:
			if event.Player == game.Blue {
				tokens = append(tokens, strconv.Itoa(moveNumber)+"...")
				moveNumber++
			} else {
				tokens = append(tokens, strconv.Itoa(moveNumber)+".")
			}
			endsGame := index+1 < len(record.Events) &&
				record.Events[index+1].Kind == game.EventGameEnd &&
				adjudicatedByAMove(record.Events[index+1].EndReason)
			tokens = append(tokens, FormatMove(event, endsGame), clockComment(event, ""))
		case game.EventGameEnd:
			tokens = append(tokens, clockComment(event, fmt.Sprintf(
				"[%%end %s %s] ", event.EndReason, event.Player,
			)))
		default:
			annotation := fmt.Sprintf("[%%act %s %s] ", event.Kind, event.Player)
			if event.BonusMs != 0 {
				annotation = fmt.Sprintf(
					"[%%act %s %s %d] ", event.Kind, event.Player, event.BonusMs,
				)
			}
			tokens = append(tokens, clockComment(event, annotation))
		}
	}
	return append(tokens, Result(record.Final))
}

// adjudicatedByAMove reports whether an ending was caused by the move that
// preceded it, which is what "#" marks. Resigning, agreeing a draw, walking
// away, and running out of time are not.
func adjudicatedByAMove(reason game.GameEndReason) bool {
	switch reason {
	case game.EndReasonGameRule, game.EndReasonAnnihilation, game.EndReasonTerritory,
		game.EndReasonInfiltration, game.EndReasonRepetition, game.EndReasonStalemate:
		return true
	default:
		return false
	}
}

// clockComment carries the two numbers replay needs: how long the side to move
// spent, and what both clocks read afterwards.
func clockComment(event game.Event, prefix string) string {
	return fmt.Sprintf(
		"{%s[%%emt %s] [%%clk %s %s]}",
		prefix,
		formatSecondsValue(event.ElapsedMs),
		formatClock(event.RedRemainingMs),
		formatClock(event.BlueRemainingMs),
	)
}

func wrapTokens(tokens []string) string {
	lines := make([]string, 0, len(tokens)/6+1)
	line := strings.Builder{}
	for _, token := range tokens {
		if line.Len() > 0 && line.Len()+1+len(token) > wrapColumn {
			lines = append(lines, line.String())
			line.Reset()
		}
		if line.Len() > 0 {
			line.WriteString(" ")
		}
		line.WriteString(token)
	}
	if line.Len() > 0 {
		lines = append(lines, line.String())
	}
	return strings.Join(lines, "\n")
}
