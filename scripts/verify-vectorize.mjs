// Geometry-fidelity check for vectorizeInk: runs the app's real pipeline module
// inside a headless Chrome against a known snapshot, then writes the traced
// ink as SVG + PNG + blobs.json under /tmp/wb-verify and prints blob stats.
//   node scripts/verify-vectorize.mjs [path/to/snapshot.png]
// Requires the dev server on localhost:5173 (vite serves /src/pipeline.ts and
// the snapshot through /@fs/). The snapshot must live inside the repo.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9223;
const OUT_DIR = "/tmp/wb-verify";
const snapshotPath = path.resolve(
  process.argv[2] ?? path.resolve(import.meta.dirname, "../server/.board-workspace/snapshot-34.png"),
);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(`${OUT_DIR}/chrome-profile`, { recursive: true, force: true });

setTimeout(() => {
  console.error("timed out after 150s");
  process.exit(2);
}, 150_000);

function launchChrome(args) {
  const child = spawn(CHROME, ["--headless=new", "--no-first-run", ...args], { stdio: "ignore" });
  process.on("exit", () => child.kill());
  return child;
}

const chrome = launchChrome([
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${OUT_DIR}/chrome-profile`,
  "http://localhost:5173",
]);

async function tab() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
      const t = list.find((t) => t.url.includes("localhost:5173"));
      if (t) return t;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("app tab never appeared; is the dev server running?");
}

const { webSocketDebuggerUrl } = await tab();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("cdp connect failed"));
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
};
ws.onclose = () => {
  for (const p of pending.values()) p.reject(new Error("cdp socket closed (chrome died?)"));
  pending.clear();
};
function cdp(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// The tab shows up in /json/list before navigation commits; evaluating then
// gets the context destroyed under us. Wait for the real document.
for (let i = 0; i < 40; i++) {
  const ready = await cdp("Runtime.evaluate", { expression: "document.readyState" }).catch(() => null);
  if (ready?.result?.value === "complete") break;
  await new Promise((r) => setTimeout(r, 500));
}

const expression = `(async () => {
  const { loadOpenCV } = await import("http://localhost:5173/src/opencv.ts");
  const cv = await loadOpenCV();
  const { vectorizeInk, BOARD_UNITS } = await import("http://localhost:5173/src/pipeline.ts");
  const img = new Image();
  img.src = "http://localhost:5173/@fs" + ${JSON.stringify(snapshotPath)};
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);
  const t0 = performance.now();
  const blobs = vectorizeInk(cv, canvas);
  const ms = Math.round(performance.now() - t0);
  const boardH = Math.round((canvas.height * BOARD_UNITS) / canvas.width);
  const paths = blobs.map((b) => '<path fill-rule="evenodd" d="' + b.d + '"/>').join("");
  const boxes = blobs
    .map((b) => '<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h +
      '" fill="none" stroke="#f54e00" stroke-width="2"/>')
    .join("");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + BOARD_UNITS + ' ' + boardH +
    '"><rect width="100%" height="100%" fill="white"/>' + paths + boxes + '</svg>';
  return JSON.stringify({ ms, svg, blobs });
})()`;

const res = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
if (res.exceptionDetails) {
  console.error("page threw:", JSON.stringify(res.exceptionDetails, null, 2).slice(0, 2000));
  process.exit(1);
}
const { ms, svg, blobs } = JSON.parse(res.result.value);
ws.close();
chrome.kill();

fs.writeFileSync(`${OUT_DIR}/blobs.svg`, svg);
fs.writeFileSync(`${OUT_DIR}/blobs.json`, JSON.stringify(blobs));

// Chrome's screenshot mode does not always exit on its own; give it a few
// seconds, the PNG is written early.
const shot = launchChrome([
  `--user-data-dir=${OUT_DIR}/shot-profile`,
  `--screenshot=${OUT_DIR}/blobs.png`,
  "--window-size=1500,1160",
  `file://${OUT_DIR}/blobs.svg`,
]);
await new Promise((r) => setTimeout(r, 6000));
shot.kill();

console.log(`vectorized in ${ms}ms: ${blobs.length} blobs`);
for (const b of blobs) {
  console.log(`  #${b.id} bbox ${b.x},${b.y} ${b.w}x${b.h} pathChars=${b.d.length}`);
}
console.log(`total path chars: ${blobs.reduce((n, b) => n + b.d.length, 0)}`);
console.log(`wrote ${OUT_DIR}/blobs.{svg,png,json} (input: ${snapshotPath})`);
process.exit(0);
