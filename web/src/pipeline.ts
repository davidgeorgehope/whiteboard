import type { CV } from "./opencv";

export interface Point {
  x: number;
  y: number;
}

/** Corners in tl, tr, br, bl order. */
export type Quad = [Point, Point, Point, Point];

const DETECT_WIDTH = 480;
// A whiteboard is landscape by convention; US Letter shape by default.
// Recovering the true aspect from the projected corners (Zhang & He) proved
// too noise-sensitive with a wide-angle webcam at oblique angles: the same
// sheet re-locked anywhere between 1.07 and 1.34.
export const PAPER_RATIO = 11 / 8.5;
// Candidates: any convex quad over 4% of the frame. The winner is chosen by
// paper-likeness score, not raw area, so a paper across a cluttered desk beats
// bigger but darker/tinted quads (desk mats, keyboards, monitors).
const MIN_AREA_RATIO = 0.04;
const MIN_BRIGHTNESS = 0.45;
// Live canvas displays at up to ~900 CSS px (1800+ device px on 2x); 1100
// source pixels upscale visibly soft, 1600 keeps the upscale factor near 1.
const MAX_OUTPUT_WIDTH = 1600;
// Whitening: each pixel is divided by a heavily blurred background estimate,
// which cancels shadows and uneven lighting. The contrast stretch is then
// anchored to the darkest ink actually present, so faint pencil/ballpoint
// survives. Both anchors come from the paper interior only: the warp border
// carries desk/edge pixels that would otherwise drag the ink anchor far below
// the real ink and leave faint strokes unstretched. Must comfortably exceed
// |WARP_INSET_RATIO| so the outset desk band never reaches the histogram.
const HIST_MARGIN_RATIO = 0.06;
// Negative = outset. Detection sometimes locks a hair inside the physical
// sheet (low-contrast edge, shadow) and an inset then slices writing near the
// paper border - losing real ink is worse than showing a thin band of desk.
// The desk band is cosmetic only: the contrast anchors come from the interior
// histogram, which HIST_MARGIN_RATIO keeps clear of this band.
const WARP_INSET_RATIO = -0.025;
const INK_PERCENTILE = 0.002;
const PAPER_PERCENTILE = 0.99;
// Ink-to-paper span below this is indistinguishable from sensor noise: treat
// the page as blank instead of stretching noise into speckle.
const MIN_INK_SPAN = 6;
// Map ink to a soft black rather than 0 so amplified noise stays subtle.
const INK_FLOOR = 15;
// After the stretch, snap near-white pixels to pure white: the stretch
// amplifies chroma noise into pastel speckle, but real ink lands far darker.
const WHITE_SNAP_FULL = 215;
const WHITE_SNAP_START = 150;
// Smooths the anchors across frames so the live pane doesn't flicker
// (flicker also inflates MotionDetector and would spam auto-beautify).
const LO_SMOOTHING = 0.25;

let smoothedLo: number | null = null;
let smoothedHi: number | null = null;

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function orderCorners(pts: Point[]): Quad {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => a.x - a.y - (b.x - b.y));
  return [bySum[0], byDiff[byDiff.length - 1], bySum[bySum.length - 1], byDiff[0]];
}

/**
 * Paper-likeness of a candidate quad: bright and unsaturated (white) wins,
 * with a gentle sqrt(area) preference so trivial scraps don't beat the sheet.
 * Edge-dense interiors are penalized: a white keyboard is bright, white and
 * rectangular, but its keys light up the edge map everywhere, while paper is
 * smooth apart from the writing.
 */
function scoreQuad(cv: CV, small: any, edges: any, approx: any, area: number): number {
  const mask = cv.Mat.zeros(small.rows, small.cols, cv.CV_8UC1);
  const polys = new cv.MatVector();
  polys.push_back(approx);
  try {
    cv.fillPoly(mask, polys, new cv.Scalar(255));
    const [r, g, b] = cv.mean(small, mask);
    const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (brightness < MIN_BRIGHTNESS) return 0;
    const max = Math.max(r, g, b);
    const saturation = max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
    const edgeDensity = cv.mean(edges, mask)[0] / 255;
    return brightness * brightness * (1 - saturation) * Math.exp(-6 * edgeDensity) * Math.sqrt(area);
  } finally {
    polys.delete();
    mask.delete();
  }
}

