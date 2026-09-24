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
const Generator = "rps-strategy-pgn/2"

// RatingSystem names the scale the Elo tags are written on.
//
// "anchored/1" is the scale in persistence/rating_scale.go: 1 is an engine that
// plays a uniformly random legal move, and twenty points is a doubling of the
// odds of winning. A file with no such tag was written under the previous
// system, which was chess Elo centred on 1200, and the two sets of numbers
// cannot be compared or averaged together.
const RatingSystem = "anchored/1"

// The numbered dialects, which differ in one thing: what "12." means.
//
// dialectByColor numbered move pairs by colour, so "12." was always Red and
// "12..." always Blue. That was the same thing as numbering them by who opened
// right up until Blue became the side that opens, so dialectByOpener numbers
// them by the opener instead and "1." is the first move of the game in every
// file, the way it is in chess.
//
// Only a game that began with the non-opening side to move reads differently
// under the two -- a board somebody set up, or an opening seeded to an odd
// number of plies -- and that is exactly the archived game this has to keep
// replaying, which is why the dialect is read off the file rather than assumed.
const (
	dialectByColor  = 1
	dialectByOpener = 2
)

// The number in Generator is dialectByOpener; a mismatch would leave archived
// files claiming a dialect nothing reads.
var _ = [1]struct{}{}[dialectOf(Generator)-dialectByOpener]

// dialectOf reads the format number out of a Generator tag.
//
// A file with no tag, or one whose tag this cannot read, is taken to be the
// current dialect: every file this project has ever written carries the tag, so
// one without it was written by hand and means what a reader would mean today.
func dialectOf(generator string) int {
	_, version, found := strings.Cut(strings.TrimSpace(generator), "/")
	if !found {
		return dialectByOpener
	}
	dialect, err := strconv.Atoi(version)
	if err != nil {
		return dialectByOpener
	}
	return dialect
}

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
	// RatingScale is which scale the four numbers above are written on. Empty in
	// a file from before the scale was named, which means the 1200-centred one.
	// See the RatingSystem constant.
	RatingScale string

	// BookPlies counts opening moves that were dealt rather than chosen — the
	// seeded random opening a bot series starts each pair from. Review tooling
	// reads it and skips those plies: grading a move nobody picked as a
	// blunder would slander both engines.
	BookPlies int
	// OpeningSeed and SeriesID identify the run a game belongs to, so a
	// surprising result can be reproduced rather than argued about.
	OpeningSeed string
	SeriesID    string

	// RedEngine and BlueEngine are the builds the engines in each seat declared
	// they were, and are empty for a human seat and for an engine that declares
	// none — which is every engine written before the field existed.
	//
	// Their own tags rather than part of Generator, for the reason RatingSystem
	// is its own tag: they are independent things that change independently,
	// and an engine shipping a new build has not changed how the moves are
	// numbered. This is what makes "which build played this game" answerable
	// from the archive at all — the alternative is reading the bot's current
	// build, which is whatever it happens to be running today rather than what
	// played.
	RedEngine  string
	BlueEngine string

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

// formatBoardSize writes the shape of the board a game was played on: one
// number for a square board, "WxH" otherwise.
//
// Nothing parses this tag — the FEN beside it already describes the shape, which
// is what a replay reads — so it exists to be read by a person. Keeping the bare
// side for a square board is what makes every nine-by-nine record ever archived
// still spell it "9".
func formatBoardSize(grid game.Grid) string {
	width, height := grid.Width(), grid.Height()
	if width == height {
		return strconv.Itoa(width)
	}
	return strconv.Itoa(width) + "x" + strconv.Itoa(height)
}

