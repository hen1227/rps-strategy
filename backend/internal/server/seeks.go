package server

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

const (
	matchmakingTick            = 2 * time.Second
	matchmakingInitialEloRange = 100
	matchmakingMaximumEloRange = 10000
	matchmakingFullyOpenAfter  = 2 * time.Minute
	// awaySeekLifetime is how long a search survives with nobody behind it.
	//
	// Long enough that queueing at breakfast and playing at lunch works, which
	// is the whole point in a game with a handful of players. Short enough that
	// a search forgotten yesterday does not ring somebody's phone tonight for a
	// game they no longer want — and does not make the person who clicked it
	// spend thirty seconds discovering that.
	awaySeekLifetime = 2 * time.Hour
)

// Presence is what we know about whether a person is actually behind a seek.
//
// It exists because a seek now outlives the tab that made it, which splits one
// old question into two. "Is this player connected" used to be the same as "can
// this player start a game right now"; with a queue you can walk away from,
// somebody can be firmly in the queue and equally firmly asleep. Only Here
// starts a game on the spot. Idle and Away are both fetched first, and differ
// only in how: an idle player is sent a bell in the tab they left open, an away
// player is sent a notification.
type Presence string

const (
	// PresenceHere is a visible tab that somebody has touched recently.
	PresenceHere Presence = "here"
	// PresenceIdle is a live socket with nobody watching it.
	PresenceIdle Presence = "idle"
	// PresenceAway is no socket at all.
	PresenceAway Presence = "away"
)

// Seek is one person waiting for a game, and the only thing in the server that
// means that. Joining matchmaking, posting a game to the lobby, and challenging
// one person by name all create one of these; they differ in the Setup it
// carries and who it is addressed to, and in nothing else.
//
// That is the point. A "normal game" is a seek holding the mode's StandardSetup,
// and a challenge is a seek holding an edited one, so the pairing rule, the
// public board, the expiry sweep, and the one-at-a-time limit are each written
// once instead of twice.
type Seek struct {
	ID string
	// Owner is the identity this seek belongs to, which outlives any one
	// socket. Keying the board by it rather than by a connection is the whole
	// of what makes the queue survive a closed tab.
	Owner  string
	Poster game.PlayerProfile
	// TargetUsername addresses the seek to one person, which makes it private:
	// only they see it and only they can take it. Empty offers it to the room.
	TargetUsername string
	Setup          game.GameSetup
	ModeName       string
	Elo            int
	JoinedAt       time.Time
	// ExpiresAt is the zero time for a seek that waits indefinitely, which is
	// what a plain matchmaking search does. A posted game expires so the board
	// does not fill with offers nobody is still sitting behind.
	ExpiresAt time.Time
	// Queued marks a seek whose author is searching rather than advertising:
	// they pressed play, or they wrote out a game that turned out to be the
	// standard one. It decides how they are told about it and whether it
	// expires — never what it can pair with.
	Queued bool

	// Everything above is written once, when the seek is made, and read without
	// synchronization for the rest of its life. Everything below changes while
	// the seek waits — a tab closes, another opens, somebody stops watching —
	// and is reached only through the accessors under this lock.
	//
	// The lock is not paranoia. pair() deliberately releases the board's mutex
	// before calling onPair, so a pairing goroutine reads a seek's socket at the
	// same moment a disconnecting one may be clearing it.
	mu       sync.Mutex
	client   *Client
	presence Presence
}

// IsOpen reports whether this seek is offered to the room rather than to one
// person.
func (seek *Seek) IsOpen() bool { return seek.TargetUsername == "" }

// Client is the socket currently behind this seek, or nil when its author has
// gone. A seek with no socket is still a real seek: it pairs, it sits on the
// board, and its author is summoned when it does.
func (seek *Seek) Client() *Client {
	seek.mu.Lock()
	defer seek.mu.Unlock()
	return seek.client
}

// CurrentPresence is Away whenever there is no socket, whatever the author's
// client last claimed. A presence report is a statement about a tab that is
// open, so a connection that has gone overrules it.
//
// An unset presence reads as Here. That is load-bearing rather than merely
// convenient: it means a socket that has never mentioned itself is treated as
// somebody sitting at the screen, so every path that existed before presence
// did — and every test that builds a seek without thinking about it — pairs and
// seats exactly as it always has.
func (seek *Seek) CurrentPresence() Presence {
	seek.mu.Lock()
	defer seek.mu.Unlock()
	if seek.client == nil {
		return PresenceAway
	}
	if seek.presence == "" {
		return PresenceHere
	}
	return seek.presence
}