/** Find the most paper-like convex quad (bright, white, big enough). */
export function detectQuad(cv: CV, src: any): Quad | null {
  const scale = DETECT_WIDTH / src.cols;
  const small = new cv.Mat();
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  try {
    cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)));
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 50, 150);
    cv.dilate(edges, edges, kernel);
    // RETR_LIST, not RETR_EXTERNAL: dilated edges of adjacent objects merge
    // into one blob, and the paper then only survives as an inner contour.
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const minArea = MIN_AREA_RATIO * small.cols * small.rows;
    let best: Point[] | null = null;
    let bestScore = 0;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const approx = new cv.Mat();
      try {
        const peri = cv.arcLength(contour, true);
        cv.approxPolyDP(contour, approx, 0.02 * peri, true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const area = cv.contourArea(approx);
          if (area >= minArea) {
            const score = scoreQuad(cv, small, edges, approx, area);
            if (score > bestScore) {
              bestScore = score;
              const data = approx.data32S as Int32Array;
              best = [0, 1, 2, 3].map((j) => ({ x: data[j * 2], y: data[j * 2 + 1] }));
            }
          }
        }
      } finally {
        approx.delete();
        contour.delete();
      }
    }
    if (!best) return null;
    return orderCorners(best.map((p) => ({ x: p.x / scale, y: p.y / scale })));
  } finally {
    small.delete();
    gray.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
    kernel.delete();
  }
}

/**
 * Warp the quad to a flat rectangle, then whiten the paper and boost the ink.
 * Renders the result into `outCanvas` and returns its size.
 */
/** Rotate the output by 90-degree steps by cycling the corner order. */
export function rotateQuad(quad: Quad, steps: number): Quad {
  const n = ((steps % 4) + 4) % 4;
  return [...quad.slice(n), ...quad.slice(0, n)] as Quad;
}


export function warpAndClean(
  cv: CV,
  src: any,
  quad: Quad,
  outCanvas: HTMLCanvasElement,
  updateAnchors = true,
  forcedAspect: number | null = null,
  outputWidth = MAX_OUTPUT_WIDTH,
): { width: number; height: number } {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const [tl, tr, br, bl] = quad.map((p) => ({
    x: p.x + (cx - p.x) * WARP_INSET_RATIO,
    y: p.y + (cy - p.y) * WARP_INSET_RATIO,
  }));
  const aspect = forcedAspect ?? PAPER_RATIO;
  const width = outputWidth;
  const height = Math.round(width / aspect);

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, width, 0, width, height, 0, height,
  ]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const warped = new cv.Mat();
  const background = new cv.Mat();
  const small = new cv.Mat();
  try {
    cv.warpPerspective(src, warped, M, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    // A strong stretch amplifies sensor noise; a light 3x3 box blur knocks
    // down single-pixel speckle before it gets amplified. Box, not median:
    // same denoise on isolated pixels at ~1/10 the cost (median was 54ms/frame
    // at 1600px), and strokes at this resolution are several px wide so they
    // survive the slight softening.
    cv.blur(warped, warped, new cv.Size(3, 3));

    // Low-pass blur at 1/4 scale: identical result, ~16x cheaper.
    const smallW = Math.max(1, Math.round(width / 4));
    const smallH = Math.max(1, Math.round(height / 4));
    cv.resize(warped, small, new cv.Size(smallW, smallH));
    let k = Math.max(7, Math.round((width / 4) * 0.05));
    if (k % 2 === 0) k += 1;
    cv.blur(small, small, new cv.Size(k, k));
    cv.resize(small, background, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);

    const srcData = warped.data as Uint8Array;
    const bgData = background.data as Uint8Array;
    const out = new ImageData(width, height);
    const outData = out.data;

    // Pass 1: whiten, and histogram the interior's whitened luminance.
    const marginX = Math.round(width * HIST_MARGIN_RATIO);
    const marginY = Math.round(height * HIST_MARGIN_RATIO);
    const hist = new Uint32Array(256);
    let interiorCount = 0;
    for (let i = 0; i < srcData.length; i += 4) {
      let lum = 0;
      for (let c = 0; c < 3; c++) {
        const bg = bgData[i + c] || 1;
        const wv = (srcData[i + c] * 255) / bg;
        const clamped = wv < 0 ? 0 : wv > 255 ? 255 : wv;
        outData[i + c] = clamped;
        lum += (c === 0 ? 0.299 : c === 1 ? 0.587 : 0.114) * clamped;
      }
      outData[i + 3] = 255;
      const p = i >> 2;
      const x = p % width;
      const y = (p / width) | 0;
      if (x >= marginX && x < width - marginX && y >= marginY && y < height - marginY) {
        hist[Math.min(255, Math.round(lum))]++;
        interiorCount++;
      }
    }
    const inkCount = Math.max(20, Math.round(interiorCount * INK_PERCENTILE));
    const paperCount = Math.round(interiorCount * PAPER_PERCENTILE);
    let lo = 255;
    let hi = 255;
    for (let v = 0, acc = 0; v < 256; v++) {
      acc += hist[v];
      if (lo === 255 && acc >= inkCount) lo = v;
      if (acc >= paperCount) {
        hi = v;
        break;
      }
    }
    // Anchors freeze while something moves in frame: a hand is far darker
    // than ink and would steal the ink anchor, washing the strokes out.
    if (updateAnchors || smoothedLo === null || smoothedHi === null) {
      smoothedLo = smoothedLo === null ? lo : smoothedLo + LO_SMOOTHING * (lo - smoothedLo);
      smoothedHi = smoothedHi === null ? hi : smoothedHi + LO_SMOOTHING * (hi - smoothedHi);
    }

    // Pass 2: stretch [ink, paper] to [soft black, white] when there is ink,
    // then snap the near-white background to pure white.
    const span = smoothedHi - smoothedLo;
    if (span >= MIN_INK_SPAN) {
      const anchor = smoothedLo;
      const scale = (255 - INK_FLOOR) / span;
      for (let i = 0; i < outData.length; i += 4) {
        let lum = 0;
        for (let c = 0; c < 3; c++) {
          const v = INK_FLOOR + (outData[i + c] - anchor) * scale;
          const clamped = v < 0 ? 0 : v > 255 ? 255 : v;
          outData[i + c] = clamped;
          lum += (c === 0 ? 0.299 : c === 1 ? 0.587 : 0.114) * clamped;
        }
        if (lum >= WHITE_SNAP_FULL) {
          outData[i] = outData[i + 1] = outData[i + 2] = 255;
        } else if (lum > WHITE_SNAP_START) {
          const t = (lum - WHITE_SNAP_START) / (WHITE_SNAP_FULL - WHITE_SNAP_START);
          for (let c = 0; c < 3; c++) {
            outData[i + c] += t * (255 - outData[i + c]);
          }
        }
      }
    }

    outCanvas.width = width;
    outCanvas.height = height;
    outCanvas.getContext("2d")!.putImageData(out, 0, 0);
    return { width, height };
  } finally {
    srcTri.delete();
    dstTri.delete();
    M.delete();
    warped.delete();
    background.delete();
    small.delete();
  }
}

