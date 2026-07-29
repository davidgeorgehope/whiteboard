import "./style.css";
import { listCameras, openCamera } from "./camera";
import { loadOpenCV, type CV } from "./opencv";
import {
  detectQuad,
  rotateQuad,
  warpAndClean,
  MotionDetector,
  QuadLock,
  sampleBoard,
  inkChangeRatio,
  type Quad,
} from "./pipeline";
import { fetchStatus, requestBeautify, requestReset } from "./beautify";

// Full 1080p capture: faint thin strokes lose too much contrast when the
// paper is a small part of a downscaled frame.
const CAPTURE_MAX_WIDTH = 1920;
// The AI snapshot is re-warped from the full-res frame once per pass, so it
// can afford more pixels than the every-frame live view.
const SNAPSHOT_WIDTH = 1700;
const DETECT_EVERY_N_FRAMES = 4;
// Calibrated against the stretched output: idle sensor flicker measures up to
// ~0.011, a hand writing in frame 0.1+. Too low and the debounce never
// elapses, permanently deferring auto-beautify.
const MOTION_THRESHOLD = 0.03;
// Fraction of downsampled board pixels that must flip between ink and paper
// (inkChangeRatio) since the last AI-sent board before an auto pass fires.
// A single short word measures ~0.01; drift-induced edge wobble measures ~0.
const CHANGE_MIN_RATIO = 0.004;
// Wait for the pen to be down for a bit before beautifying, so lifting the
// pen mid-word doesn't fire a pass.
const MOTION_DEBOUNCE_MS = 1600;
const MIN_BEAUTIFY_GAP_MS = 4000;
// While locked, re-run detection in the background on calm frames; this many
// consecutive disagreements with the locked corners (paper flipped, moved,
// camera bumped) release the lock so it can re-acquire on its own.
const DRIFT_CHECK_EVERY_N_FRAMES = 30;
const DRIFT_STRIKES_TO_RELEASE = 4;
const DRIFT_TOLERANCE_RATIO = 0.05;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const video = $<HTMLVideoElement>("video");
const captureCanvas = $<HTMLCanvasElement>("captureCanvas");
const liveCanvas = $<HTMLCanvasElement>("liveCanvas");
const previewCanvas = $<HTMLCanvasElement>("previewCanvas");
const liveHint = $<HTMLDivElement>("liveHint");
const liveFrame = $<HTMLDivElement>("liveFrame");
const svgHost = $<HTMLDivElement>("svgHost");
const aiStatus = $<HTMLSpanElement>("aiStatus");
const boardChip = $<HTMLSpanElement>("boardChip");
const agentChip = $<HTMLSpanElement>("agentChip");
const cameraSelect = $<HTMLSelectElement>("cameraSelect");
const beautifyBtn = $<HTMLButtonElement>("beautifyBtn");
const autoToggle = $<HTMLInputElement>("autoToggle");

let cv: CV;
const quadLock = new QuadLock();
const motion = new MotionDetector();

let frameCount = 0;
let wasLocked = false;
let driftStrikes = 0;
let rotationSteps = Number(localStorage.getItem("wb-rotation") ?? "0") % 4;
let lastMotionRatio = 0;
let dirty = false;
let lastMotionAt = 0;
let lastBeautifyAt = 0;
let inFlight = false;
let queued = false;
let agentUsable = false;
let lastSentBoard: ImageData | null = null;

async function init(): Promise<void> {
  boardChip.textContent = "loading OpenCV\u2026";
  const [cvModule, cameras] = await Promise.all([loadOpenCV(), listCameras()]);
  cv = cvModule;

  for (const cam of cameras) {
    const option = document.createElement("option");
    option.value = cam.deviceId;
    option.textContent = cam.label || `Camera ${cameraSelect.length + 1}`;
    cameraSelect.appendChild(option);
  }
  // Prefer an external Logitech camera over the built-in one when present.
  const external = cameras.find((c) => /brio|logi|c9\d\d/i.test(c.label));
  if (external) cameraSelect.value = external.deviceId;

  await openWorkingCamera(cameras);
  boardChip.textContent = "looking for board\u2026";

  refreshAgentStatus();
  // Keep retrying: the server may be mid-restart when the page loads, and a
  // stale "offline" reading would silently disable auto-beautify.
  setInterval(refreshAgentStatus, 15_000);
  requestAnimationFrame(tick);
}

/** Try the preferred camera first, then every other one that delivers frames. */
async function openWorkingCamera(cameras: MediaDeviceInfo[]): Promise<void> {
  const preferred = cameraSelect.value;
  const order = [preferred, ...cameras.map((c) => c.deviceId).filter((id) => id !== preferred)];
  for (const id of order) {
    try {
      await openCamera(video, id);
      cameraSelect.value = id;
      return;
    } catch (err) {
      console.warn("[camera] failed, trying next:", err instanceof Error ? err.message : err);
    }
  }
  throw new Error("no camera delivered frames");
}

