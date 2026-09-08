#!/usr/bin/env python3
"""
generate_rps_chess_sounds.py

Dependency-free procedural sound generator for Rock-Paper-Scissors chess UI audio.

Outputs 16-bit mono WAV files using only Python's standard library.
Designed to create an original, cohesive set of short game sounds without
using copyrighted source recordings.

Usage:
    python3 generate_rps_chess_sounds.py
    python3 generate_rps_chess_sounds.py --out ./public/sounds
    python3 generate_rps_chess_sounds.py --rate 48000 --out ./assets/audio
"""

from __future__ import annotations

import argparse
import math
import random
import wave
from array import array
from pathlib import Path
from typing import Iterable, List, Sequence

DEFAULT_RATE = 44100


# ---------------------------------------------------------------------------
# Core utilities
# ---------------------------------------------------------------------------

def seconds_to_samples(seconds: float, rate: int) -> int:
    return max(1, int(round(seconds * rate)))


def silence(seconds: float, rate: int) -> List[float]:
    return [0.0] * seconds_to_samples(seconds, rate)


def normalize(samples: Sequence[float], peak: float = 0.88) -> List[float]:
    if not samples:
        return []
    current = max(abs(x) for x in samples)
    if current <= 1e-12:
        return list(samples)
    scale = peak / current
    return [x * scale for x in samples]


def mix(*tracks: Sequence[float]) -> List[float]:
    if not tracks:
        return []
    n = max(len(t) for t in tracks)
    out = [0.0] * n
    for track in tracks:
        for i, value in enumerate(track):
            out[i] += value
    return out


def concat(*tracks: Sequence[float]) -> List[float]:
    out: List[float] = []
    for track in tracks:
        out.extend(track)
    return out


def delay(track: Sequence[float], seconds: float, rate: int) -> List[float]:
    return silence(seconds, rate) + list(track)


def write_wav(path: Path, samples: Sequence[float], rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    samples = normalize(samples)

    pcm = array(
        "h",
        (
            max(-32768, min(32767, int(round(x * 32767.0))))
            for x in samples
        ),
    )

    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm.tobytes())


# ---------------------------------------------------------------------------
# Synthesis building blocks
# ---------------------------------------------------------------------------

def exp_decay(
    duration: float,
    rate: int,
    decay_seconds: float,
    attack_seconds: float = 0.0015,
) -> List[float]:
    n = seconds_to_samples(duration, rate)
    attack_n = max(1, seconds_to_samples(attack_seconds, rate))
    out = []

    for i in range(n):
        t = i / rate
        attack = min(1.0, i / attack_n)
        decay = math.exp(-t / max(decay_seconds, 1e-6))
        out.append(attack * decay)

    return out


def sine_resonance(
    frequency: float,
    duration: float,
    rate: int,
    decay_seconds: float,
    amplitude: float = 1.0,
    phase: float = 0.0,
) -> List[float]:
    env = exp_decay(duration, rate, decay_seconds)
    return [
        amplitude * env[i] * math.sin(2.0 * math.pi * frequency * i / rate + phase)
        for i in range(len(env))
    ]


def chirp(
    start_hz: float,
    end_hz: float,
    duration: float,
    rate: int,
    decay_seconds: float,
    amplitude: float = 1.0,
) -> List[float]:
    n = seconds_to_samples(duration, rate)
    env = exp_decay(duration, rate, decay_seconds, attack_seconds=0.002)
    out = []

    phase = 0.0
    for i in range(n):
        p = i / max(1, n - 1)
        freq = start_hz + (end_hz - start_hz) * p
        phase += 2.0 * math.pi * freq / rate
        out.append(amplitude * env[i] * math.sin(phase))

    return out


def noise_burst(
    duration: float,
    rate: int,
    rng: random.Random,
    decay_seconds: float,
    amplitude: float = 1.0,
    smooth: float = 0.0,
) -> List[float]:
    """
    White-noise transient with optional one-pole smoothing.
    smooth=0   -> raw/noisy
    smooth=.8  -> softer/duller
    """
    n = seconds_to_samples(duration, rate)
    env = exp_decay(duration, rate, decay_seconds, attack_seconds=0.0004)

    out = []
    prev = 0.0
    smooth = max(0.0, min(0.999, smooth))

    for i in range(n):
        raw = rng.uniform(-1.0, 1.0)
        filtered = smooth * prev + (1.0 - smooth) * raw
        prev = filtered
        out.append(amplitude * env[i] * filtered)

    return out


