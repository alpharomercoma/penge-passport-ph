# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
# An original track for the ad: 128 BPM, A minor, synthesised from scratch
# (no samples, nothing licensed). Scene cuts land on bar lines; see bar() in ad.html.
#   uv run music.py   -> out/music.wav, out/music.json
import json
from pathlib import Path
import numpy as np
from scipy.signal import butter, lfilter, sosfilt

SR = 48000
BPM = 128
BEAT = 60 / BPM
BAR = 4 * BEAT
BARS = 25
LENGTH = BARS * BAR + 2.2  # a tail after the last hit
N = int(LENGTH * SR)
rng = np.random.default_rng(20260928)


def t_of(bar, beat=0.0):
    return (bar * 4 + beat) * BEAT


def empty():
    return np.zeros(N)


def place(buf, start, sig, gain=1.0):
    i = int(start * SR)
    if i >= N:
        return
    j = min(N, i + len(sig))
    buf[i:j] += sig[: j - i] * gain


def env(n, a=0.002, d=0.2, curve=4.0):
    t = np.arange(n) / SR
    att = np.clip(t / max(a, 1e-6), 0, 1)
    dec = np.exp(-curve * np.clip(t - a, 0, None) / max(d, 1e-6))
    return att * dec


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def lp(sig, cutoff, order=2):
    sos = butter(order, min(cutoff, SR / 2 - 100) / (SR / 2), btype='low', output='sos')
    return sosfilt(sos, sig)


def hp(sig, cutoff, order=2):
    sos = butter(order, cutoff / (SR / 2), btype='high', output='sos')
    return sosfilt(sos, sig)


def bp(sig, lo, hi, order=2):
    sos = butter(order, [lo / (SR / 2), hi / (SR / 2)], btype='band', output='sos')
    return sosfilt(sos, sig)


def saw(freq, n, phase=0.0):
    t = np.arange(n) / SR
    return 2 * ((freq * t + phase) % 1.0) - 1


# --- instruments ---------------------------------------------------------------

def kick():
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 45 + 120 * np.exp(-t * 38)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * env(n, 0.001, 0.32, 5)
    click = hp(rng.standard_normal(n), 3000) * env(n, 0.0005, 0.006, 6) * 0.35
    return np.tanh((body + click) * 1.6)


def clap():
    n = int(0.3 * SR)
    noise = bp(rng.standard_normal(n), 900, 5000)
    e = np.zeros(n)
    for k, off in enumerate([0, 0.011, 0.022]):
        i = int(off * SR)
        e[i:] += env(n - i, 0.0005, 0.012 if k < 2 else 0.14, 5)
    return noise * e * 0.7


def hat(open_=False):
    n = int((0.22 if open_ else 0.05) * SR)
    return hp(rng.standard_normal(n), 7000) * env(n, 0.0005, 0.16 if open_ else 0.025, 5) * 0.35


def tick():
    n = int(0.03 * SR)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * 3200 * t) + 0.5 * hp(rng.standard_normal(n), 5000)) * env(n, 0.0003, 0.01, 6) * 0.35


def supersaw(midi_notes, dur, cutoff=3200, detune=0.14, voices=5):
    n = int(dur * SR)
    out = np.zeros(n)
    for m in midi_notes:
        for v in range(voices):
            cents = (v - (voices - 1) / 2) * detune * 100 / ((voices - 1) / 2)
            out += saw(hz(m) * 2 ** (cents / 1200), n, rng.random())
    out /= len(midi_notes) * voices
    return lp(out, cutoff)


def pluck(midi, dur=0.18, cutoff=5000):
    n = int(dur * SR)
    tone = saw(hz(midi), n) * 0.6 + saw(hz(midi) * 1.004, n, 0.3) * 0.4
    return lp(tone, cutoff) * env(n, 0.001, dur * 0.55, 5)


def bass_note(midi, dur):
    n = int(dur * SR)
    tone = saw(hz(midi), n) * 0.7 + np.sin(2 * np.pi * hz(midi) * np.arange(n) / SR) * 0.6
    return lp(tone, 900) * env(n, 0.003, dur * 0.9, 2.2)