// Present reports whether this seek can be seated at a game right now, as
// opposed to having to be fetched first.
func (seek *Seek) Present() bool { return seek.CurrentPresence() == PresenceHere }

// bind hands the seek to a socket: the first post, a reconnection, a second
// tab. A freshly bound socket is present, because a socket that has said
// nothing about itself is one somebody just opened.
func (seek *Seek) bind(client *Client) {
	seek.mu.Lock()
	defer seek.mu.Unlock()
	seek.client = client
	seek.presence = PresenceHere
}

// detach is what a closing socket does. Losing the connection forces the seek
// away whatever its author's client last claimed — the one half of presence the
// server knows better than the browser does. It reports whether that socket was
// in fact the one behind the seek, so a stale tab closing cannot unseat a live
// one.
func (seek *Seek) detach(client *Client) bool {
	seek.mu.Lock()
	defer seek.mu.Unlock()
	if seek.client != client {
		return false
	}
	seek.client = nil
	seek.presence = PresenceAway
	return true
}

// setPresence records what a client says about itself. A report is only heeded
// from the socket currently bound, so a background tab cannot mark somebody
// away while they are busy in another one.
func (seek *Seek) setPresence(client *Client, presence Presence) bool {
	seek.mu.Lock()
	defer seek.mu.Unlock()
	if seek.client != client || seek.presence == presence {
		return false
	}
	seek.presence = presence
	return true
}

// seekOwnerKey is the identity a seek belongs to.
//
// An account id when there is one. Otherwise the connection itself, which keeps
// the id-less clients tests build distinct from one another — the same
// distinction distinctPeople already draws when counting who is online. An
// anonymous client cannot be called back anyway, so tying its seek to its
// socket costs nothing it could have used.
func seekOwnerKey(client *Client) string {
	if client == nil {
		return ""
	}
	if userID := strings.TrimSpace(client.profile.UserID); userID != "" {
		return userID
	}
	return fmt.Sprintf("conn:%p", client)
}

func (seek *Seek) expired(now time.Time) bool {
	return !seek.ExpiresAt.IsZero() && !now.Before(seek.ExpiresAt)
}

// Challenge is the wire form. Named for what a player sees rather than for what
// the server calls it: "somebody has left a game open" is a challenge whether
// they reached it through matchmaking or through the setup screen.
func (seek *Seek) Challenge() Challenge {
	challenge := Challenge{
		ID:              seek.ID,
		Challenger:      seek.Poster,
		TargetUsername:  seek.TargetUsername,
		ModeName:        seek.ModeName,
		Setup:           seek.Setup,
		Queued:          seek.Queued,
		Present:         seek.Present(),
		CreatedAtUnixMs: seek.JoinedAt.UnixMilli(),
	}
	if !seek.ExpiresAt.IsZero() {
		challenge.ExpiresAtUnixMs = seek.ExpiresAt.UnixMilli()
	}
	return challenge
}

// SearchRange is how far from their own rating this seek will currently accept
// an opponent.
func (seek *Seek) SearchRange(now time.Time) int {
	elapsed := now.Sub(seek.JoinedAt)
	if elapsed <= 0 {
		return matchmakingInitialEloRange
	}
	if elapsed >= matchmakingFullyOpenAfter {
		return matchmakingMaximumEloRange
	}

	// Expand slowly near the start, when a close opponent is most valuable,
	// then accelerate as waiting time becomes the more important signal.
	elapsedMilliseconds := elapsed.Milliseconds()
	fullSearchMilliseconds := matchmakingFullyOpenAfter.Milliseconds()
	additionalRange := int64(matchmakingMaximumEloRange-matchmakingInitialEloRange) *
		elapsedMilliseconds * elapsedMilliseconds /
		(fullSearchMilliseconds * fullSearchMilliseconds)
	return matchmakingInitialEloRange + int(additionalRange)
}

func (seek *Seek) searchIsFullyOpen(now time.Time) bool {
	return now.Sub(seek.JoinedAt) >= matchmakingFullyOpenAfter
}

// QueueEntry is one seat in a game about to start: who is sitting in it, the
// setup they agreed to, and the rating they brought. Every path that seats
// somebody builds two of these — matchmaking, an accepted challenge, a
// tournament round, a bot game — so startConfiguredMatch has one shape of
// argument whatever arranged the game.
type QueueEntry struct {
	// Client is the socket that will play this seat, and may be nil. A game is
	// now opened the moment two seeks fit, and a seek outlives its tab, so one
	// side of a brand-new game can quite properly have nobody connected to it
	// yet: they are being notified, and they will rejoin into the seat.
	Client *Client
	// Profile is who sits here. Read off the client when left blank, which is
	// every caller that has one; a seat with no socket must state it, because
	// the game needs two names before either player has arrived.
	Profile  game.PlayerProfile
	Setup    game.GameSetup
	Elo      int
	JoinedAt time.Time
}