export function sampleBoard(canvas: HTMLCanvasElement): ImageData {
  const w = 160;
  const h = Math.max(1, Math.round((canvas.height * w) / canvas.width));
  const scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

export interface InkBlob {
  id: number;
  /** SVG path data (fill-rule evenodd), integer coords in board units. */
  d: string;
  /** Bounding box in board units (BOARD_UNITS wide, height proportional). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export const BOARD_UNITS = 1500;

function contourToSubpath(cv: CV, contour: any, k: number, epsilon: number): string | null {
  const approx = new cv.Mat();
  try {
    cv.approxPolyDP(contour, approx, epsilon, true);
    if (approx.rows < 1) return null;
    const data = approx.data32S as Int32Array;
    let d = `M ${Math.round(data[0] * k)} ${Math.round(data[1] * k)}`;
    for (let j = 1; j < approx.rows; j++) {
      d += ` L ${Math.round(data[j * 2] * k)} ${Math.round(data[j * 2 + 1] * k)}`;
    }
    return `${d} Z`;
  } finally {
    approx.delete();
  }
}

function clusterPath(cv: CV, contours: any[], k: number, epsilon: number): string {
  const parts: string[] = [];
  for (const c of contours) {
    const sub = contourToSubpath(cv, c, k, epsilon);
    if (sub) parts.push(sub);
  }
  return parts.join(" ");
}

/** Extract filled ink blobs as SVG path data in board-unit coordinates. */
export function vectorizeInk(cv: CV, canvas: HTMLCanvasElement): InkBlob[] {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const mask = new cv.Mat();
  const dilated = new cv.Mat();
  const clusterContours = new cv.MatVector();
  const clusterHierarchy = new cv.Mat();
  const detailContours = new cv.MatVector();
  const detailHierarchy = new cv.Mat();
  // Word-level clustering: big enough to join the letters of one word, small
  // enough that text lines, labels and drawings stay separate blobs. Coarser
  // radii merge text with drawings into unclassifiable mixed blobs.
  const radius = Math.max(1, Math.round(canvas.width * 0.006));
  const ksize = radius * 2 + 1;
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(ksize, ksize));
  const clusters: { rect: { x: number; y: number; width: number; height: number }; contours: any[] }[] = [];
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, mask, 150, 255, cv.THRESH_BINARY_INV);
    cv.dilate(mask, dilated, kernel);
    cv.findContours(dilated, clusterContours, clusterHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    for (let i = 0; i < clusterContours.size(); i++) {
      const c = clusterContours.get(i);
      try {
        clusters.push({ rect: cv.boundingRect(c), contours: [] });
      } finally {
        c.delete();
      }
    }

    cv.findContours(mask, detailContours, detailHierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < detailContours.size(); i++) {
      const c = detailContours.get(i);
      try {
        if (cv.contourArea(c) < 4) continue;
        const br = cv.boundingRect(c);
        const cx = br.x + br.width / 2;
        const cy = br.y + br.height / 2;
        const cluster = clusters.find(
          (cl) =>
            cx >= cl.rect.x &&
            cx < cl.rect.x + cl.rect.width &&
            cy >= cl.rect.y &&
            cy < cl.rect.y + cl.rect.height,
        );
        if (!cluster) continue;
        // Clone so we can approx at epsilon 1.0 and optionally redo at 3.0.
        cluster.contours.push(c.clone());
      } finally {
        c.delete();
      }
    }

    const k = BOARD_UNITS / canvas.width;
    const blobs: InkBlob[] = [];
    let id = 0;
    for (const cluster of clusters) {
      let d = clusterPath(cv, cluster.contours, k, 1.0);
      if (!d) continue;
      if (d.length > 20_000) d = clusterPath(cv, cluster.contours, k, 3.0);
      if (!d) continue;
      blobs.push({
        id: id++,
        d,
        x: Math.round(cluster.rect.x * k),
        y: Math.round(cluster.rect.y * k),
        w: Math.round(cluster.rect.width * k),
        h: Math.round(cluster.rect.height * k),
      });
    }
    return blobs;
  } finally {
    for (const cluster of clusters) {
      for (const c of cluster.contours) c.delete();
    }
    src.delete();
    gray.delete();
    mask.delete();
    dilated.delete();
    clusterContours.delete();
    clusterHierarchy.delete();
    detailContours.delete();
    detailHierarchy.delete();
    kernel.delete();
  }
}

