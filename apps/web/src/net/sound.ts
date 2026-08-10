/**
 * Sound effects, synthesised.
 *
 * Nothing is loaded from disk: every one of these is broadband noise shaped
 * by an envelope and a sweeping filter, which the Web Audio API can build in
 * a few lines. Paper is noise — a page turning, a card sliding off a deck and
 * a riffle differ in how long the noise is, how bright, and how many of them
 * there are, which is why one `rush` builds all three.
 *
 * That keeps the client free of binary audio assets, makes each effect
 * tweakable by reading it rather than by opening an editor, and sidesteps
 * licensing a recording.
 *
 * Browsers refuse to start audio outside a user gesture, so the context is
 * created on the first play — which is always a click — and resumed if the
 * browser suspended it since.
 *
 * Mute and volume are stored, so both survive a reload. Settings exposes them.
 */

const MUTED_KEY = 'berserk:muted';
const VOLUME_KEY = 'berserk:volume';

let context: AudioContext | null = null;
/**
 * Everything plays through one gain node, which is what makes a volume
 * control possible at all: the effects each build their own envelope, and
 * scaling those individually would mean every one of them knowing about a
 * setting that is none of its business.
 */
let master: GainNode | null = null;

export const isMuted = (): boolean => localStorage.getItem(MUTED_KEY) === '1';

export function setMuted(muted: boolean): void {
  if (muted) localStorage.setItem(MUTED_KEY, '1');
  else localStorage.removeItem(MUTED_KEY);
}

/** 0 to 1. Defaults to most of the way up rather than to full. */
export function volume(): number {
  const stored = Number(localStorage.getItem(VOLUME_KEY));
  return Number.isFinite(stored) && stored >= 0 && stored <= 1 ? stored : 0.7;
}

export function setVolume(level: number): void {
  const clamped = Math.min(1, Math.max(0, level));
  localStorage.setItem(VOLUME_KEY, String(clamped));
  // Applied live, so dragging the slider is audible while a sound is playing
  // rather than only from the next one.
  if (master && context) master.gain.setTargetAtTime(clamped, context.currentTime, 0.01);
}

/**
 * The node everything connects to, or null if there is no sound to be had.
 * Muting reports null, which stops each effect before it builds anything.
 */
function output(): { ctx: AudioContext; out: GainNode } | null {
  if (isMuted()) return null;
  try {
    context ??= new AudioContext();
    // Autoplay policy suspends contexts made before the first gesture.
    if (context.state === 'suspended') void context.resume();
    if (!master) {
      master = context.createGain();
      master.connect(context.destination);
    }
    master.gain.value = volume();
    return { ctx: context, out: master };
  } catch {
    // No Web Audio: silence is a fine outcome, a crash is not.
    return null;
  }
}

/** Kept for the effects below, which only ever wanted the context. */
function audio(): AudioContext | null {
  return output()?.ctx ?? null;
}

/** A buffer of white noise, `seconds` long. */
function noise(ctx: AudioContext, seconds: number): AudioBuffer {
  const frames = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * One rush of air past paper: noise through a band-pass that sweeps up and
 * back down, which is what gives a flip its "whoosh" rather than a hiss.
 */
function rush(
  ctx: AudioContext,
  at: number,
  duration: number,
  peak: number,
  fromHz: number,
  toHz: number,
): void {
  const source = ctx.createBufferSource();
  source.buffer = noise(ctx, duration);

  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 0.7;
  band.frequency.setValueAtTime(fromHz, at);
  band.frequency.exponentialRampToValueAtTime(toHz, at + duration * 0.45);
  band.frequency.exponentialRampToValueAtTime(fromHz * 0.7, at + duration);

  const gain = ctx.createGain();
  // Quick swell, longer fall — paper accelerates then settles.
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + duration * 0.28);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

  source
    .connect(band)
    .connect(gain)
    .connect(master ?? ctx.destination);
  source.start(at);
  source.stop(at + duration);
}

/**
 * A page turning: the sweep of the sheet, then the softer flutter of it
 * settling a moment later. Two rushes rather than one — a single burst reads
 * as static, and it is the second, quieter one that makes it paper.
 */
export function playPageTurn(): void {
  const ctx = audio();
  if (!ctx) return;

  const now = ctx.currentTime;
  rush(ctx, now, 0.42, 0.16, 620, 2600);
  rush(ctx, now + 0.2, 0.3, 0.06, 900, 1700);
}

/** One card sliding off the deck: short, bright, and gone. */
function card(ctx: AudioContext, at: number, peak = 0.1): void {
  rush(ctx, at, 0.13, peak, 1500, 3800);
}

/**
 * Drawing. One card is one sound; a handful is dealt as a quick run rather
 * than seven sounds landing on top of each other, which is what an opening
 * hand would otherwise be.
 */
export function playDraw(count = 1): void {
  const ctx = audio();
  if (!ctx) return;

  const now = ctx.currentTime;
  if (count <= 2) {
    for (let i = 0; i < count; i++) card(ctx, now + i * 0.09);
    return;
  }
  // Deal: quick, and quieter per card so a full hand is not seven times loud.
  for (let i = 0; i < Math.min(count, 8); i++) card(ctx, now + i * 0.055, 0.06);
}

