package notation

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
)

var (
	tagPattern        = regexp.MustCompile(`^\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\]$`)
	annotationPattern = regexp.MustCompile(`\[%([a-z]+)([^\]]*)\]`)
	numberPattern     = regexp.MustCompile(`^(\d+)\.(\.\.)?$`)
)

// Parse reads a single game. The returned record replays into the position the
// PGN says it ended in; pass it to game.Verify to prove it.
func Parse(text string) (ParsedGame, error) {
	games, err := ParseMulti(text)
	if err != nil {
		return ParsedGame{}, err
	}
	if len(games) != 1 {
		return ParsedGame{}, fmt.Errorf("%w: expected one game, found %d", ErrInvalidPGN, len(games))
	}
	return games[0], nil
}

// ParseMulti reads an archive of games concatenated into one file, which is
// how bulk exports are written.
func ParseMulti(text string) ([]ParsedGame, error) {
	blocks := splitGames(text)
	games := make([]ParsedGame, 0, len(blocks))
	for _, block := range blocks {
		parsed, err := parseGame(block)
		if err != nil {
			return nil, err
		}
		games = append(games, parsed)
	}
	return games, nil
}

// splitGames cuts an archive on the tag pair that opens a game. A tag line
// that follows movetext begins the next game.
func splitGames(text string) []string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	blocks := make([]string, 0, 4)
	current := make([]string, 0, 64)
	sawMovetext := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		isTag := strings.HasPrefix(trimmed, "[") && tagPattern.MatchString(trimmed)
		if isTag && sawMovetext {
			blocks = append(blocks, strings.Join(current, "\n"))
			current = current[:0]
			sawMovetext = false
		}
		if !isTag && trimmed != "" {
			sawMovetext = true
		}
		current = append(current, line)
	}
	if strings.TrimSpace(strings.Join(current, "\n")) != "" {
		blocks = append(blocks, strings.Join(current, "\n"))
	}
	return blocks
}

func parseGame(text string) (ParsedGame, error) {
	tags, movetext, err := splitSections(text)
	if err != nil {
		return ParsedGame{}, err
	}
	lookup := make(map[string]string, len(tags))
	for _, tag := range tags {
		lookup[tag.Name] = tag.Value
	}

	// The FEN settles who opened before a single move is read, because that is
	// what "1." names in the current dialect. A file with no FEN is a standard
	// game; a file written in the first dialect numbered by colour instead.
	opener := openingSideFromFEN(lookup["FEN"])
	numbered := opener
	if dialectOf(lookup["Generator"]) <= dialectByColor {
		numbered = game.Red
	}
	events, result, err := parseMovetext(movetext, opener, numbered)
	if err != nil {
		return ParsedGame{}, err
	}
	if declared := lookup["Result"]; declared != "" && result == ResultUnfinished {
		result = declared
	}
	record, err := buildRecord(lookup, events, result)
	if err != nil {
		return ParsedGame{}, err
	}
	return ParsedGame{
		Tags:     tags,
		Record:   record,
		Metadata: buildMetadata(lookup),
		Result:   result,
	}, nil
}

func splitSections(text string) ([]Tag, string, error) {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	tags := make([]Tag, 0, 24)
	movetext := make([]string, 0, len(lines))
	inTags := true
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if inTags {
			if trimmed == "" {
				continue
			}
			if match := tagPattern.FindStringSubmatch(trimmed); match != nil {
				tags = append(tags, Tag{Name: match[1], Value: unescapeTagValue(match[2])})
				continue
			}
			inTags = false
		}
		movetext = append(movetext, line)
	}
	if len(tags) == 0 {
		return nil, "", fmt.Errorf("%w: no tag pairs", ErrInvalidPGN)
	}
	return tags, strings.Join(movetext, "\n"), nil
}