func buildTags(record game.Record, metadata Metadata) []Tag {
	final := record.Final
	startingFEN := EncodeStartingPosition(record.StartingPosition())
	if record.InitialPosition != nil {
		startingFEN = EncodePosition(
			record.InitialPosition.Grid,
			record.InitialPosition.CurrentTurn,
		)
	}
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
		{"BoardSize", formatBoardSize(record.Final.Grid)},
		{"TimeControl", FormatTimeControl(record.TimeControl)},
		{"SetUp", "1"},
		{"FEN", startingFEN},
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
	// The scale RedElo and BlueElo are written on, because the tag names are
	// standard PGN and the numbers under them are not comparable across the
	// change.
	//
	// This is not paranoia about a hypothetical reader. The archive is published
	// and the two scales overlap: 200 is a plausible rating under both, a weak
	// one on the old 1200-centred scale and a strong one on this. Nothing in the
	// file would look wrong. A reader that averaged across the boundary would get
	// an answer, and it would be meaningless.
	//
	// Named separately from Generator, which is about how the moves are
	// numbered. Two independent things that can change independently, and folding
	// them into one version number would mean a rating change silently claiming
	// the moves had moved too.
	if metadata.RedEloBefore > 0 || metadata.BlueEloBefore > 0 {
		tags = append(tags, Tag{"RatingSystem", RatingSystem})
	}
	tags = append(tags, Tag{"Ranked", strconv.FormatBool(metadata.Ranked)})
	tags = appendIfSet(tags, "TournamentId", metadata.TournamentID)
	if metadata.BookPlies > 0 {
		tags = append(tags, Tag{"BookPlies", strconv.Itoa(metadata.BookPlies)})
	}
	tags = appendIfSet(tags, "OpeningSeed", metadata.OpeningSeed)
	tags = appendIfSet(tags, "SeriesId", metadata.SeriesID)
	// Omitted rather than written empty, so a human game's record is byte for
	// byte what it was before these existed and every archived game still
	// parses.
	tags = appendIfSet(tags, "RedEngine", metadata.RedEngine)
	tags = appendIfSet(tags, "BlueEngine", metadata.BlueEngine)
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
	// A move pair is the opener's move and the reply, so the opener takes the
	// "12." and the other side the "12..." that closes the pair. Keyed off who
	// actually opened rather than off a colour: the side that moves first is a
	// rule, and an archived game replays under the rule it was played with.
	opener := record.StartingTurn()
	moveNumber := 1
	for index, event := range record.Events {
		switch event.Kind {
		case game.EventMove:
			if event.Player == opener {
				tokens = append(tokens, strconv.Itoa(moveNumber)+".")
			} else {
				tokens = append(tokens, strconv.Itoa(moveNumber)+"...")
				moveNumber++
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
		game.EndReasonInfiltration, game.EndReasonCorner, game.EndReasonRepetition,
		game.EndReasonStalemate, game.EndReasonNoCapture, game.EndReasonMoveLimit:
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

// RenameParticipant blanks one player's name and id inside a stored record,
// replacing both with the same value.
//
// Anonymizing an account clears the name from the database rows, but a PGN
// carries its own copy in the tag pairs, and PRIVACY.md promises "the bare
// result with your name removed". This is what makes that true of the archive
// itself rather than only of the columns beside it.
//
// Only the tag block is touched. The movetext is returned byte-identical, so a
// renamed record still replays to the same game and still passes game.Verify —
// which is the property that makes the archive worth keeping at all.
func RenameParticipant(pgn string, userID string, replacement string) string {
	// Anonymizing wants the id gone as thoroughly as the name, so both tags
	// take the same value.
	return ReseatParticipant(pgn, userID, replacement, replacement)
}

// ReseatParticipant rewrites one player's id and name independently.
//
// Merging a guest account into a real one needs the two to differ: the seat
// must end up carrying the surviving account's id *and* that account's name,
// where anonymizing only ever needed one value in both places.
//
// Only the tag block is touched. The movetext is returned byte-identical, so a
// reseated record still replays to the same game and still passes game.Verify —
// which is the property that makes the archive worth keeping at all.
func ReseatParticipant(pgn string, userID string, newUserID string, newName string) string {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return pgn
	}
	lines := strings.Split(pgn, "\n")
	// Which seat the account held. Read first, because the name tag comes
	// before the id tag and has to be rewritten once the seat is known.
	seats := map[string]bool{}
	for _, line := range lines {
		for _, seat := range []string{"Red", "Blue"} {
			if strings.HasPrefix(line, "["+seat+"Id \"") &&
				tagValue(line) == userID {
				seats[seat] = true
			}
		}
	}
	if len(seats) == 0 {
		return pgn
	}
	for index, line := range lines {
		// The tag block ends at the first blank line; everything after it is
		// movetext and must not be touched.
		if strings.TrimSpace(line) == "" {
			break
		}
		for seat := range seats {
			if strings.HasPrefix(line, "["+seat+" \"") {
				lines[index] = fmt.Sprintf("[%s %q]", seat, newName)
			}
			if strings.HasPrefix(line, "["+seat+"Id \"") {
				lines[index] = fmt.Sprintf("[%sId %q]", seat, newUserID)
			}
		}
	}
	return strings.Join(lines, "\n")
}

// tagValue reads the quoted value out of a `[Name "value"]` line.
func tagValue(line string) string {
	open := strings.Index(line, `"`)
	close := strings.LastIndex(line, `"`)
	if open < 0 || close <= open {
		return ""
	}
	return strings.ReplaceAll(line[open+1:close], `\"`, `"`)
}