// profile is the player this seat belongs to, whether or not they are here.
func (entry QueueEntry) profile() game.PlayerProfile {
	if entry.Profile.UserID != "" || entry.Profile.Username != "" {
		return entry.Profile
	}
	if entry.Client != nil {
		return entry.Client.profile
	}
	return game.PlayerProfile{}
}

// entry is the seat this seek becomes when its game starts.
//
// The client is passed in rather than read off the seek because by the time a
// game begins, the socket taking the seat need not be the one that posted it: a
// summoned player very often arrives in a tab that a notification opened.
func (seek *Seek) entry(client *Client) QueueEntry {
	return QueueEntry{
		Client:   client,
		Profile:  seek.Poster,
		Setup:    seek.Setup,
		Elo:      seek.Elo,
		JoinedAt: seek.JoinedAt,
	}
}

// seekBoard holds every unstarted seek: one map, so a person cannot be waiting
// in two places and the lobby cannot show the same person twice.
//
// Keyed by owner rather than by connection, which is the whole of what makes a
// queue survive a closed tab. It also settles a question the old key answered
// by accident: two tabs of one account are one person waiting once, and every
// tab shows the same wait.
type seekBoard struct {
	mu      sync.Mutex
	byID    map[string]*Seek
	byOwner map[string]*Seek
	onPair  func(first, second *Seek)
	now     func() time.Time
	// paused stops pairing without emptying the board. Set while the server is
	// draining for an update: the seeks stay exactly where they are, keeping the
	// wait they have already served, and start pairing again by themselves if
	// the drain is called off. Nil means never paused, which is every test and
	// every server that is not mid-deploy.
	paused func() bool
}

func newSeekBoard(onPair func(first, second *Seek)) *seekBoard {
	return &seekBoard{
		byID:    make(map[string]*Seek),
		byOwner: make(map[string]*Seek),
		onPair:  onPair,
		now:     time.Now,
	}
}

// Post puts a seek on the board, replacing whatever that person was already
// waiting behind. One per person is structural rather than checked, so no
// caller can leave a stale seek pointing at somebody already in a game.
//
// A seek that arrives without an owner takes one from its socket, so every
// caller that only knows how to hand over a client — including the one a
// requeue comes back through — still ends up on the right key.
func (board *seekBoard) Post(seek *Seek) {
	if seek.Owner == "" {
		seek.Owner = seekOwnerKey(seek.Client())
	}
	board.mu.Lock()
	defer board.mu.Unlock()
	if existing := board.byOwner[seek.Owner]; existing != nil {
		delete(board.byID, existing.ID)
	}
	board.byID[seek.ID] = seek
	board.byOwner[seek.Owner] = seek
}

// Len is how many seeks are on the board, of every kind.
func (board *seekBoard) Len() int {
	board.mu.Lock()
	defer board.mu.Unlock()
	return len(board.byID)
}

// All is every seek on the board, for callers that have to visit each wait
// rather than each connection.
func (board *seekBoard) All() []*Seek {
	board.mu.Lock()
	defer board.mu.Unlock()
	seeks := make([]*Seek, 0, len(board.byID))
	for _, seek := range board.byID {
		seeks = append(seeks, seek)
	}
	return seeks
}

func (board *seekBoard) Get(id string) *Seek {
	board.mu.Lock()
	defer board.mu.Unlock()
	return board.byID[id]
}

// ForClient is the seek this connection's owner is waiting behind, which is not
// necessarily one this connection posted: a second tab, or a reconnection,
// finds the same wait.
func (board *seekBoard) ForClient(client *Client) *Seek {
	return board.ForOwner(seekOwnerKey(client))
}

func (board *seekBoard) ForOwner(owner string) *Seek {
	if owner == "" {
		return nil
	}
	board.mu.Lock()
	defer board.mu.Unlock()
	return board.byOwner[owner]
}

// Bind hands a live seek back to a socket and returns it, which is how a
// reconnecting player and a second tab both find what they are already waiting
// behind.
func (board *seekBoard) Bind(client *Client) *Seek {
	seek := board.ForClient(client)
	if seek == nil {
		return nil
	}
	seek.bind(client)
	return seek
}

// Detach clears the socket behind whatever this client was waiting behind and
// returns the seek, leaving it on the board. Whether it may stay there is the
// caller's decision, not the board's.
func (board *seekBoard) Detach(client *Client) *Seek {
	seek := board.ForClient(client)
	if seek == nil || !seek.detach(client) {
		return nil
	}
	return seek
}

