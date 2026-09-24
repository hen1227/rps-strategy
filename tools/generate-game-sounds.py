#!/usr/bin/env python3
"""
Procedural generator for this game's sound packs.

Writes every clip the board speaks with, as 16-bit mono WAVs, using nothing but
the standard library. The sounds are synthesised here rather than recorded or
sourced, which is what keeps them free of any licence: see
`docs/sound-design.md` for why that matters and what it cost the set that came
before this one.

Two things distinguish it from a bank of hand-tuned oscillators:

*Packs are timbre, events are meaning.* A pack is a `Voice` — what a piece
landing on this board is made of — and the nine events are composed from it by
shared code. So a pack is internally cohesive by construction: `end` is the
same material as `move`, struck harder and left to ring, and nobody has to keep
nine hand-written functions in agreement with each other.

*Level is measured, not assumed.* Every clip is normalised to a target on a
perceptual loudness scale (BS.1770 K-weighting, held to the loudest 100 ms of
the clip), never to a peak. Peak normalisation is what made the previous set
unpleasant: a dry sine and a noise burst at the same peak are nowhere near the
same loudness, so `illegal` shipped 15 dB *above* `move` and the game shouted at
you for a misclick. The ladder in `EVENT_LOUDNESS` is now the design, and it is
readable as one: rare events sit a few dB over constant ones, and nothing sits
anywhere by accident.

Usage:
    python3 tools/generate-game-sounds.py                 # write the packs
    python3 tools/generate-game-sounds.py --measure       # report levels only
    python3 tools/generate-game-sounds.py --out /tmp/wav  # somewhere else
"""

from __future__ import annotations

import argparse
import math
import random
import wave
import zlib
from array import array
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Sequence

RATE = 44100

Samples = List[float]


# ---------------------------------------------------------------------------
# Frames and mixing
# ---------------------------------------------------------------------------

def n_of(seconds: float) -> int:
    return max(1, int(round(seconds * RATE)))


def silence(seconds: float) -> Samples:
    return [0.0] * n_of(seconds)


def mix(*tracks: Sequence[float]) -> Samples:
    """Sum tracks of any lengths, longest wins."""
    tracks = tuple(t for t in tracks if len(t))
    if not tracks:
        return []
    out = [0.0] * max(len(t) for t in tracks)
    for track in tracks:
        for i, value in enumerate(track):
            out[i] += value
    return out


def at(seconds: float, track: Sequence[float]) -> Samples:
    """The track, starting `seconds` in. Every layered event is built of these."""
    return silence(seconds) + list(track) if seconds > 0 else list(track)


def gain(track: Sequence[float], amount: float) -> Samples:
    return [v * amount for v in track]


def pad_to(track: Sequence[float], seconds: float) -> Samples:
    """Room for a tail to finish in, so a decay is never cut off mid-ring."""
    want = n_of(seconds)
    return list(track) + [0.0] * max(0, want - len(track))


# ---------------------------------------------------------------------------
# Filters
#
# RBJ cookbook biquads, direct form I. The K-weighting the loudness measure
# needs is two of these, so the same eight lines serve both the synthesis and
# the metering rather than each growing its own.
# ---------------------------------------------------------------------------

def biquad(x: Sequence[float], b: Sequence[float], a: Sequence[float]) -> Samples:
    b0, b1, b2 = b
    a1, a2 = a[1], a[2]
    out = [0.0] * len(x)
    x1 = x2 = y1 = y2 = 0.0
    for i, s in enumerate(x):
        y = b0 * s + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1 = x1, s
        y2, y1 = y1, y
        out[i] = y
    return out


def _rbj(kind: str, hz: float, q: float) -> tuple[list[float], list[float]]:
    hz = max(10.0, min(hz, RATE * 0.48))
    w = 2.0 * math.pi * hz / RATE
    cs, sn = math.cos(w), math.sin(w)
    alpha = sn / (2.0 * q)
    if kind == "lowpass":
        b = [(1 - cs) / 2, 1 - cs, (1 - cs) / 2]
    elif kind == "highpass":
        b = [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2]
    else:
        raise ValueError(kind)
    a = [1 + alpha, -2 * cs, 1 - alpha]
    return [v / a[0] for v in b], [1.0, a[1] / a[0], a[2] / a[0]]