/**
 * Shuffling: a riffle, which is many small snaps in quick succession rather
 * than one long noise. The gaps shorten through it, the way a real riffle
 * accelerates and then runs out.
 */
export function playShuffle(): void {
  const ctx = audio();
  if (!ctx) return;

  const now = ctx.currentTime;
  const ticks = 18;
  let at = 0;
  for (let i = 0; i < ticks; i++) {
    const progress = i / (ticks - 1);
    rush(ctx, now + at, 0.05, 0.05 + 0.03 * (1 - progress), 1800, 5200);
    // Starts loose, tightens, then trails off.
    at += 0.05 - 0.022 * Math.sin(progress * Math.PI);
  }
}

/**
 * A struck metal tone: a sine that starts sharp and rings away.
 *
 * The counterpart to `rush`. Paper is noise, but a coin and a blade are
 * *pitched* — they ring — so noise through a filter can never be either.
 * `detune` adds a second partial slightly out of tune with the first, which
 * is what stops it sounding like a test tone: real metal is inharmonic, and
 * the beating between two close partials is most of that character.
 */
function ring(
  ctx: AudioContext,
  at: number,
  hz: number,
  duration: number,
  peak: number,
  detune = 1.0,
): void {
  for (const [multiple, share] of [
    [1, 1],
    [detune, 0.6],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(hz * multiple, at);

    const gain = ctx.createGain();
    // Struck, not blown: full amplitude almost immediately, then a long decay.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak * share, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    osc.connect(gain).connect(master ?? ctx.destination);
    osc.start(at);
    osc.stop(at + duration);
  }
}

/**
 * The toss for first player. Rules.md §9.2.
 *
 * Three parts, matching what `CoinFlip.tsx` draws: the thumb-flick that sends
 * it up, a thin shimmer while it spins, and the ring as it lands. The spin
 * timing is deliberately tied to the component's own — see `SPIN_MS` there —
 * so the landing ring arrives with the coin settling rather than over it.
 *
 * `spinMs` of 0 is the reduced-motion path: there is no spin to score, so it
 * plays the flick and the landing together.
 */
export function playCoinFlip(spinMs = 1700): void {
  const ctx = audio();
  if (!ctx) return;

  const now = ctx.currentTime;
  const spin = spinMs / 1000;

  // The flick: a short, bright chime as it leaves the hand.
  ring(ctx, now, 1180, 0.5, 0.09, 2.02);

  if (spin > 0.2) {
    // Tumbling: faint taps thinning out as it slows, so the ear hears the
    // arc rather than a held note. Quiet enough to sit under the flick's tail.
    const taps = 7;
    for (let i = 0; i < taps; i++) {
      const progress = i / (taps - 1);
      // Eased so the gaps widen towards the top of the arc.
      const at = now + 0.16 + spin * 0.78 * (progress * progress * 0.7 + progress * 0.3);
      ring(ctx, at, 2200 + 260 * Math.sin(progress * Math.PI), 0.1, 0.022, 1.48);
    }
  }

  // Landing: lower, louder and long, because this is the answer.
  const lands = now + Math.max(0.22, spin);
  ring(ctx, lands, 660, 1.5, 0.13, 1.995);
  ring(ctx, lands + 0.02, 990, 0.9, 0.05, 2.01);
  // A touch of noise on the strike, so it lands on a surface rather than in air.
  rush(ctx, lands, 0.09, 0.05, 2400, 5600);
}

/**
 * A blade drawn: the "schwing" when a battle is declared. Rules.md §11.
 *
 * Steel leaving a scabbard is a rising scrape that turns into a ring — so it
 * is a bright noise sweep for the draw and a struck tone for the edge coming
 * free, the second arriving just before the first has finished. Pitched high
 * and kept short: it punctuates the declaration rather than playing over it.
 */
export function playSchwing(): void {
  const ctx = audio();
  if (!ctx) return;

  const now = ctx.currentTime;
  // The scrape up the scabbard.
  rush(ctx, now, 0.3, 0.11, 1800, 7200);
  // The edge coming free and ringing, overlapping the tail of the scrape.
  ring(ctx, now + 0.16, 1560, 0.85, 0.085, 2.03);
  ring(ctx, now + 0.175, 2340, 0.5, 0.035, 1.99);
}

/**
 * A phase going by: one long, soft sweep of air.
 *
 * Darker and slower than a card — a phase is the turn moving rather than
 * anything landing on the table, so it wants breadth instead of a snap. It
 * plays once per phase the banner walks through, which is what makes a turn
 * that skips three of them audibly a turn that skipped three of them.
 */
export function playPhase(): void {
  const ctx = audio();
  if (!ctx) return;

  const now = ctx.currentTime;
  rush(ctx, now, 0.46, 0.075, 320, 1400);
  // A second, quieter tail a beat behind, so it settles rather than stops.
  rush(ctx, now + 0.13, 0.34, 0.03, 480, 950);
}