// SetPresence records what a client says about itself, returning the seek it
// spoke for when the report changed anything.
func (board *seekBoard) SetPresence(client *Client, presence Presence) *Seek {
	seek := board.ForClient(client)
	if seek == nil || !seek.setPresence(client, presence) {
		return nil
	}
	return seek
}

// Claim removes a seek and hands it to exactly one caller. Removing it *is* the
// claim: two people can both pass every check before this, and only the one
// that gets a non-nil seek back gets the game.
func (board *seekBoard) Claim(id string) *Seek {
	board.mu.Lock()
	defer board.mu.Unlock()
	return board.removeLocked(id)
}

// ClaimFrom is Claim for the seek's own author, used to cancel it. The id and
// the client must agree, so one client cannot cancel another's seek by id.
func (board *seekBoard) ClaimFrom(client *Client, id string) *Seek {
	board.mu.Lock()
	defer board.mu.Unlock()
	if seek := board.byID[id]; seek == nil || seek.Owner != seekOwnerKey(client) {
		return nil
	}
	return board.removeLocked(id)
}

func (board *seekBoard) RemoveClient(client *Client) *Seek {
	return board.RemoveOwner(seekOwnerKey(client))
}

func (board *seekBoard) RemoveOwner(owner string) *Seek {
	if owner == "" {
		return nil
	}
	board.mu.Lock()
	defer board.mu.Unlock()
	seek := board.byOwner[owner]
	if seek == nil {
		return nil
	}
	return board.removeLocked(seek.ID)
}

func (board *seekBoard) removeLocked(id string) *Seek {
	seek := board.byID[id]
	if seek == nil {
		return nil
	}
	delete(board.byID, id)
	if board.byOwner[seek.Owner] == seek {
		delete(board.byOwner, seek.Owner)
	}
	return seek
}

// Open is the public board: every live seek offered to the room, oldest first,
// so a list that grows does so at the bottom.
func (board *seekBoard) Open(now time.Time) []Challenge {
	return board.snapshot(now, func(seek *Seek) bool { return seek.IsOpen() })
}

// AddressedTo is one person's invitation inbox.
func (board *seekBoard) AddressedTo(username string, now time.Time) []Challenge {
	return board.snapshot(now, func(seek *Seek) bool {
		return !seek.IsOpen() && sameUsername(seek.TargetUsername, username)
	})
}

func (board *seekBoard) snapshot(now time.Time, keep func(*Seek) bool) []Challenge {
	board.mu.Lock()
	challenges := make([]Challenge, 0, len(board.byID))
	for _, seek := range board.byID {
		if !seek.expired(now) && keep(seek) {
			challenges = append(challenges, seek.Challenge())
		}
	}
	board.mu.Unlock()
	sort.Slice(challenges, func(first, second int) bool {
		return challenges[first].CreatedAtUnixMs < challenges[second].CreatedAtUnixMs
	})
	return challenges
}

// TakeExpired removes and returns the seeks that have run out, leaving the
// caller to tell the people behind them.
func (board *seekBoard) TakeExpired(now time.Time) []*Seek {
	board.mu.Lock()
	defer board.mu.Unlock()
	expired := make([]*Seek, 0)
	for id, seek := range board.byID {
		if seek.expired(now) {
			expired = append(expired, board.removeLocked(id))
		}
	}
	return expired
}

// TakeFrom removes every seek a client is behind, which is at most one. It
// returns a slice because its callers announce whatever they get, and a
// disconnecting client should not need to know how many that can be.
func (board *seekBoard) TakeFrom(client *Client) []*Seek {
	if seek := board.RemoveOwner(seekOwnerKey(client)); seek != nil {
		return []*Seek{seek}
	}
	return nil
}

// CountsByMode counts the people waiting for a game in each mode. Private
// challenges are left out: nobody can join one, so counting it would advertise
// an opponent who is not available.
func (board *seekBoard) CountsByMode() map[game.ModeID]int {
	board.mu.Lock()
	defer board.mu.Unlock()
	counts := make(map[game.ModeID]int)
	for _, seek := range board.byID {
		if seek.IsOpen() {
			counts[seek.Setup.ModeID]++
		}
	}
	return counts
}