def click(
    rate: int,
    rng: random.Random,
    body_hz: float = 260.0,
    body2_hz: float = 520.0,
    duration: float = 0.090,
    weight: float = 1.0,
    brightness: float = 1.0,
) -> List[float]:
    """
    Short matte wooden/plastic board-piece click.

    This layers:
      - a tiny noise transient
      - low body resonance
      - weaker upper resonance
      - a very subtle high tick
    """
    transient = noise_burst(
        duration=min(0.025, duration),
        rate=rate,
        rng=rng,
        decay_seconds=0.007,
        amplitude=0.75 * weight * brightness,
        smooth=0.25,
    )

    body = sine_resonance(
        body_hz,
        duration,
        rate,
        decay_seconds=duration * 0.34,
        amplitude=0.78 * weight,
        phase=rng.uniform(0, 2 * math.pi),
    )

    body2 = sine_resonance(
        body2_hz,
        duration,
        rate,
        decay_seconds=duration * 0.24,
        amplitude=0.28 * weight * brightness,
        phase=rng.uniform(0, 2 * math.pi),
    )

    tick = sine_resonance(
        body2_hz * 2.8,
        min(duration, 0.035),
        rate,
        decay_seconds=0.009,
        amplitude=0.08 * brightness,
        phase=rng.uniform(0, 2 * math.pi),
    )

    return mix(transient, body, body2, tick)


def tone(
    hz: float,
    duration: float,
    rate: int,
    amplitude: float = 1.0,
    decay_seconds: float | None = None,
) -> List[float]:
    decay = decay_seconds if decay_seconds is not None else duration * 0.75
    fundamental = sine_resonance(hz, duration, rate, decay, amplitude)
    overtone = sine_resonance(hz * 2.0, duration, rate, decay * 0.7, amplitude * 0.17)
    return mix(fundamental, overtone)


# ---------------------------------------------------------------------------
# Sound definitions
# ---------------------------------------------------------------------------

def make_move(rate: int, rng: random.Random) -> List[float]:
    return click(
        rate,
        rng,
        body_hz=275,
        body2_hz=610,
        duration=0.085,
        weight=0.88,
        brightness=0.82,
    )


def make_rock_captures_scissors(rate: int, rng: random.Random) -> List[float]:
    """
    Heavy blunt impact with a tiny metallic after-ring.
    Suggests rock defeating scissors without becoming a literal foley effect.
    """
    impact = click(
        rate,
        rng,
        body_hz=145,
        body2_hz=315,
        duration=0.125,
        weight=1.28,
        brightness=0.62,
    )

    metal = delay(
        mix(
            sine_resonance(
                1650,
                0.090,
                rate,
                decay_seconds=0.030,
                amplitude=0.12,
                phase=rng.uniform(0, 2 * math.pi),
            ),
            sine_resonance(
                2310,
                0.075,
                rate,
                decay_seconds=0.022,
                amplitude=0.07,
                phase=rng.uniform(0, 2 * math.pi),
            ),
        ),
        0.012,
        rate,
    )

    return mix(impact, metal)


def make_scissors_captures_paper(rate: int, rng: random.Random) -> List[float]:
    """
    Crisp double transient with a dry tearing/slicing texture.
    Short enough to remain a UI sound rather than literal scissors audio.
    """
    snip1 = mix(
        noise_burst(
            0.040,
            rate,
            rng,
            decay_seconds=0.010,
            amplitude=0.90,
            smooth=0.12,
        ),
        sine_resonance(
            980,
            0.050,
            rate,
            decay_seconds=0.014,
            amplitude=0.20,
            phase=rng.uniform(0, 2 * math.pi),
        ),
    )

    snip2 = delay(
        mix(
            noise_burst(
                0.045,
                rate,
                rng,
                decay_seconds=0.011,
                amplitude=0.72,
                smooth=0.18,
            ),
            sine_resonance(
                1220,
                0.050,
                rate,
                decay_seconds=0.014,
                amplitude=0.16,
                phase=rng.uniform(0, 2 * math.pi),
            ),
        ),
        0.034,
        rate,
    )

    body = delay(
        sine_resonance(
            360,
            0.080,
            rate,
            decay_seconds=0.026,
            amplitude=0.22,
            phase=rng.uniform(0, 2 * math.pi),
        ),
        0.010,
        rate,
    )

    return mix(snip1, snip2, body)


def make_paper_captures_rock(rate: int, rng: random.Random) -> List[float]:
    """
    Softer wrapped impact: a muted thump followed by a broad papery sweep.
    Gives this matchup a distinct, less metallic texture.
    """
    thump = click(
        rate,
        rng,
        body_hz=175,
        body2_hz=390,
        duration=0.105,
        weight=0.92,
        brightness=0.46,
    )

    sweep = delay(
        noise_burst(
            0.095,
            rate,
            rng,
            decay_seconds=0.038,
            amplitude=0.38,
            smooth=0.72,
        ),
        0.008,
        rate,
    )

    soft_body = delay(
        sine_resonance(
            265,
            0.095,
            rate,
            decay_seconds=0.032,
            amplitude=0.20,
            phase=rng.uniform(0, 2 * math.pi),
        ),
        0.018,
        rate,
    )

    return mix(thump, sweep, soft_body)

def make_check(rate: int, rng: random.Random) -> List[float]:
    base = make_move(rate, rng)
    accent = delay(
        chirp(
            1050,
            1450,
            0.070,
            rate,
            decay_seconds=0.028,
            amplitude=0.22,
        ),
        0.015,
        rate,
    )
    return mix(base, accent)