def riser(dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    steps = 24
    for s in range(steps):
        a, b = s * n // steps, (s + 1) * n // steps
        lo = 300 + 6000 * (s / steps) ** 2
        seg = bp(noise[a:b], lo, min(lo * 2.2, 20000))
        out[a:b] = seg
    return out * (t / dur) ** 2 * 0.5


def whoosh(dur=0.5):
    n = int(dur * SR)
    t = np.arange(n) / SR
    shape = np.sin(np.pi * t / dur) ** 2
    return bp(rng.standard_normal(n), 600, 6000) * shape * 0.28


def impact():
    n = int(1.6 * SR)
    t = np.arange(n) / SR
    sub = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-t * 6)) / SR) * env(n, 0.002, 1.2, 3)
    crash = hp(rng.standard_normal(n), 2500) * env(n, 0.001, 0.9, 4) * 0.35
    return np.tanh((sub * 1.1 + crash) * 1.3)


def chime():
    n = int(1.2 * SR)
    t = np.arange(n) / SR
    tone = sum(np.sin(2 * np.pi * f * t) * a for f, a in [(1318.5, 1), (1975.5, 0.5), (2637, 0.25)])
    return tone * env(n, 0.001, 0.6, 5) * 0.22


def typing_click():
    n = int(0.02 * SR)
    return bp(rng.standard_normal(n), 1500, 7000) * env(n, 0.0003, 0.006, 6) * 0.3


# --- arrangement -----------------------------------------------------------------
# A minor: Am - F - C - G, one chord a bar.
CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
ROOTS = [45, 41, 36, 43]

drums, bass, keys, lead, fx = empty(), empty(), empty(), empty(), empty()
K, C = kick(), clap()

# Scenes and their bars (kept in sync with ad.html):
DROP = 4           # brand reveal
BREAK = (15, 17)   # email typing: half-time breakdown
CHIME_BAR = 17     # the alert arrives
END_HIT = 22       # call to action
LAST = 24          # last groove bar

for bar in range(BARS):
    chord = CHORDS[bar % 4]
    root = ROOTS[bar % 4]
    start = t_of(bar)
    if bar < 2:
        # Intro: ticking clock and a filtered pad.
        for b8 in range(8):
            place(drums, start + b8 * BEAT / 2, tick(), 1.0 if b8 % 2 == 0 else 0.6)
        place(keys, start, supersaw(chord, BAR, cutoff=900) * env(int(BAR * SR), 0.4, BAR, 0.8), 0.5)
    elif bar < DROP:
        # Build: kick on the beat, snare roll speeding up, riser.
        for b in range(4):
            place(drums, start + b * BEAT, K, 0.55)
        per = 4 if bar == 2 else 8
        for s in range(per * 2 if bar == 3 else per):
            step = BAR / (per * 2 if bar == 3 else per)
            place(drums, start + s * step, C, 0.25 + 0.5 * s / (per * 2))
        place(keys, start, supersaw(chord, BAR, cutoff=1200 + 1800 * (bar - 2)), 0.45)
        if bar == 2:
            place(fx, start, riser(2 * BAR - BEAT), 1.0)
    elif BREAK[0] <= bar < BREAK[1]:
        # Breakdown under the typing: half-time, pads and soft kick.
        place(drums, start, K, 0.7)
        place(drums, start + 2 * BEAT, C, 0.5)
        place(keys, start, supersaw(chord, BAR, cutoff=2200) * env(int(BAR * SR), 0.05, BAR, 1.2), 0.5)
        for i in range(16):
            place(fx, start + i * BEAT / 4 + (0.02 if i % 3 else 0), typing_click(), 1.0 if i % 2 == 0 else 0.6)
        if bar == BREAK[1] - 1:
            place(fx, start + 2 * BEAT, riser(2 * BEAT), 0.8)
    elif bar <= LAST:
        # Main groove.
        for b in range(4):
            place(drums, start + b * BEAT, K, 1.0)
            place(drums, start + b * BEAT + BEAT / 2, hat(open_=True), 0.8)
            for s in (0.25, 0.75):
                place(drums, start + b * BEAT + s * BEAT, hat(), 0.5)
            if b in (1, 3):
                place(drums, start + b * BEAT, C, 0.9)
        # Bass: offbeat eighths, ducked by the kick below.
        for e in range(8):
            place(bass, start + e * BEAT / 2, bass_note(root + (12 if e % 4 == 3 else 0), BEAT / 2), 0.9)
        # Chord stabs on the offbeats, and a pad.
        for b in range(4):
            place(keys, start + b * BEAT + BEAT / 2, supersaw([n + 12 for n in chord], BEAT / 2, cutoff=4200) * env(int(BEAT / 2 * SR), 0.002, 0.2, 5), 0.8)
        place(keys, start, supersaw(chord, BAR, cutoff=1800), 0.25)
        # Arp: chord tones in sixteenths, an octave up.
        tones = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[1] + 24]
        for s in range(16):
            place(lead, start + s * BEAT / 4, pluck(tones[s % 4] + (12 if s % 8 == 7 else 0)), 0.35)
    # Whooshes into each scene cut.
    if bar in (6, 9, 12, 15, 19, 21):
        place(fx, start - 0.45, whoosh(0.5), 1.0)

