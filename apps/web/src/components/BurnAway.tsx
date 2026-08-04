import { useEffect, useRef, type JSX } from 'react';

/**
 * Burns a sheet of paper away to reveal whatever is behind it.
 *
 * Covers the viewport, then eats itself from one corner outward along a noise
 * field, leaving a glowing ember edge and a charred rim. Used when entering a
 * match, so the menu appears to burn off the board.
 *
 * Drawn on a canvas at reduced resolution and scaled up: a burn edge is
 * organic, so the softening is invisible, and it keeps a full-screen
 * per-pixel effect cheap. Skipped entirely for anyone who prefers reduced
 * motion — they get the result without the animation.
 */

/** How long the burn takes, in milliseconds. */
const DURATION = 1875;
/** Canvas is this fraction of the viewport; upscaled by CSS. */
const SCALE = 0.34;
/** Width of the glowing edge, in noise units. */
const EMBER = 0.055;
/** Width of the charred band just ahead of the ember. */
const CHAR = 0.05;

interface Props {
  readonly onDone: () => void;
}

/** Deterministic value noise, smoothed and layered. */
function noiseField(width: number, height: number): Float32Array {
  const field = new Float32Array(width * height);

  // Cheap integer hash; the same lattice point always gives the same value.
  const hash = (x: number, y: number): number => {
    let h = x * 374761393 + y * 668265263;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };

  const smooth = (t: number): number => t * t * (3 - 2 * t);

  const octave = (cells: number, weight: number): void => {
    const step = Math.max(width, height) / cells;
    for (let y = 0; y < height; y++) {
      const gy = y / step;
      const y0 = Math.floor(gy);
      const fy = smooth(gy - y0);
      for (let x = 0; x < width; x++) {
        const gx = x / step;
        const x0 = Math.floor(gx);
        const fx = smooth(gx - x0);
        const top = hash(x0, y0) * (1 - fx) + hash(x0 + 1, y0) * fx;
        const bottom = hash(x0, y0 + 1) * (1 - fx) + hash(x0 + 1, y0 + 1) * fx;
        const i = y * width + x;
        field[i] = (field[i] as number) + (top * (1 - fy) + bottom * fy) * weight;
      }
    }
  };

  octave(6, 0.55);
  octave(14, 0.28);
  octave(34, 0.17);

  // Bias by distance from the top-left so the burn sweeps rather than
  // dissolving everywhere at once.
  const diagonal = width + height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      field[i] = (field[i] as number) * 0.62 + ((x + y) / diagonal) * 0.38;
    }
  }
  return field;
}

export function BurnAway({ onDone }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const done = (): void => {
      if (finished.current) return;
      finished.current = true;
      onDone();
    };

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      done();
      return;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      done();
      return;
    }

    const width = Math.max(1, Math.round(window.innerWidth * SCALE));
    const height = Math.max(1, Math.round(window.innerHeight * SCALE));
    canvas.width = width;
    canvas.height = height;

    const field = noiseField(width, height);

    // Fine per-pixel grain. Shading the paper with the burn noise instead
    // makes it look like mottled leather; paper wants high-frequency speckle.
    const grain = new Uint8Array(field.length);
    for (let i = 0; i < grain.length; i++) grain[i] = Math.random() * 14;
    const image = context.createImageData(width, height);
    const pixels = image.data;

    let frame = 0;
    const started = performance.now();

    const draw = (now: number): void => {
      // Run past 1 so the last embers finish burning off the screen.
      const progress = ((now - started) / DURATION) * (1 + EMBER + CHAR);

      for (let i = 0; i < field.length; i++) {
        const n = field[i] as number;
        const offset = i * 4;

        if (n < progress - EMBER) {
          // Burned through.
          pixels[offset + 3] = 0;
          continue;
        }

        if (n < progress) {
          // The ember edge: white-hot at the burn line, deep red behind it.
          const heat = 1 - (progress - n) / EMBER;
          pixels[offset] = 255;
          pixels[offset + 1] = Math.round(60 + 150 * heat);
          pixels[offset + 2] = Math.round(20 * heat);
          pixels[offset + 3] = 255;
          continue;
        }

        // The sheet is near-black rather than parchment: brown paper burning
        // off a wooden table read as a second, lighter table sliding away.
        // The grain still shows, so it is a sheet and not a blank fade, but
        // the drama is meant to be the ember edge, not the paper.
        const fibre = (grain[i] as number) * 0.55;
        const paper = { r: 13 + fibre, g: 12 + fibre, b: 12 + fibre };

        if (n < progress + CHAR) {
          // Scorched, darkening towards the flame.
          const scorch = 1 - (n - progress) / CHAR;
          pixels[offset] = Math.round(paper.r * (1 - scorch) + 26 * scorch);
          pixels[offset + 1] = Math.round(paper.g * (1 - scorch) + 14 * scorch);
          pixels[offset + 2] = Math.round(paper.b * (1 - scorch) + 10 * scorch);
          pixels[offset + 3] = 255;
          continue;
        }

        pixels[offset] = paper.r;
        pixels[offset + 1] = paper.g;
        pixels[offset + 2] = paper.b;
        pixels[offset + 3] = 255;
      }

      context.putImageData(image, 0, 0);

      if (progress >= 1 + EMBER + CHAR) {
        done();
        return;
      }
      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [onDone]);

  return <canvas ref={canvasRef} className="burn" aria-hidden="true" />;
}
