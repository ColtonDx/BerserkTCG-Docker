import { useEffect, useRef, type JSX } from 'react';

/**
 * Drifting embers and ash over the lobby background.
 *
 * Canvas rather than DOM nodes: a few dozen animated elements are cheap here
 * but cost layout and paint work as `<div>`s. Purely decorative, so it is
 * `aria-hidden`, sits behind everything via CSS, and stops entirely when the
 * viewer prefers reduced motion or the tab is hidden.
 */

interface Particle {
  x: number;
  y: number;
  /** Horizontal drift, px/sec. */
  vx: number;
  /** Vertical velocity, px/sec. Negative rises. */
  vy: number;
  radius: number;
  /** Base opacity before the flicker is applied. */
  alpha: number;
  /** Radians/sec through the flicker cycle. */
  flickerRate: number;
  flickerPhase: number;
  kind: 'ember' | 'ash';
}

/** Warm reds picked to sit against the wallpaper's Brand. */
const EMBER_COLORS = ['255, 61, 47', '216, 16, 32', '255, 138, 61'] as const;
const ASH_COLOR = '226, 226, 226';

/** One particle per this many px² of viewport, so density scales with size. */
const AREA_PER_PARTICLE = 34_000;
const MIN_PARTICLES = 14;
const MAX_PARTICLES = 60;

export function Embers(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let particles: Particle[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let lastTime = 0;

    const random = (min: number, max: number): number => min + Math.random() * (max - min);

    function spawn(atBottom: boolean): Particle {
      // Roughly one in four is drifting ash rather than a rising ember.
      const kind: Particle['kind'] = Math.random() < 0.25 ? 'ash' : 'ember';
      const rising = kind === 'ember';

      return {
        x: random(0, width),
        y: atBottom ? random(height, height + 80) : random(0, height),
        vx: random(-9, 9),
        vy: rising ? random(-26, -9) : random(5, 14),
        radius: kind === 'ember' ? random(0.7, 1.9) : random(0.5, 1.3),
        alpha: kind === 'ember' ? random(0.35, 0.85) : random(0.12, 0.3),
        flickerRate: random(1.2, 3.4),
        flickerPhase: random(0, Math.PI * 2),
        kind,
      };
    }

    function resize(): void {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas!.clientWidth;
      height = canvas!.clientHeight;
      canvas!.width = Math.round(width * dpr);
      canvas!.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const target = Math.round((width * height) / AREA_PER_PARTICLE);
      const count = Math.max(MIN_PARTICLES, Math.min(MAX_PARTICLES, target));
      particles = Array.from({ length: count }, () => spawn(false));
    }

    function draw(time: number): void {
      // Delta-timed so the drift looks the same on 60Hz and 144Hz displays,
      // and clamped so a backgrounded tab doesn't teleport everything.
      const delta = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;

      ctx!.clearRect(0, 0, width, height);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i] as Particle;

        p.x += p.vx * delta;
        p.y += p.vy * delta;
        p.flickerPhase += p.flickerRate * delta;

        // Recycle once a particle leaves the viewport.
        const gone = p.vy < 0 ? p.y < -20 : p.y > height + 20;
        if (gone || p.x < -30 || p.x > width + 30) {
          particles[i] = spawn(p.vy < 0);
          continue;
        }

        const flicker = 0.65 + 0.35 * Math.sin(p.flickerPhase);
        const alpha = p.alpha * flicker;

        if (p.kind === 'ember') {
          const color = EMBER_COLORS[i % EMBER_COLORS.length] as string;
          // A soft halo sells the glow without a blur filter.
          const glow = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius * 4);
          glow.addColorStop(0, `rgba(${color}, ${alpha})`);
          glow.addColorStop(1, `rgba(${color}, 0)`);
          ctx!.fillStyle = glow;
          ctx!.beginPath();
          ctx!.arc(p.x, p.y, p.radius * 4, 0, Math.PI * 2);
          ctx!.fill();

          ctx!.fillStyle = `rgba(${color}, ${Math.min(1, alpha * 1.3)})`;
        } else {
          ctx!.fillStyle = `rgba(${ASH_COLOR}, ${alpha})`;
        }

        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx!.fill();
      }

      frame = requestAnimationFrame(draw);
    }

    function start(): void {
      if (frame || reduceMotion.matches || document.hidden) return;
      lastTime = performance.now();
      frame = requestAnimationFrame(draw);
    }

    function stop(): void {
      if (!frame) return;
      cancelAnimationFrame(frame);
      frame = 0;
    }

    function onVisibility(): void {
      if (document.hidden) stop();
      else start();
    }

    function onMotionPreference(): void {
      if (reduceMotion.matches) {
        stop();
        ctx!.clearRect(0, 0, width, height);
      } else {
        start();
      }
    }

    const observer = new ResizeObserver(() => resize());
    observer.observe(canvas);
    resize();
    start();

    document.addEventListener('visibilitychange', onVisibility);
    reduceMotion.addEventListener('change', onMotionPreference);

    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      reduceMotion.removeEventListener('change', onMotionPreference);
    };
  }, []);

  return <canvas ref={canvasRef} className="embers" aria-hidden="true" />;
}