for bar in (DROP, CHIME_BAR, END_HIT):
    place(fx, t_of(bar), impact(), 0.9 if bar != CHIME_BAR else 0.55)
place(fx, t_of(CHIME_BAR), chime(), 1.0)
place(fx, t_of(CHIME_BAR, 0.5), chime(), 0.6)
# The final chord rings out after the groove.
place(keys, t_of(LAST + 1), supersaw(CHORDS[0], 2.2, cutoff=2600) * env(int(2.2 * SR), 0.005, 2.0, 2.5), 0.7)
place(fx, t_of(LAST + 1), impact(), 0.8)

# Sidechain: the kick ducks bass, keys and lead from the drop on.
duck = np.ones(N)
for bar in range(DROP, LAST + 1):
    if BREAK[0] <= bar < BREAK[1]:
        continue
    for b in range(4):
        i = int(t_of(bar, b) * SR)
        n = int(BEAT * SR)
        curve = 1 - 0.65 * np.exp(-np.arange(n) / SR * 14)
        duck[i:i + n] = np.minimum(duck[i:i + n], curve[: len(duck[i:i + n])])

mix = drums * 0.9 + (bass * 0.8 + keys * 0.7 + lead * 0.6) * duck + fx
# The silence before the drop.
gap = (np.arange(N) / SR >= t_of(DROP) - BEAT * 0.5) & (np.arange(N) / SR < t_of(DROP))
mix[gap] *= 0.08
# Master: gentle tilt, soft clip, fade, normalise to -1 dBFS; slight stereo width from the arp and hats.
mix = hp(mix, 30)
left = np.tanh(mix * 1.2 + lead * 0.08 * duck)
right = np.tanh(mix * 1.2 - lead * 0.08 * duck)
fade = np.ones(N)
tail = int(1.2 * SR)
fade[-tail:] = np.linspace(1, 0, tail) ** 2
stereo = np.stack([left * fade, right * fade], axis=1)
stereo /= np.max(np.abs(stereo)) / 10 ** (-1 / 20)

import wave

OUT = Path(__file__).parent / 'out'
OUT.mkdir(exist_ok=True)
with wave.open(str(OUT / 'music.wav'), 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((stereo * 32767).astype('<i2').tobytes())
json.dump({'bpm': BPM, 'beat': BEAT, 'bar': BAR, 'bars': BARS, 'length': LENGTH, 'drop': DROP, 'chime': CHIME_BAR, 'endHit': END_HIT}, open(OUT / 'music.json', 'w'))
print(f'music: {LENGTH:.2f} s, {BARS} bars at {BPM} BPM')