// PresentCountsByMode is the subset of CountsByMode who are at the board right
// now.
//
// Two numbers rather than one, because a queue of five people four of whom have
// closed the tab is honestly both "five waiting" and "one you could be playing
// in ten seconds", and a lobby showing either figure alone lies about the other.
// It is also the figure a nudge should key off: telling somebody in a bot game
// that a human is waiting, when that human is asleep, is how a helpful prompt
// becomes a wasted click.
func (board *seekBoard) PresentCountsByMode() map[game.ModeID]int {
	board.mu.Lock()
	seeks := make([]*Seek, 0, len(board.byID))
	for _, seek := range board.byID {
		if seek.IsOpen() {
			seeks = append(seeks, seek)
		}
	}
	board.mu.Unlock()

	// Presence is read outside the board's lock on purpose: it lives behind each
	// seek's own mutex, and taking one lock inside the other is how this file
	// would acquire a deadlock it does not currently have.
	counts := make(map[game.ModeID]int)
	for _, seek := range seeks {
		if seek.Present() {
			counts[seek.Setup.ModeID]++
		}
	}
	return counts
}

func (board *seekBoard) Run(ctx context.Context) {
	ticker := time.NewTicker(matchmakingTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			board.pair()
		}
	}
}

// pair seats everybody whose seeks describe the same game.
//
// Only open seeks: a private challenge names the one person who may take it, so
// it waits for them however long that takes. Everything else on the board is
// fair game for everything else on the board, which is why an open game posted
// with nothing customized is picked up by matchmaking exactly as if its author
// had pressed play.
func (board *seekBoard) pair() {
	// Checked before the lock rather than inside it. Nothing here needs the
	// board to answer, and a drain that has to queue behind a pairing round is
	// a drain that can still seat a game after it began.
	if board.paused != nil && board.paused() {
		return
	}
	board.mu.Lock()
	now := board.now()
	seeks := make([]*Seek, 0, len(board.byID))
	for _, seek := range board.byID {
		if seek.IsOpen() && !seek.expired(now) {
			seeks = append(seeks, seek)
		}
	}
	sort.Slice(seeks, func(i, j int) bool { return seeks[i].JoinedAt.Before(seeks[j].JoinedAt) })

	// Keyed by owner rather than by connection, and that is load-bearing: an
	// away seek has no connection at all, so a map keyed by *Client would file
	// every absent player under nil and let only one pair form per round.
	paired := make(map[string]bool)
	pairs := make([][2]*Seek, 0)
	for i, first := range seeks {
		if paired[first.Owner] {
			continue
		}
		bestIndex := -1
		bestDifference := 0
		for candidateIndex, second := range seeks[i+1:] {
			// Poster is a captured copy of the profile, so this reads the same
			// answer for an away seek as for a present one. The board's owner
			// key already makes two tabs of one account a single seek; this
			// keeps the rule stated where pairing can see it.
			if paired[second.Owner] || !first.Setup.Fits(second.Setup) ||
				(first.Poster.UserID != "" &&
					first.Poster.UserID == second.Poster.UserID) {
				continue
			}
			difference := absoluteDifference(first.Elo, second.Elo)
			allowedDifference := max(first.SearchRange(now), second.SearchRange(now))
			if !first.searchIsFullyOpen(now) && !second.searchIsFullyOpen(now) &&
				difference > allowedDifference {
				continue
			}
			if bestIndex == -1 || difference < bestDifference {
				bestIndex = i + 1 + candidateIndex
				bestDifference = difference
			}
		}
		if bestIndex != -1 {
			second := seeks[bestIndex]
			paired[first.Owner] = true
			paired[second.Owner] = true
			pairs = append(pairs, [2]*Seek{first, second})
		}
	}
	for _, pair := range pairs {
		board.removeLocked(pair[0].ID)
		board.removeLocked(pair[1].ID)
	}
	board.mu.Unlock()

	for _, pair := range pairs {
		board.onPair(pair[0], pair[1])
	}
}

// seatOrder decides who plays game.FirstToMove, which is the seat that opens.
//
// A seat preference is honoured when there is one; pairing already refused two
// seeks that want the same colour, so at most one of these can be asking. With
// neither asking the older seek gets the opening seat, the same deterministic
// rule matchmaking has always used.
func seatOrder(first, second *Seek) (opener, replier *Seek) {
	replying := game.OtherColor(game.FirstToMove)
	if first.Setup.PreferredColor == replying ||
		second.Setup.PreferredColor == game.FirstToMove {
		return second, first
	}
	return first, second
}

// matchmakingElo reads the rating for the mode being sought, so a player's
// results in one mode never decide who they meet in another.
func matchmakingElo(client *Client, modeID game.ModeID) int {
	if client.account.UserID == "" {
		return persistence.DefaultElo
	}
	return client.account.ModeElo(modeID)
}

func absoluteDifference(first int, second int) int {
	if first < second {
		return second - first
	}
	return first - second
}
