export interface FigmaStatus {
  state: "idle" | "syncing" | "error";
  lastError: string | null;
}

export interface ServerStatus {
  hasKey: boolean;
  model: string | null;
  lastError: string | null;
  /** null when the server has no Figma token/board configured. */
  figma: FigmaStatus | null;
}

export interface BeautifyResponse {
  /** Rendered whiteboard as a PNG data URL. */
  image: string;
  durationMs: number;
  model: string | null;
}

export async function fetchStatus(): Promise<ServerStatus> {
  const res = await fetch("/api/status");
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

export async function requestReset(): Promise<void> {
  await fetch("/api/reset", { method: "POST" });
}

export async function requestBeautify(
  imageDataUrl: string,
  signal?: AbortSignal,
  figma = true,
): Promise<BeautifyResponse> {
  const res = await fetch("/api/beautify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: imageDataUrl, figma }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `beautify failed (${res.status})`);
  return body as BeautifyResponse;
}
