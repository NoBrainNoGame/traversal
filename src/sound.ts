// Sound effects, all synthesized with Web Audio (no audio files): piece motions, interface, a muffled bell when
// it's the player's turn, and a bugle call at the end of the game.

const MUTE_KEY = "traversal-muted"
const MASTER = 0.55

/** Something a piece does during its motion, at the moment it happens (see motion.ts) */
export type Cue =
  | { name: "curl" | "leap" | "crush" | "hop" | "land" | "bleat" | "charge" | "horns" | "step" | "thrust" | "fall" | "exit" }
  | { name: "roll"; duration: number }

export type UiSound = "select" | "tick" | "error" | "chat" | "notify" | "turn" | "victory" | "defeat"

const NOTES: Record<string, number> = { G4: 392, C5: 523.25, E5: 659.25, G5: 783.99, C6: 1046.5, E6: 1318.5, G6: 1568, C7: 2093, A4: 440, Eb5: 622.25, D5: 587.33, Bb4: 466.16 }

/** Reveille on the bugle's natural notes */
const REVEILLE: [string, number][] = [
  ["G4", 0.13], ["C5", 0.13], ["E5", 0.13], ["C5", 0.13],
  ["G4", 0.13], ["C5", 0.13], ["E5", 0.13], ["C5", 0.13],
  ["G4", 0.13], ["C5", 0.13], ["E5", 0.13], ["C5", 0.13],
  ["E5", 0.26], ["G5", 0.62],
]

/** The opening of Taps, slow and solemn */
const TAPS: [string, number][] = [
  ["G4", 0.45], ["G4", 0.15], ["C5", 0.9],
  ["G4", 0.45], ["C5", 0.15], ["E5", 1.1],
]

function storedMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === "1"
  } catch {
    return false
  }
}

export class Sound extends EventTarget {
  muted = storedMuted()
  private ctx: AudioContext | null = null
  private out: GainNode | null = null
  /** Send to a short outdoor reverb, for the brass */
  private wet: GainNode | null = null
  private noise: AudioBuffer | null = null

  constructor() {
    super()
    // Browsers only start audio after a user gesture
    const unlock = () => void this.context()?.resume()
    addEventListener("pointerdown", unlock)
    addEventListener("keydown", unlock)
  }