def lowpass(x: Sequence[float], hz: float, q: float = 0.707) -> Samples:
    b, a = _rbj("lowpass", hz, q)
    return biquad(x, b, a)


def highpass(x: Sequence[float], hz: float, q: float = 0.707) -> Samples:
    b, a = _rbj("highpass", hz, q)
    return biquad(x, b, a)



# ---------------------------------------------------------------------------
# Envelopes and sources
# ---------------------------------------------------------------------------

def envelope(duration: float, decay: float, attack: float = 0.002) -> Samples:
    """
    Raised-cosine attack into an exponential decay, faded out at the end.

    Both ends matter. A linear attack has a corner at the top that reads as a
    tick of its own on top of the sound it is shaping, and an exponential decay
    truncated at `duration` leaves a step down to zero — a click at the end of
    every clip, which is a good half of what "harsh" meant in the old set.
    """
    n = n_of(duration)
    attack_n = max(1, n_of(attack))
    fade_n = min(max(1, n_of(0.006)), n // 3)
    out = [0.0] * n
    for i in range(n):
        rise = 1.0 if i >= attack_n else 0.5 * (1.0 - math.cos(math.pi * i / attack_n))
        fall = math.exp(-(i / RATE) / max(decay, 1e-6))
        out[i] = rise * fall
    for k in range(fade_n):  # land on true zero, always
        out[n - fade_n + k] *= 0.5 * (1.0 + math.cos(math.pi * k / fade_n))
    return out


def partial(hz: float, duration: float, decay: float,
            amp: float = 1.0, attack: float = 0.002,
            phase: float = 0.0) -> Samples:
    """One decaying sine. Struck bodies are a handful of these."""
    env = envelope(duration, decay, attack)
    step = 2.0 * math.pi * hz / RATE
    return [amp * env[i] * math.sin(step * i + phase) for i in range(len(env))]


def pulse(hz: float, duration: float, decay: float, amp: float = 1.0,
          width: float = 0.5, attack: float = 0.001,
          bend: float = 1.0) -> Samples:
    """
    A band-limited-enough pulse wave, optionally bending in pitch.

    Not actually band-limited — a hard square at these pitches aliases above
    ~11 kHz, which the final low-pass on the arcade voice removes. `bend` is the
    ratio the pitch slides to across the clip, which is the whole vocabulary of
    a chiptune blip.
    """
    n = n_of(duration)
    env = envelope(duration, decay, attack)
    out = [0.0] * n
    phase = 0.0
    for i in range(n):
        p = i / max(1, n - 1)
        freq = hz * (1.0 + (bend - 1.0) * p)
        phase += freq / RATE
        cycle = phase - math.floor(phase)
        out[i] = amp * env[i] * (1.0 if cycle < width else -1.0)
    return out


def triangle(hz: float, duration: float, decay: float, amp: float = 1.0,
             attack: float = 0.002, bend: float = 1.0) -> Samples:
    n = n_of(duration)
    env = envelope(duration, decay, attack)
    out = [0.0] * n
    phase = 0.0
    for i in range(n):
        p = i / max(1, n - 1)
        phase += hz * (1.0 + (bend - 1.0) * p) / RATE
        cycle = phase - math.floor(phase)
        out[i] = amp * env[i] * (4.0 * abs(cycle - 0.5) - 1.0)
    return out


def noise(duration: float, rng: random.Random, decay: float, amp: float = 1.0,
          low: float = 200.0, high: float = 6000.0, attack: float = 0.0006) -> Samples:
    """
    A shaped noise transient — the *air* of a strike, not a burst of hiss.

    Band-limited with real filters rather than the one-pole smoothing the old
    generator used. A 6 dB/octave slope leaves most of the top end in place,
    which is why those transients sounded like static laid over the sound
    instead of like part of it.
    """
    n = n_of(duration)
    raw = [rng.uniform(-1.0, 1.0) for _ in range(n)]
    shaped = lowpass(highpass(raw, low), high)
    env = envelope(duration, decay, attack)
    return [amp * env[i] * shaped[i] for i in range(n)]


def soften(x: Sequence[float], amount: float = 1.0) -> Samples:
    """
    Round the very top of a transient off.

    A strike's first millisecond is its loudest by a long way, and it is that
    peak — not the body — that reads as "hard". Bending it with a tanh keeps the
    attack's speed while taking the edge off, and it buys back headroom for the
    loudness stage below.
    """
    if amount <= 0:
        return list(x)
    k = 1.0 + 2.5 * amount
    return [math.tanh(k * v) / math.tanh(k) for v in x]


# ---------------------------------------------------------------------------
# Loudness
#
# BS.1770-4 K-weighting, held to the loudest 100 ms window of the clip rather
# than integrated over it. Integrated loudness is the wrong tool for one-shots:
# its gating drops blocks below the threshold, so a 90 ms click surrounded by
# silence measures as whatever its padding happens to be. What a player compares
# between two clips is roughly the loudest moment of each, and 100 ms is about
# the ear's own integration time.
# ---------------------------------------------------------------------------

def k_weight(x: Sequence[float]) -> Samples:
    # Stage 1, the head-shadow high shelf, at BS.1770's coefficients for 48 kHz
    # re-derived for our rate; stage 2, the 38 Hz high-pass.
    f0, g, q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    k = math.tan(math.pi * f0 / RATE)
    vh = 10 ** (g / 20.0)
    vb = vh ** 0.4996667741545416
    a0 = 1.0 + k / q + k * k
    b = [(vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0,
         (vh - vb * k / q + k * k) / a0]
    a = [1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0]
    y = biquad(x, b, a)

    f0, q = 38.13547087602444, 0.5003270373238773
    k = math.tan(math.pi * f0 / RATE)
    a0 = 1.0 + k / q + k * k
    return biquad(y, [1.0, -2.0, 1.0],
                  [1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0])


WINDOW = 0.100


def loudness(x: Sequence[float]) -> float:
    """The clip's level in LUFS, as its loudest `WINDOW` seconds."""
    if not x:
        return -120.0
    y = k_weight(x)
    n = n_of(WINDOW)
    if len(y) <= n:  # shorter than the window: the silence around it counts
        return -0.691 + 10 * math.log10(sum(v * v for v in y) / n + 1e-20)
    run = sum(v * v for v in y[:n])
    best = run
    for i in range(n, len(y)):
        run += y[i] * y[i] - y[i - n] * y[i - n]
        best = max(best, run)
    return -0.691 + 10 * math.log10(best / n + 1e-20)


PEAK_CEILING = 0.70  # −3.1 dBFS, headroom for whatever the clip is mixed into


def normalize(x: Sequence[float], target_lufs: float) -> Samples:
    """
    Put the clip at `target_lufs`, and keep it there.

    If the result would clip, the peak is soft-limited rather than the whole
    clip turned down — turning it down is exactly the thing that would undo the
    match we just made. Limiting costs a little loudness of its own, so the
    measure is taken again and the small remaining error corrected; one pass is
    enough at the depths involved.
    """
    scaled = gain(x, 10 ** ((target_lufs - loudness(x)) / 20.0))
    peak = max((abs(v) for v in scaled), default=0.0)
    if peak <= PEAK_CEILING:
        return scaled
    limited = [PEAK_CEILING * math.tanh(v / PEAK_CEILING) for v in scaled]
    return gain(limited, 10 ** ((target_lufs - loudness(limited)) / 20.0))


# ---------------------------------------------------------------------------
# Voices
#
# What a pack is made of. Everything below the `strike` line is shared shaping;
# `strike` itself is how this pack's material answers being hit, and the event
# composers call it with a weight and a pitch rather than knowing any of it.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Voice:
    id: str
    name: str
    blurb: str
    # The note a plain move lands on, and the ratios its body rings at.
    body_hz: float
    partials: Sequence[tuple[float, float, float]]  # (ratio, amp, decay scale)
    decay: float
    attack: float = 0.002
    # The transient: how much, and where it lives.
    noise_amp: float = 0.5
    noise_band: tuple[float, float] = (400.0, 6000.0)
    noise_decay: float = 0.006
    # Final shaping over every clip in the pack.
    tilt_hz: float = 9000.0
    soften: float = 0.6
    # A pack-wide trim on the loudness ladder, for a voice that is meant to sit
    # under the others rather than beside them.
    trim_db: float = 0.0
    # Tonal packs put their events on these degrees instead of on `body_hz`.
    scale: Sequence[float] = field(default_factory=tuple)
    strike: Callable[["Voice", random.Random, float, float, float], Samples] | None = None


def struck_body(voice: Voice, rng: random.Random, weight: float,
                pitch: float, duration: float) -> Samples:
    """A struck object: a shaped transient over a stack of decaying partials."""
    layers = [
        noise(
            min(0.030, duration),
            rng,
            decay=voice.noise_decay,
            amp=voice.noise_amp * weight,
            low=voice.noise_band[0],
            high=voice.noise_band[1],
        )
    ]
    for ratio, amp, decay_scale in voice.partials:
        layers.append(
            partial(
                voice.body_hz * pitch * ratio,
                duration,
                decay=voice.decay * decay_scale,
                amp=amp * weight,
                attack=voice.attack,
                phase=rng.uniform(0.0, 2.0 * math.pi),
            )
        )
    return mix(*layers)


def chip_body(voice: Voice, rng: random.Random, weight: float,
              pitch: float, duration: float) -> Samples:
    """The arcade voice: a pulse that drops a little as it dies."""
    hz = voice.body_hz * pitch
    return mix(
        pulse(hz, duration, decay=voice.decay, amp=0.5 * weight,
              width=0.30, attack=voice.attack, bend=0.93),
        triangle(hz * 2.0, duration * 0.6, decay=voice.decay * 0.5,
                 amp=0.18 * weight, attack=voice.attack),
    )


def finish(voice: Voice, track: Sequence[float]) -> Samples:
    """
    The shaping every clip in a pack gets, so the set sounds like one thing.

    The 28 Hz high-pass is not tone — it is hygiene, and it is not optional. A
    pulse wave narrower than half duty is asymmetric about zero, so the arcade
    voice carries a DC offset (measured at −0.024 before this went in) that an
    envelope cannot cancel: it wastes headroom the loudness stage then has to
    work around, and it steps the speaker cone on the first and last sample,
    which is a faint pop under every clip. The same filter takes the subsonic
    energy out of the struck voices, where a phone speaker can only rattle at
    it.
    """
    return lowpass(highpass(soften(track, voice.soften), 28.0), voice.tilt_hz)


def hit(voice: Voice, rng: random.Random, weight: float = 1.0,
        pitch: float = 1.0, duration: float | None = None) -> Samples:
    body = voice.strike or struck_body
    return body(voice, rng, weight, pitch, duration or voice.decay * 3.2)


def degree(voice: Voice, index: int) -> float:
    """A note from the pack's scale, or its body note if it has none."""
    if not voice.scale:
        return voice.body_hz
    return voice.scale[index % len(voice.scale)]


# ---------------------------------------------------------------------------
# Events
#
# One composer per `GameSound`. Each is written in terms of `hit`, so a new pack
# needs no entry here — and the differences between them are *meaning*: a
# capture is heavier than a move, an ending is left to ring, a refused move is
# the smallest sound in the game rather than the largest.
# ---------------------------------------------------------------------------

MOVE_RING = 2.6
"""
How long a move is left to ring, as a multiple of the pack's decay.

Below the 3.2 every other event gets, because this is the one that fires on
every ply: in a fast game the tail of one move would still be sounding when the
next arrives, and two rings overlapping is the difference between a board that
resonates and a board that smears.
"""


def ev_move_self(v: Voice, rng: random.Random) -> Samples:
    return hit(v, rng, weight=0.85, pitch=1.0, duration=v.decay * MOVE_RING)


def ev_move_opponent(v: Voice, rng: random.Random) -> Samples:
    """
    The same piece, lower and a touch duller.

    Worth having at all because the board is often not what you are looking at
    when the other side moves. A fifth down is far enough to tell apart without
    becoming a second sound to learn.
    """
    return lowpass(
        hit(v, rng, weight=0.85, pitch=0.67, duration=v.decay * MOVE_RING),
        v.tilt_hz * 0.55,
    )


def ev_rock_takes_scissors(v: Voice, rng: random.Random) -> Samples:
    """Blunt and low, with a bright fragment thrown off it."""
    impact = hit(v, rng, weight=1.25, pitch=0.60, duration=v.decay * 4.5)
    shard = at(0.014, mix(
        partial(v.body_hz * 6.4, 0.10, decay=0.028, amp=0.10, attack=0.001,
                phase=rng.uniform(0, 6.28)),
        partial(v.body_hz * 9.1, 0.07, decay=0.019, amp=0.06, attack=0.001,
                phase=rng.uniform(0, 6.28)),
    ))
    return mix(impact, shard)


def ev_scissors_takes_paper(v: Voice, rng: random.Random) -> Samples:
    """Two quick closes — a snip, not a scissors recording."""
    first = hit(v, rng, weight=0.72, pitch=1.50, duration=v.decay * 2.0)
    second = at(0.036, hit(v, rng, weight=0.90, pitch=1.34, duration=v.decay * 2.6))
    cut = at(0.030, noise(0.045, rng, decay=0.009, amp=0.22 * v.noise_amp,
                          low=1800.0, high=min(9000.0, v.tilt_hz)))
    return mix(first, second, cut)


def ev_paper_takes_rock(v: Voice, rng: random.Random) -> Samples:
    """Wrapped: a muffled landing and a soft sweep closing over it."""
    thump = hit(v, rng, weight=1.0, pitch=0.78, duration=v.decay * 3.6)
    wrap = at(0.010, noise(0.11, rng, decay=0.040, amp=0.30 * v.noise_amp,
                           low=180.0, high=1400.0, attack=0.010))
    return mix(lowpass(thump, v.tilt_hz * 0.45), wrap)


def ev_illegal(v: Voice, rng: random.Random) -> Samples:
    """
    The smallest sound in the game.

    A refused move is the player's hand slipping, not an offence, and this used
    to be the loudest clip in the set by 15 dB. Two low taps, the second under
    the first: enough to say the board did not take it, and nothing more. The
    loudness ladder does the rest.
    """
    first = hit(v, rng, weight=0.55, pitch=0.52, duration=v.decay * 2.2)
    second = at(0.075, hit(v, rng, weight=0.42, pitch=0.49, duration=v.decay * 2.2))
    return lowpass(mix(first, second), v.tilt_hz * 0.35)


def ev_start(v: Voice, rng: random.Random) -> Samples:
    """Two pieces set down, the second answering the first a step up."""
    if v.scale:
        a = hit(v, rng, weight=0.75, pitch=degree(v, 0) / v.body_hz)
        b = at(0.090, hit(v, rng, weight=0.95, pitch=degree(v, 2) / v.body_hz))
    else:
        a = hit(v, rng, weight=0.75, pitch=0.90)
        b = at(0.090, hit(v, rng, weight=0.95, pitch=1.19))
    return pad_to(mix(a, b), 0.62)


def ev_end(v: Voice, rng: random.Random) -> Samples:
    """One firm strike and a long settle under it. The board coming to rest."""
    if v.scale:
        strike = hit(v, rng, weight=1.0, pitch=degree(v, 3) / v.body_hz,
                     duration=v.decay * 6.0)
        under = at(0.100, hit(v, rng, weight=0.55, pitch=degree(v, 0) / v.body_hz / 2.0,
                              duration=v.decay * 7.0))
    else:
        strike = hit(v, rng, weight=1.05, pitch=0.72, duration=v.decay * 6.0)
        under = at(0.100, partial(v.body_hz * 0.36, 0.55, decay=0.19, amp=0.30,
                                  attack=0.012, phase=rng.uniform(0, 6.28)))
    return pad_to(mix(strike, under), 0.90)


def ev_notify(v: Voice, rng: random.Random) -> Samples:
    """Two notes rising. The one event that is asking for attention."""
    if v.scale:
        lo, hi = degree(v, 1), degree(v, 3)
    else:
        lo, hi = v.body_hz * 1.5, v.body_hz * 2.0
    a = hit(v, rng, weight=0.60, pitch=lo / v.body_hz, duration=v.decay * 4.0)
    b = at(0.105, hit(v, rng, weight=0.75, pitch=hi / v.body_hz, duration=v.decay * 5.0))
    return pad_to(mix(a, b), 0.70)


EVENTS: Dict[str, Callable[[Voice, random.Random], Samples]] = {
    "move-self": ev_move_self,
    "move-opponent": ev_move_opponent,
    "rock-takes-scissors": ev_rock_takes_scissors,
    "scissors-takes-paper": ev_scissors_takes_paper,
    "paper-takes-rock": ev_paper_takes_rock,
    "illegal": ev_illegal,
    "start": ev_start,
    "end": ev_end,
    "notify": ev_notify,
}


# ---------------------------------------------------------------------------
# The loudness ladder
#
# The whole point of the rewrite, and the one table to argue with. Read it as a
# ranking and it should be uncontroversial: the sound that fires on every ply is
# the quietest thing here, a refused move barely louder, captures a step up
# because something happened, and the three events that end or begin something
# at the top. Seven dB covers the lot.
#
# For scale: the set this replaced ran from −25 to −10 LUFS with `illegal` at the
# loud end, and broadcast dialogue sits at −23.
# ---------------------------------------------------------------------------

EVENT_LOUDNESS: Dict[str, float] = {
    "move-self": -28.0,
    "move-opponent": -27.5,
    "illegal": -27.0,
    "scissors-takes-paper": -24.5,
    "rock-takes-scissors": -24.0,
    "paper-takes-rock": -24.5,
    "notify": -22.0,
    "start": -22.5,
    "end": -21.5,
}


# ---------------------------------------------------------------------------
# The packs
# ---------------------------------------------------------------------------

VOICES: List[Voice] = [
    Voice(
        id="wood",
        name="Wood",
        blurb="Warm and matte, like pieces on a wooden board.",
        body_hz=250.0,
        # Inharmonic, which is what a struck block of wood is: the ratios are
        # nowhere near whole numbers, so it reads as a knock and not as a note.
        partials=((1.0, 0.62, 1.0), (2.76, 0.26, 0.55), (5.40, 0.11, 0.30)),
        decay=0.028,
        attack=0.0018,
        noise_amp=0.50,
        noise_band=(700.0, 5200.0),
        noise_decay=0.0055,
        tilt_hz=8500.0,
        soften=0.65,
    ),
    Voice(
        id="felt",
        name="Felt",
        blurb="Barely there. Damped and dark, for playing in company.",
        body_hz=190.0,
        partials=((1.0, 0.70, 1.0), (2.10, 0.16, 0.40)),
        decay=0.022,
        # A slow attack is most of what "damped" means: nothing here arrives
        # fast enough to be a click.
        attack=0.0075,
        noise_amp=0.16,
        noise_band=(200.0, 1100.0),
        noise_decay=0.010,
        tilt_hz=2400.0,
        soften=0.9,
        # Under the others on purpose. Choosing this pack is choosing to hear
        # less, so it keeps the shape of the ladder and moves the whole thing
        # down rather than flattening it.
        trim_db=-5.0,
    ),
    Voice(
        id="arcade",
        name="Arcade",
        blurb="Square-wave blips. A cabinet in the corner of the room.",
        body_hz=392.0,          # G4, and the scale below is G major pentatonic
        partials=(),            # unused: this voice strikes with `chip_body`
        decay=0.045,
        attack=0.0008,
        noise_amp=0.30,
        noise_band=(900.0, 7000.0),
        noise_decay=0.008,
        tilt_hz=10500.0,
        soften=0.45,
        scale=(392.00, 440.00, 587.33, 659.25, 783.99),
        strike=chip_body,
    ),
    Voice(
        id="glass",
        name="Glass",
        blurb="Struck glass, tuned. The board rings a little after each move.",
        body_hz=523.25,         # C5, C major pentatonic
        # Bell ratios: stretched and inharmonic, with the upper partials dying
        # first, which is what makes a strike read as glass rather than as a
        # sine.
        partials=((1.0, 0.44, 1.0), (2.01, 0.24, 0.62),
                  (3.42, 0.13, 0.36), (5.06, 0.06, 0.20)),
        decay=0.140,
        attack=0.0012,
        noise_amp=0.20,
        noise_band=(3000.0, 12000.0),
        noise_decay=0.0035,
        tilt_hz=13000.0,
        soften=0.35,
        scale=(523.25, 587.33, 659.25, 783.99, 880.00),
    ),
]


def render(voice: Voice, event: str, seed: int) -> Samples:
    rng = random.Random(seed)
    raw = finish(voice, EVENTS[event](voice, rng))
    return normalize(raw, EVENT_LOUDNESS[event] + voice.trim_db)


def seed_for(voice: Voice, event: str) -> int:
    """
    Per pack and per event, so the files are reproducible and *independent*.

    Adding a pack or reordering the table must not silently rewrite every clip
    that already shipped, which is what a single walking seed would do. Hashed
    with CRC rather than `hash()`, which is salted per process and would hand
    back a different set of files on every run.
    """
    return zlib.crc32(f"{voice.id}/{event}".encode()) % 100_000


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def land(x: Sequence[float], floor: float = 2.5e-4) -> Samples:
    """
    Cut the inaudible tail, then bring the clip to true zero.

    Two jobs that have to happen in this order and at this point — after every
    filter, not inside the envelope. The envelope already fades out, but
    `finish` runs a 28 Hz high-pass *after* it, and a filter that low rings for
    tens of milliseconds: its output does not land where its input did. Trimming
    then stops wherever the ring happens to be, which measured as high as
    −53 dBFS — a step to zero at the end of the file, which is the same
    discontinuity the old set had and the same faint click.

    So the fade is applied last, to whatever the filters actually produced. The
    floor is −72 dBFS, far under anything audible in clips that peak around
    −15, and on the ringing packs it is worth a third of the bytes.
    """
    last = len(x)
    while last > 1 and abs(x[last - 1]) < floor:
        last -= 1
    out = list(x[:last])
    fade = min(n_of(0.004), len(out))
    for k in range(fade):
        out[len(out) - fade + k] *= 0.5 * (1.0 + math.cos(math.pi * k / fade))
    return out


def write_wav(path: Path, x: Sequence[float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = array("h", (max(-32768, min(32767, int(round(v * 32767.0)))) for v in x))
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(RATE)
        wf.writeframes(pcm.tobytes())


# ---------------------------------------------------------------------------
# The picture the picker draws
#
# Each pack's chip in Appearance shows the envelope of its own move clip, which
# is the clip choosing a pack plays back. Four identical speaker icons would
# tell a player nothing about four packs; the shape of the thing they are about
# to hear tells them most of it.
#
# Drawn on a *shared* time axis and a shared amplitude scale, both on purpose. A
# per-clip axis would draw Glass and Felt the same width when one rings six
# times longer than the other, and a per-clip amplitude would draw Felt at full
# height when the whole point of it is that it is quieter.
# ---------------------------------------------------------------------------

WAVEFORM_WINDOW = 0.40
WAVEFORM_BUCKETS = 40


def envelope_picture(clip: Sequence[float]) -> List[float]:
    """Peak amplitude per bucket, over a fixed window. Not normalised."""
    span = n_of(WAVEFORM_WINDOW)
    per = span // WAVEFORM_BUCKETS
    out = []
    for b in range(WAVEFORM_BUCKETS):
        chunk = clip[b * per:(b + 1) * per]
        out.append(max((abs(v) for v in chunk), default=0.0))
    return out


def write_waveforms(path: Path, pictures: Dict[str, List[float]]) -> None:
    loudest = max((max(p) for p in pictures.values()), default=1.0) or 1.0
    lines = [
        "// Generated by tools/generate-game-sounds.py. Do not edit by hand.",
        "//",
        "// One entry per pack: the peak envelope of its `moveSelf` clip, in",
        f"// {WAVEFORM_BUCKETS} buckets across a shared {WAVEFORM_WINDOW:.2f}s window, scaled so the",
        "// loudest pack reaches 1. Shared axes are what make the shapes",
        "// comparable — a pack that rings longer draws wider, and a pack that is",
        "// quieter draws shorter, which is exactly what the picker should say.",
        "",
        "export const SOUND_WAVEFORMS: Record<string, readonly number[]> = {",
    ]
    for pack_id, picture in pictures.items():
        values = ", ".join(f"{v / loudest:.3f}".rstrip("0").rstrip(".") or "0"
                           for v in picture)
        lines.append(f"  {pack_id}: [{values}],")
    lines += ["};", ""]
    path.write_text("\n".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path,
                        default=Path(__file__).resolve().parents[1]
                        / "frontend" / "assets" / "sounds",
                        help="Directory to write pack folders into.")
    parser.add_argument("--measure", action="store_true",
                        help="Report the level of every clip and write nothing.")
    parser.add_argument("--pack", action="append", default=None,
                        help="Only this pack. Repeatable.")
    parser.add_argument("--waveforms", type=Path, default=None,
                        help="Where to write the picker's waveform module.")
    args = parser.parse_args()

    voices = [v for v in VOICES if not args.pack or v.id in args.pack]
    if not voices:
        parser.error("no pack by that name")

    pictures: Dict[str, List[float]] = {}
    for voice in voices:
        print(f"\n{voice.name.lower()}")
        for event in EVENTS:
            clip = land(render(voice, event, seed_for(voice, event)))
            measured = loudness(clip)
            peak = max((abs(v) for v in clip), default=0.0)
            target = EVENT_LOUDNESS[event] + voice.trim_db
            flag = "" if abs(measured - target) < 0.6 else "  <- off target"
            line = (f"  {event:22s} {measured:7.2f} LUFS "
                    f"(want {target:6.1f})  peak {20 * math.log10(peak + 1e-12):6.2f} dB"
                    f"  {len(clip) / RATE:5.3f}s{flag}")
            if event == "move-self":
                pictures[voice.id] = envelope_picture(clip)
            if args.measure:
                print(line)
                continue
            destination = args.out / voice.id / f"{event}.wav"
            write_wav(destination, clip)
            print(f"{line}  {destination.stat().st_size // 1024:3d} KB")

    if args.measure:
        return

    print(f"\nWrote {len(voices) * len(EVENTS)} clips under {args.out}")
    # Only when the whole set was rendered: a partial run would scale the
    # pictures against whichever packs happened to be asked for.
    if args.pack:
        print("Skipped the waveform module — rerun without --pack to refresh it.")
        return
    waveforms = args.waveforms or (
        Path(__file__).resolve().parents[1]
        / "frontend" / "src" / "appearance" / "soundWaveforms.ts"
    )
    write_waveforms(waveforms, pictures)
    print(f"Wrote {waveforms}")


if __name__ == "__main__":
    main()