function tick(): void {
  requestAnimationFrame(tick);
  if (video.readyState < video.HAVE_CURRENT_DATA || video.videoWidth === 0) return;
  frameCount++;

  const scale = Math.min(1, CAPTURE_MAX_WIDTH / video.videoWidth);
  const cw = Math.round(video.videoWidth * scale);
  const ch = Math.round(video.videoHeight * scale);
  if (captureCanvas.width !== cw || captureCanvas.height !== ch) {
    captureCanvas.width = cw;
    captureCanvas.height = ch;
  }
  const ctx = captureCanvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, cw, ch);

  const src = cv.imread(captureCanvas);
  try {
    if (!quadLock.locked && frameCount % DETECT_EVERY_N_FRAMES === 0) {
      quadLock.offer(detectQuad(cv, src));
      updateBoardChip();
    }

    drawPreview();
    liveFrame.classList.toggle("locked", quadLock.locked !== null);

    if (quadLock.locked) {
      if (!wasLocked) {
        // A fresh lock is a fresh board: arm an auto pass and start a clean
        // AI session so the previous page can't leak into this one.
        wasLocked = true;
        dirty = true;
        lastMotionAt = performance.now();
        driftStrikes = 0;
        lastSentBoard = null;
        svgHost.innerHTML = '<div id="aiPlaceholder">Waiting for the first beautify pass&hellip;</div>';
        void requestReset();
      }
      liveHint.hidden = true;
      const calm = lastMotionRatio <= MOTION_THRESHOLD;
      if (calm && frameCount % DRIFT_CHECK_EVERY_N_FRAMES === 0) {
        checkDrift(src);
      }
      warpAndClean(cv, src, rotateQuad(quadLock.locked, rotationSteps), liveCanvas, calm);
      const ratio = motion.measure(liveCanvas);
      lastMotionRatio = ratio;
      if (ratio > MOTION_THRESHOLD) {
        dirty = true;
        lastMotionAt = performance.now();
      }
      maybeAutoBeautify();
      (window as any).__wb = {
        ratio: Number(ratio.toFixed(5)),
        dirty,
        agentUsable,
        inFlight,
        sinceMotionMs: Math.round(performance.now() - lastMotionAt),
        sinceBeautifyMs: Math.round(performance.now() - lastBeautifyAt),
      };
      // Debug hook for CDP-driven verification: simulate "writing stopped a
      // while ago" without physical motion in front of the camera.
      (window as any).__wbArm = () => {
        dirty = true;
        lastMotionAt = 0;
        lastBeautifyAt = 0;
      };
    } else {
      liveHint.hidden = false;
      liveHint.textContent = "Looking for the sheet of paper \u2014 make sure all four corners are in view";
      if (liveCanvas.width !== cw || liveCanvas.height !== ch) {
        liveCanvas.width = cw;
        liveCanvas.height = ch;
      }
      liveCanvas.getContext("2d")!.drawImage(captureCanvas, 0, 0);
      wasLocked = false;
    }
  } finally {
    src.delete();
  }
}

function checkDrift(src: any): void {
  const locked = quadLock.locked!;
  const found = detectQuad(cv, src);
  const tolerance = DRIFT_TOLERANCE_RATIO * captureCanvas.width;
  const agrees =
    found !== null &&
    locked.every((p, i) => Math.hypot(p.x - found[i].x, p.y - found[i].y) < tolerance);
  driftStrikes = agrees ? 0 : driftStrikes + 1;
  if (driftStrikes >= DRIFT_STRIKES_TO_RELEASE) {
    quadLock.release();
    motion.reset();
    updateBoardChip();
  }
}

function drawPreview(): void {
  const w = 200;
  const h = Math.round((captureCanvas.height * w) / captureCanvas.width);
  if (previewCanvas.width !== w || previewCanvas.height !== h) {
    previewCanvas.width = w;
    previewCanvas.height = h;
  }
  const ctx = previewCanvas.getContext("2d")!;
  ctx.drawImage(captureCanvas, 0, 0, w, h);

  const quad = quadLock.candidate;
  if (quad) {
    const sx = w / captureCanvas.width;
    const sy = h / captureCanvas.height;
    ctx.strokeStyle = quadLock.locked ? "#7ddb84" : "#f54e00";
    ctx.lineWidth = 2;
    ctx.beginPath();
    quad.forEach((p: Quad[number], i: number) => {
      if (i === 0) ctx.moveTo(p.x * sx, p.y * sy);
      else ctx.lineTo(p.x * sx, p.y * sy);
    });
    ctx.closePath();
    ctx.stroke();
  }
}

function updateBoardChip(): void {
  if (quadLock.locked) {
    boardChip.textContent = "board locked";
    boardChip.className = "chip good";
  } else if (quadLock.candidate) {
    boardChip.textContent = "board found, stabilizing\u2026";
    boardChip.className = "chip";
  } else {
    boardChip.textContent = "looking for board\u2026";
    boardChip.className = "chip";
  }
}