func unescapeTagValue(value string) string {
	return strings.NewReplacer(`\"`, `"`, `\\`, `\`).Replace(value)
}

// tokenizeMovetext splits movetext into brace comments and plain tokens.
func tokenizeMovetext(movetext string) ([]string, error) {
	tokens := make([]string, 0, 64)
	for index := 0; index < len(movetext); {
		character := movetext[index]
		switch {
		case character == ' ' || character == '\n' || character == '\t' || character == '\r':
			index++
		case character == '{':
			end := strings.IndexByte(movetext[index:], '}')
			if end < 0 {
				return nil, fmt.Errorf("%w: unterminated comment", ErrInvalidPGN)
			}
			tokens = append(tokens, movetext[index:index+end+1])
			index += end + 1
		case character == ';':
			end := strings.IndexByte(movetext[index:], '\n')
			if end < 0 {
				index = len(movetext)
			} else {
				index += end + 1
			}
		default:
			end := strings.IndexAny(movetext[index:], " \n\t\r")
			if end < 0 {
				end = len(movetext) - index
			}
			tokens = append(tokens, movetext[index:index+end])
			index += end
		}
	}
	return tokens, nil
}

type movetextReader struct {
	events  []game.Event
	pending *game.Event
	result  string
	// opener is the side that had the move on the board this game began from,
	// taken from the file's own FEN. It seeds the alternation, so the first
	// move of a file that numbers nothing still gets the right colour.
	opener game.PlayerColor
	// numbered is the side a bare "12." names, which is the opener in the
	// current dialect and was always Red in the first one. See dialectOf.
	numbered    game.PlayerColor
	forcedColor game.PlayerColor
	lastMover   game.PlayerColor
}

func parseMovetext(
	movetext string,
	opener game.PlayerColor,
	numbered game.PlayerColor,
) ([]game.Event, string, error) {
	tokens, err := tokenizeMovetext(movetext)
	if err != nil {
		return nil, "", err
	}
	reader := &movetextReader{
		events:      make([]game.Event, 0, len(tokens)/2),
		result:      ResultUnfinished,
		opener:      opener,
		numbered:    numbered,
		forcedColor: game.Neutral,
		lastMover:   game.Neutral,
	}
	for _, token := range tokens {
		if err := reader.consume(token); err != nil {
			return nil, "", err
		}
	}
	reader.flush()
	return numberPlies(reader.events), reader.result, nil
}

func (reader *movetextReader) flush() {
	if reader.pending == nil {
		return
	}
	reader.events = append(reader.events, *reader.pending)
	reader.pending = nil
}

func (reader *movetextReader) consume(token string) error {
	switch {
	case strings.HasPrefix(token, "{"):
		return reader.consumeComment(token)
	case token == ResultRedWin || token == ResultBlueWin ||
		token == ResultDraw || token == ResultUnfinished:
		reader.flush()
		reader.result = token
		return nil
	case numberPattern.MatchString(token):
		// "12." announces one side and "12..." the other, the way a chess PGN
		// announces White and Black, which keeps colors explicit even for a
		// mode that does not strictly alternate.
		if strings.HasSuffix(token, "...") {
			reader.forcedColor = game.OtherColor(reader.numbered)
		} else {
			reader.forcedColor = reader.numbered
		}
		return nil
	default:
		return reader.consumeMove(token)
	}
}

func (reader *movetextReader) consumeMove(token string) error {
	event, err := ParseMove(token)
	if err != nil {
		return err
	}
	reader.flush()
	event.Player = reader.nextColor()
	reader.lastMover = event.Player
	reader.forcedColor = game.Neutral
	reader.pending = &event
	return nil
}

func (reader *movetextReader) nextColor() game.PlayerColor {
	if reader.forcedColor != game.Neutral {
		return reader.forcedColor
	}
	if reader.lastMover == game.Neutral {
		return reader.opener
	}
	return game.OtherColor(reader.lastMover)
}

func (reader *movetextReader) consumeComment(token string) error {
	annotations := annotationPattern.FindAllStringSubmatch(token, -1)
	var event *game.Event
	for _, annotation := range annotations {
		name := annotation[1]
		fields := strings.Fields(annotation[2])
		switch name {
		case "act":
			parsed, err := parseActAnnotation(fields)
			if err != nil {
				return err
			}
			reader.flush()
			event = parsed
		case "end":
			parsed, err := parseEndAnnotation(fields)
			if err != nil {
				return err
			}
			reader.flush()
			event = parsed
		}
	}
	if event == nil {
		// A bare clock comment belongs to the move it follows.
		if reader.pending == nil {
			return nil
		}
		event = reader.pending
	}
	for _, annotation := range annotations {
		fields := strings.Fields(annotation[2])
		switch annotation[1] {
		case "emt":
			if len(fields) != 1 {
				return fmt.Errorf("%w: bad %%emt annotation %q", ErrInvalidPGN, token)
			}
			elapsed, err := parseSecondsValue(fields[0])
			if err != nil {
				return err
			}
			event.ElapsedMs = elapsed
		case "clk":
			if len(fields) != 2 {
				return fmt.Errorf("%w: %%clk needs both clocks in %q", ErrInvalidPGN, token)
			}
			red, err := parseClock(fields[0])
			if err != nil {
				return err
			}
			blue, err := parseClock(fields[1])
			if err != nil {
				return err
			}
			event.RedRemainingMs = red
			event.BlueRemainingMs = blue
		}
	}
	if event != reader.pending {
		reader.events = append(reader.events, *event)
	}
	return nil
}

func parseActAnnotation(fields []string) (*game.Event, error) {
	if len(fields) < 2 {
		return nil, fmt.Errorf("%w: %%act needs a kind and a player", ErrInvalidPGN)
	}
	kind := game.EventKind(fields[0])
	switch kind {
	case game.EventDrawOffer, game.EventDrawDecline,
		game.EventTimeOffer, game.EventTimeDecline, game.EventTimeAccept:
	default:
		return nil, fmt.Errorf("%w: unknown action %q", ErrInvalidPGN, fields[0])
	}
	player, err := parsePlayerColor(fields[1])
	if err != nil {
		return nil, err
	}
	event := &game.Event{Kind: kind, Player: player}
	if len(fields) > 2 {
		bonus, err := strconv.ParseInt(fields[2], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("%w: bad time bonus %q", ErrInvalidPGN, fields[2])
		}
		event.BonusMs = bonus
	}
	return event, nil
}

func parseEndAnnotation(fields []string) (*game.Event, error) {
	if len(fields) < 2 {
		return nil, fmt.Errorf("%w: %%end needs a reason and a player", ErrInvalidPGN)
	}
	player, err := parsePlayerColor(fields[1])
	if err != nil {
		return nil, err
	}
	return &game.Event{
		Kind:      game.EventGameEnd,
		Player:    player,
		EndReason: game.GameEndReason(fields[0]),
	}, nil
}

func parsePlayerColor(text string) (game.PlayerColor, error) {
	switch game.PlayerColor(text) {
	case game.Red:
		return game.Red, nil
	case game.Blue:
		return game.Blue, nil
	case game.Neutral:
		return game.Neutral, nil
	default:
		return game.Neutral, fmt.Errorf("%w: unknown player %q", ErrInvalidPGN, text)
	}
}

func numberPlies(events []game.Event) []game.Event {
	ply := 0
	for index := range events {
		if events[index].Kind == game.EventMove {
			ply++
		}
		events[index].Ply = ply
	}
	return events
}

func buildRecord(tags map[string]string, events []game.Event, result string) (game.Record, error) {
	winner, err := winnerFromResult(result)
	if err != nil {
		return game.Record{}, err
	}
	control, err := ParseTimeControl(tags["TimeControl"])
	if err != nil {
		return game.Record{}, err
	}
	startingPosition, err := StartingPositionFrom(tags["FEN"])
	if err != nil {
		return game.Record{}, err
	}
	startingGrid, startingTurn, err := DecodePosition(tags["FEN"])
	if err != nil {
		return game.Record{}, err
	}
	// Older hand-written records sometimes omit the side-to-move field. They
	// historically replayed with Red first, so keep that compatibility while
	// preserving an explicit Blue turn when the FEN supplies one.
	if startingTurn == game.Neutral {
		startingTurn = game.FirstToMove
	}
	grid, turn, err := DecodePosition(tags["FinalFEN"])
	if err != nil {
		return game.Record{}, err
	}

	mode := game.ModeDefinition{
		ID:               game.ModeID(tags["ModeId"]),
		ShortCode:        tags["ModeId"],
		Name:             tags["Variant"],
		StartingPosition: startingPosition,
	}
	red := game.PlayerProfile{UserID: tags["RedId"], Username: tags["Red"]}
	blue := game.PlayerProfile{UserID: tags["BlueId"], Username: tags["Blue"]}

	status := game.InProgress
	activeColor := turn
	for _, event := range events {
		if event.Kind == game.EventGameEnd {
			status = game.Finished
			activeColor = game.Neutral
		}
	}
	if status == game.InProgress && result != ResultUnfinished {
		status = game.Finished
		activeColor = game.Neutral
	}

	redRemaining, blueRemaining := control.InitialTimeMs, control.InitialTimeMs
	if len(events) > 0 {
		last := events[len(events)-1]
		redRemaining, blueRemaining = last.RedRemainingMs, last.BlueRemainingMs
	}
	for index := range events {
		if events[index].Kind == game.EventGameEnd {
			events[index].Winner = winner
		}
	}

	final := game.GameState{
		GameID:      tags["GameId"],
		Grid:        grid,
		Mode:        mode,
		TimeControl: control,
		Clock: game.ClockState{
			RedRemainingMs:  redRemaining,
			BlueRemainingMs: blueRemaining,
			ActiveColor:     activeColor,
			UpdatedAtUnixMs: parseInt64(tags["EndTimeUnixMs"]),
		},
		CurrentTurn: turn,
		Status:      status,
		Winner:      winner,
		EndReason:   game.GameEndReason(tags["EndReason"]),
		MoveNumber:  moveNumberFrom(tags, events),
		RedPlayer:   red,
		BluePlayer:  blue,
	}
	return game.Record{
		GameID:          tags["GameId"],
		Mode:            mode,
		TimeControl:     control,
		RedPlayer:       red,
		BluePlayer:      blue,
		StartedAtUnixMs: parseInt64(tags["StartTimeUnixMs"]),
		InitialPosition: &game.InitialPosition{Grid: startingGrid, CurrentTurn: startingTurn},
		Events:          events,
		Final:           final,
	}, nil
}

func moveNumberFrom(tags map[string]string, events []game.Event) int {
	if value, found := tags["MoveNumber"]; found {
		if parsed, err := strconv.Atoi(value); err == nil {
			return parsed
		}
	}
	moves := 0
	for _, event := range events {
		if event.Kind == game.EventMove {
			moves++
		}
	}
	return moves
}

func buildMetadata(tags map[string]string) Metadata {
	ranked, _ := strconv.ParseBool(tags["Ranked"])
	return Metadata{
		Event:         tags["Event"],
		Site:          tags["Site"],
		Round:         tags["Round"],
		Ranked:        ranked,
		TournamentID:  tags["TournamentId"],
		RedEloBefore:  parseInt(tags["RedElo"]),
		RedEloAfter:   parseInt(tags["RedEloAfter"]),
		BlueEloBefore: parseInt(tags["BlueElo"]),
		BlueEloAfter:  parseInt(tags["BlueEloAfter"]),
		RatingScale:   tags["RatingSystem"],
		FinishedAt:    timeFromUnixMs(parseInt64(tags["EndTimeUnixMs"])),
	}
}

func timeFromUnixMs(milliseconds int64) time.Time {
	if milliseconds == 0 {
		return time.Time{}
	}
	return time.UnixMilli(milliseconds).UTC()
}

func parseInt(text string) int {
	value, _ := strconv.Atoi(strings.TrimSpace(text))
	return value
}

func parseInt64(text string) int64 {
	value, _ := strconv.ParseInt(strings.TrimSpace(text), 10, 64)
	return value
}

// openingSideFromFEN reads the side to move out of a starting position, falling
// back to the standard opener when there is no FEN to read or it cannot be
// parsed. A malformed FEN is not diagnosed here: buildRecord decodes the same
// field properly and reports it.
func openingSideFromFEN(text string) game.PlayerColor {
	if strings.TrimSpace(text) == "" {
		return game.FirstToMove
	}
	_, turn, err := DecodePosition(text)
	if err != nil || turn == game.Neutral {
		return game.FirstToMove
	}
	return turn
}