def make_castle(rate: int, rng: random.Random) -> List[float]:
    first = click(
        rate,
        rng,
        body_hz=270,
        body2_hz=590,
        duration=0.078,
        weight=0.82,
        brightness=0.8,
    )
    second = delay(
        click(
            rate,
            rng,
            body_hz=225,
            body2_hz=500,
            duration=0.095,
            weight=0.95,
            brightness=0.78,
        ),
        0.075,
        rate,
    )
    return mix(first, second)


def make_promote(rate: int, rng: random.Random) -> List[float]:
    base = click(
        rate,
        rng,
        body_hz=250,
        body2_hz=565,
        duration=0.080,
        weight=0.70,
        brightness=0.75,
    )

    notes = [
        (659.25, 0.050),   # E5
        (830.61, 0.115),   # G#5
        (987.77, 0.180),   # B5
    ]

    layers = [base]
    for hz, offset in notes:
        layers.append(
            delay(
                tone(
                    hz,
                    duration=0.20,
                    rate=rate,
                    amplitude=0.23,
                    decay_seconds=0.090,
                ),
                offset,
                rate,
            )
        )
    return mix(*layers)


def make_game_start(rate: int, rng: random.Random) -> List[float]:
    """
    Compact "pieces down / match ready" cue.
    Two dry impacts with no melodic interval.
    """
    first = click(
        rate,
        rng,
        body_hz=235,
        body2_hz=510,
        duration=0.070,
        weight=0.62,
        brightness=0.68,
    )

    second = delay(
        click(
            rate,
            rng,
            body_hz=285,
            body2_hz=605,
            duration=0.090,
            weight=0.88,
            brightness=0.76,
        ),
        0.070,
        rate,
    )

    return mix(first, second)


def make_game_end(rate: int, rng: random.Random) -> List[float]:
    """
    Final board-settling cue: one firm impact and a low, damped tail.
    Avoids the melodic/doorbell character of a two-note chime.
    """
    impact = click(
        rate,
        rng,
        body_hz=165,
        body2_hz=350,
        duration=0.125,
        weight=1.08,
        brightness=0.52,
    )

    settle = delay(
        mix(
            sine_resonance(
                118,
                0.230,
                rate,
                decay_seconds=0.075,
                amplitude=0.34,
                phase=rng.uniform(0, 2 * math.pi),
            ),
            noise_burst(
                0.105,
                rate,
                rng,
                decay_seconds=0.032,
                amplitude=0.16,
                smooth=0.82,
            ),
        ),
        0.020,
        rate,
    )

    return mix(impact, settle)

def make_illegal(rate: int, rng: random.Random) -> List[float]:
    # Dry low thunk + tiny downward chirp. Intentionally restrained.
    thunk = click(
        rate,
        rng,
        body_hz=155,
        body2_hz=330,
        duration=0.100,
        weight=0.86,
        brightness=0.48,
    )
    drop = delay(
        chirp(
            410,
            260,
            0.095,
            rate,
            decay_seconds=0.045,
            amplitude=0.18,
        ),
        0.010,
        rate,
    )
    return mix(thunk, drop)


def make_notify(rate: int, rng: random.Random) -> List[float]:
    # Optional general-purpose soft UI notification.
    a = tone(783.99, 0.11, rate, amplitude=0.19, decay_seconds=0.050)  # G5
    b = delay(
        tone(987.77, 0.14, rate, amplitude=0.17, decay_seconds=0.060), # B5
        0.055,
        rate,
    )
    return mix(a, b)


SOUND_FACTORIES = {
    "move.wav": make_move,
    "rock-captures-scissors.wav": make_rock_captures_scissors,
    "scissors-captures-paper.wav": make_scissors_captures_paper,
    "paper-captures-rock.wav": make_paper_captures_rock,
    "check.wav": make_check,
    "game-start.wav": make_game_start,
    "game-end.wav": make_game_end,
    "illegal.wav": make_illegal,
    "notify.wav": make_notify,
}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate an original set of short Rock-Paper-Scissors chess WAV effects."
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("generated-game-sounds"),
        help="Output directory (default: generated-game-sounds)",
    )
    parser.add_argument(
        "--rate",
        type=int,
        default=DEFAULT_RATE,
        help=f"Sample rate in Hz (default: {DEFAULT_RATE})",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=1227,
        help="Random seed for deterministic regeneration (default: 1227)",
    )

    args = parser.parse_args()

    if args.rate < 8000:
        parser.error("--rate must be at least 8000 Hz")

    args.out.mkdir(parents=True, exist_ok=True)

    # Derive an independent deterministic RNG per sound so adding/reordering
    # sounds later does not silently change all existing files.
    for index, (filename, factory) in enumerate(SOUND_FACTORIES.items()):
        rng = random.Random(args.seed + index * 1009)
        samples = factory(args.rate, rng)
        destination = args.out / filename
        write_wav(destination, samples, args.rate)
        print(f"Wrote {destination}")

    print(f"\nGenerated {len(SOUND_FACTORIES)} sounds in: {args.out.resolve()}")


if __name__ == "__main__":
    main()