function maybeAutoBeautify(): void {
  if (!autoToggle.checked || !agentUsable || !dirty || inFlight) return;
  const now = performance.now();
  if (now - lastMotionAt < MOTION_DEBOUNCE_MS) return;
  if (now - lastBeautifyAt < MIN_BEAUTIFY_GAP_MS) return;
  const sample = sampleBoard(liveCanvas);
  const gateRatio = lastSentBoard === null ? null : inkChangeRatio(sample, lastSentBoard);
  (window as any).__wbGateRatio = gateRatio;
  if (gateRatio !== null && gateRatio < CHANGE_MIN_RATIO) {
    dirty = false;
    aiStatus.textContent = "no changes";
    aiStatus.className = "";
    return;
  }
  void triggerBeautify();
}

async function triggerBeautify(): Promise<void> {
  if (inFlight) {
    queued = true;
    return;
  }
  if (!quadLock.locked) return;
  inFlight = true;
  dirty = false;
  lastBeautifyAt = performance.now();
  beautifyBtn.disabled = true;
  aiStatus.textContent = "refreshing\u2026";
  aiStatus.className = "busy";
  try {
    lastSentBoard = sampleBoard(liveCanvas);
    const result = await requestBeautify(snapshotDataUrl());
    const img = new Image();
    img.src = result.image;
    img.alt = "AI whiteboard";
    svgHost.replaceChildren(img);
    aiStatus.textContent = `updated in ${(result.durationMs / 1000).toFixed(1)}s`;
    aiStatus.className = "";
  } catch (err) {
    // A failed pass delivered nothing: forget the "sent" sample so the
    // change gate can't conclude "no changes" over a stale or empty pane.
    lastSentBoard = null;
    aiStatus.textContent = `error: ${err instanceof Error ? err.message : err}`;
    aiStatus.className = "";
    console.error("[beautify]", err);
  } finally {
    inFlight = false;
    beautifyBtn.disabled = false;
    lastBeautifyAt = performance.now();
    if (queued) {
      queued = false;
      void triggerBeautify();
    }
  }
}

function snapshotDataUrl(): string {
  if (quadLock.locked) {
    // Warp from the native video frame, not the (possibly downscaled)
    // processing canvas, so a 2K+ sensor's extra pixels reach the AI.
    const frame = document.createElement("canvas");
    frame.width = video.videoWidth;
    frame.height = video.videoHeight;
    frame.getContext("2d")!.drawImage(video, 0, 0);
    const k = video.videoWidth / captureCanvas.width;
    const quad = rotateQuad(quadLock.locked, rotationSteps).map((p) => ({
      x: p.x * k,
      y: p.y * k,
    })) as Quad;
    const scratch = document.createElement("canvas");
    const src = cv.imread(frame);
    try {
      warpAndClean(cv, src, quad, scratch, false, null, SNAPSHOT_WIDTH);
      return scratch.toDataURL("image/png");
    } finally {
      src.delete();
    }
  }
  return liveCanvas.toDataURL("image/png");
}

async function refreshAgentStatus(): Promise<void> {
  try {
    const status = await fetchStatus();
    if (!status.hasKey) {
      agentUsable = false;
      agentChip.textContent = "agent: no API key";
      agentChip.className = "chip bad";
      agentChip.title = "Copy .env.example to .env and set CURSOR_API_KEY, then restart the server.";
    } else {
      agentUsable = true;
      agentChip.textContent = `agent: ${status.model ?? "ready"}`;
      agentChip.className = "chip good";
      agentChip.title = "";
    }
  } catch {
    agentUsable = false;
    agentChip.textContent = "agent: server offline";
    agentChip.className = "chip bad";
  }
}

$<HTMLButtonElement>("redetectBtn").addEventListener("click", () => {
  quadLock.release();
  motion.reset();
  updateBoardChip();
});

beautifyBtn.addEventListener("click", () => void triggerBeautify());

$<HTMLButtonElement>("rotateBtn").addEventListener("click", () => {
  rotationSteps = (rotationSteps + 1) % 4;
  localStorage.setItem("wb-rotation", String(rotationSteps));
  motion.reset();
});

$<HTMLButtonElement>("presentBtn").addEventListener("click", () => {
  void liveFrame.requestFullscreen();
});

cameraSelect.addEventListener("change", async () => {
  try {
    await openCamera(video, cameraSelect.value);
    quadLock.release();
    motion.reset();
    updateBoardChip();
  } catch (err) {
    boardChip.textContent = `camera failed: ${err instanceof Error ? err.message : err}`;
    boardChip.className = "chip bad";
  }
});

(window as any).__wbSnapshot = () => snapshotDataUrl();

init().catch((err) => {
  boardChip.textContent = `init failed: ${err instanceof Error ? err.message : err}`;
  boardChip.className = "chip bad";
  console.error(err);
});