  toggleMute() {
    this.muted = !this.muted
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? "1" : "0")
    } catch {}
    this.dispatchEvent(new Event("change"))
  }

  cue(cue: Cue) {
    const c = this.ready()
    if (!c) return
    const t = c.currentTime
    switch (cue.name) {
      case "curl":
        return this.whoosh(t, 500, 1800, 0.18, 0.6)
      case "roll":
        return this.rumble(t, cue.duration)
      case "leap":
        return this.whoosh(t, 400, 2600, 0.35, 0.8)
      case "crush":
        this.thud(t, 140, 0.45, 1)
        return this.crunch(t + 0.02, 0.5)
      case "hop":
        return this.sweep(t, "sine", 260, 520, 0.12, 0.25)
      case "land":
        return this.clop(t, 0.35)
      case "bleat":
        return this.bleat(t)
      case "charge":
        for (let i = 0; i < 4; i++) this.clop(t + i * 0.05, 0.3)
        return
      case "horns":
        this.thud(t, 110, 0.3, 0.8)
        return this.crunch(t, 0.3)
      case "step":
        this.thud(t, 90, 0.08, 0.35)
        return this.jingle(t, 0.05)
      case "thrust":
        this.whoosh(t, 900, 3000, 0.12, 0.3)
        return this.metal(t + 0.08, 0.35)
      case "fall":
        this.thud(t, 80, 0.35, 0.7)
        return this.jingle(t + 0.03, 0.18)
      case "exit":
        return this.chime(t, ["C6", "E6", "G6", "C7"], 0.07, 0.25)
    }
  }

  ui(sound: UiSound) {
    const c = this.ready()
    if (!c) return
    const t = c.currentTime
    switch (sound) {
      case "select":
        return this.sweep(t, "sine", 700, 980, 0.06, 0.18)
      case "tick":
        return this.sweep(t, "triangle", 1500, 1500, 0.025, 0.05)
      case "error":
        this.sweep(t, "square", 150, 140, 0.09, 0.15)
        return this.sweep(t + 0.12, "square", 120, 110, 0.12, 0.15)
      case "chat":
        return this.sweep(t, "sine", 620, 930, 0.07, 0.15)
      case "notify":
        this.sweep(t, "triangle", 660, 660, 0.12, 0.2)
        return this.sweep(t + 0.14, "triangle", 880, 880, 0.18, 0.2)
      case "turn":
        return this.bell(t)
      case "victory":
        return this.melody(t, REVEILLE)
      case "defeat":
        return this.melody(t, TAPS, 0.25)
    }
  }

  private context() {
    if (this.ctx) return this.ctx
    try {
      this.ctx = new AudioContext()
    } catch {
      return null
    }
    const c = this.ctx
    this.out = c.createGain()
    this.out.gain.value = MASTER
    this.out.connect(c.destination)
    // Echo of a morning valley: decaying noise as the impulse response
    const reverb = c.createConvolver()
    const length = Math.floor(c.sampleRate * 1.6)
    const impulse = c.createBuffer(2, length, c.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch)
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3)
    }
    reverb.buffer = impulse
    this.wet = c.createGain()
    this.wet.gain.value = 0.3
    this.wet.connect(reverb).connect(this.out)
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    return c
  }

  private ready() {
    if (this.muted) return null
    const c = this.context()
    return c?.state === "running" ? c : null
  }

  // ---------------------------------------------------------------- building blocks

  /** A gain envelope: quick attack, exponential decay */
  private envelope(t: number, peak: number, attack: number, decay: number) {
    const g = this.ctx!.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(peak, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    g.connect(this.out!)
    return g
  }

  private noiseSource(t: number, duration: number) {
    const src = this.ctx!.createBufferSource()
    src.buffer = this.noise
    src.loop = true
    src.start(t, Math.random() * 0.5)
    src.stop(t + duration)
    return src
  }

  private sweep(t: number, type: OscillatorType, from: number, to: number, duration: number, gain: number) {
    const osc = this.ctx!.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(from, t)
    osc.frequency.exponentialRampToValueAtTime(to, t + duration)
    osc.connect(this.envelope(t, gain, 0.005, duration))
    osc.start(t)
    osc.stop(t + duration + 0.05)
  }

  private whoosh(t: number, from: number, to: number, duration: number, gain: number) {
    const filter = this.ctx!.createBiquadFilter()
    filter.type = "bandpass"
    filter.Q.value = 1.2
    filter.frequency.setValueAtTime(from, t)
    filter.frequency.exponentialRampToValueAtTime(to, t + duration)
    this.noiseSource(t, duration + 0.1).connect(filter).connect(this.envelope(t, gain, duration * 0.6, duration * 0.5))
  }

  /** Low body hit */
  private thud(t: number, freq: number, duration: number, gain: number) {
    const osc = this.ctx!.createOscillator()
    osc.frequency.setValueAtTime(freq, t)
    osc.frequency.exponentialRampToValueAtTime(freq * 0.35, t + duration)
    osc.connect(this.envelope(t, gain, 0.004, duration))
    osc.start(t)
    osc.stop(t + duration + 0.05)
    const filter = this.ctx!.createBiquadFilter()
    filter.type = "lowpass"
    filter.frequency.value = 400
    this.noiseSource(t, 0.1).connect(filter).connect(this.envelope(t, gain * 0.6, 0.002, 0.08))
  }

  private crunch(t: number, gain: number) {
    const filter = this.ctx!.createBiquadFilter()
    filter.type = "bandpass"
    filter.frequency.value = 1600
    filter.Q.value = 0.8
    const shaper = this.ctx!.createWaveShaper()
    const curve = new Float32Array(256)
    for (let i = 0; i < 256; i++) curve[i] = Math.tanh(((i / 255) * 2 - 1) * 6)
    shaper.curve = curve
    this.noiseSource(t, 0.25).connect(shaper).connect(filter).connect(this.envelope(t, gain, 0.003, 0.2))
  }

  /** A hoof on stone */
  private clop(t: number, gain: number) {
    this.sweep(t, "sine", 950 + Math.random() * 150, 600, 0.05, gain)
    const filter = this.ctx!.createBiquadFilter()
    filter.type = "bandpass"
    filter.frequency.value = 2500
    this.noiseSource(t, 0.04).connect(filter).connect(this.envelope(t, gain * 0.7, 0.001, 0.03))
  }

  /** The goat */
  private bleat(t: number) {
    const c = this.ctx!
    const osc = c.createOscillator()
    osc.type = "sawtooth"
    osc.frequency.setValueAtTime(520, t)
    osc.frequency.linearRampToValueAtTime(470, t + 0.38)
    // The bleat's wobble
    const lfo = c.createOscillator()
    lfo.frequency.value = 26
    const depth = c.createGain()
    depth.gain.value = 0.5
    const am = c.createGain()
    am.gain.value = 0.5
    lfo.connect(depth).connect(am.gain)
    const formant = c.createBiquadFilter()
    formant.type = "bandpass"
    formant.frequency.value = 1300
    formant.Q.value = 2.5
    osc.connect(am).connect(formant).connect(this.envelope(t, 1.1, 0.03, 0.38))
    for (const node of [osc, lfo]) {
      node.start(t)
      node.stop(t + 0.5)
    }
  }

  /** The spiked ball rattling along */
  private rumble(t: number, duration: number) {
    const c = this.ctx!
    const filter = c.createBiquadFilter()
    filter.type = "lowpass"
    filter.frequency.value = 260
    const rattle = c.createGain()
    rattle.gain.value = 0.6
    const lfo = c.createOscillator()
    lfo.frequency.value = 16
    const depth = c.createGain()
    depth.gain.value = 0.4
    lfo.connect(depth).connect(rattle.gain)
    lfo.start(t)
    lfo.stop(t + duration + 0.1)
    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(1.6, t + 0.08)
    g.gain.setValueAtTime(1.6, t + Math.max(duration - 0.1, 0.08))
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.05)
    g.connect(this.out!)
    this.noiseSource(t, duration + 0.1).connect(filter).connect(rattle).connect(g)
  }

  /** Armour clinking */
  private jingle(t: number, gain: number) {
    for (let i = 0; i < 3; i++) this.sweep(t + i * 0.015, "sine", 3000 + Math.random() * 2500, 2800, 0.06, gain * 0.4)
  }

  /** Steel ringing */
  private metal(t: number, gain: number) {
    for (const f of [2100, 3370, 5230]) this.sweep(t, "sine", f, f * 0.99, 0.45, gain / 3)
  }

  private chime(t: number, notes: string[], spacing: number, gain: number) {
    notes.forEach((note, i) => {
      const osc = this.ctx!.createOscillator()
      osc.type = "triangle"
      osc.frequency.value = NOTES[note]
      const env = this.envelope(t + i * spacing, gain, 0.005, 0.6)
      env.connect(this.wet!)
      osc.connect(env)
      osc.start(t + i * spacing)
      osc.stop(t + i * spacing + 0.7)
    })
  }

  /** A small bell struck once, muffled: inharmonic partials ringing out under a low-pass filter */
  private bell(t: number) {
    const c = this.ctx!
    const muffle = c.createBiquadFilter()
    muffle.type = "lowpass"
    muffle.frequency.value = 1400
    muffle.Q.value = 0.5
    const out = c.createGain()
    out.gain.value = 0.6
    muffle.connect(out)
    out.connect(this.out!)
    out.connect(this.wet!)
    const base = 587.33
    // Hum, fundamental, minor third, fifth, octave and up: the higher, the quieter and shorter
    for (const [ratio, gain, decay] of [
      [0.5, 0.25, 2.2],
      [1, 0.5, 1.8],
      [1.19, 0.2, 1.3],
      [1.5, 0.15, 1.1],
      [2, 0.18, 0.9],
      [2.74, 0.08, 0.6],
    ]) {
      const osc = c.createOscillator()
      osc.frequency.value = base * ratio
      const env = c.createGain()
      env.gain.setValueAtTime(0.0001, t)
      env.gain.exponentialRampToValueAtTime(gain, t + 0.004)
      env.gain.exponentialRampToValueAtTime(0.0001, t + decay)
      osc.connect(env).connect(muffle)
      osc.start(t)
      osc.stop(t + decay + 0.05)
    }
    // The clapper's soft knock
    const knock = c.createBiquadFilter()
    knock.type = "bandpass"
    knock.frequency.value = 900
    this.noiseSource(t, 0.03).connect(knock).connect(this.envelope(t, 0.15, 0.001, 0.025))
  }

  /** Notes played on a bugle: two detuned saws through a filter that opens on each note's attack, a bit of breath */
  private melody(t: number, notes: [string, number][], gain = 0.3) {
    const c = this.ctx!
    let at = t
    for (const [note, length] of notes) {
      const f = NOTES[note]
      const filter = c.createBiquadFilter()
      filter.type = "lowpass"
      filter.Q.value = 3
      filter.frequency.setValueAtTime(f * 1.2, at)
      filter.frequency.exponentialRampToValueAtTime(f * 6, at + 0.04)
      filter.frequency.exponentialRampToValueAtTime(f * 3.5, at + length)
      const g = c.createGain()
      const end = at + length * 0.92
      g.gain.setValueAtTime(0.0001, at)
      g.gain.exponentialRampToValueAtTime(gain, at + 0.025)
      g.gain.setValueAtTime(gain * 0.85, end - 0.03)
      g.gain.exponentialRampToValueAtTime(0.0001, end + 0.05)
      g.connect(this.out!)
      g.connect(this.wet!)
      filter.connect(g)
      for (const detune of [-4, 4]) {
        const osc = c.createOscillator()
        osc.type = "sawtooth"
        osc.frequency.value = f
        osc.detune.value = detune
        // Vibrato on the long notes
        if (length > 0.3) {
          const lfo = c.createOscillator()
          lfo.frequency.value = 5.5
          const depth = c.createGain()
          depth.gain.setValueAtTime(0, at)
          depth.gain.linearRampToValueAtTime(7, at + length)
          lfo.connect(depth).connect(osc.detune)
          lfo.start(at)
          lfo.stop(end + 0.1)
        }
        osc.connect(filter)
        osc.start(at)
        osc.stop(end + 0.1)
      }
      const breath = c.createBiquadFilter()
      breath.type = "highpass"
      breath.frequency.value = 2500
      this.noiseSource(at, 0.06).connect(breath).connect(this.envelope(at, gain * 0.15, 0.005, 0.05))
      at += length
    }
  }
}