/**
 * Fraction of pixels that flip between clearly-ink and clearly-paper.
 * Unlike diffRatio this ignores luminance drift: camera auto-exposure and the
 * contrast re-anchoring shift stroke edges by tens of levels between samples
 * taken minutes apart, but only genuinely new/erased ink crosses both bands.
 */
export function inkChangeRatio(a: ImageData, b: ImageData): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const INK = 100;
  const PAPER = 180;
  let changed = 0;
  const ad = a.data;
  const bd = b.data;
  for (let i = 0; i < ad.length; i += 4) {
    const la = 0.299 * ad[i] + 0.587 * ad[i + 1] + 0.114 * ad[i + 2];
    const lb = 0.299 * bd[i] + 0.587 * bd[i + 1] + 0.114 * bd[i + 2];
    if ((la < INK && lb > PAPER) || (la > PAPER && lb < INK)) changed++;
  }
  return changed / (a.width * a.height);
}

export function diffRatio(a: ImageData, b: ImageData): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  const ad = a.data;
  const bd = b.data;
  for (let i = 0; i < ad.length; i += 4) {
    const da = Math.abs(ad[i] - bd[i]) + Math.abs(ad[i + 1] - bd[i + 1]) + Math.abs(ad[i + 2] - bd[i + 2]);
    if (da > 60) changed++;
  }
  return changed / (a.width * a.height);
}

/**
 * Motion ratio between consecutive cleaned frames, computed on a small
 * grayscale copy. Used to detect "the presenter is writing right now".
 */
export class MotionDetector {
  private prev: ImageData | null = null;

  measure(canvas: HTMLCanvasElement): number {
    const current = sampleBoard(canvas);
    const ratio = this.prev ? diffRatio(current, this.prev) : 0;
    this.prev = current;
    return ratio;
  }

  reset(): void {
    this.prev = null;
  }
}

/** Stabilizes quad detection: locks once N consecutive detections agree. */
export class QuadLock {
  private history: Quad[] = [];
  locked: Quad | null = null;

  private static readonly REQUIRED = 6;
  private static readonly TOLERANCE_PX = 14;

  offer(quad: Quad | null): void {
    if (this.locked || !quad) return;
    this.history.push(quad);
    if (this.history.length > QuadLock.REQUIRED) this.history.shift();
    if (this.history.length === QuadLock.REQUIRED && this.isStable()) {
      this.locked = this.average();
      this.history = [];
    }
  }

  release(): void {
    this.locked = null;
    this.history = [];
  }

  get candidate(): Quad | null {
    return this.locked ?? this.history[this.history.length - 1] ?? null;
  }

  private isStable(): boolean {
    const first = this.history[0];
    return this.history.every((q) =>
      q.every((p, i) => dist(p, first[i]) < QuadLock.TOLERANCE_PX),
    );
  }

  private average(): Quad {
    const n = this.history.length;
    return [0, 1, 2, 3].map((i) => ({
      x: this.history.reduce((s, q) => s + q[i].x, 0) / n,
      y: this.history.reduce((s, q) => s + q[i].y, 0) / n,
    })) as Quad;
  }
}
