import type { InkBlob } from "./pipeline";

export interface FigmaStatus {
  state: "idle" | "syncing" | "error";
  lastError: string | null;
}

export interface ServerStatus {
  hasKey: boolean;
  model: string | null;
  lastError: string | null;
  /** null when the server has no board URL / API key configured. */
  figma: FigmaStatus | null;
}

export async function fetchStatus(): Promise<ServerStatus> {
  const res = await fetch("/api/status");
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

/** Fire-and-forget on the server side: returns as soon as the sync is queued. */
export async function requestSync(imageDataUrl: string, blobs: InkBlob[]): Promise<void> {
  const res = await fetch("/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: imageDataUrl, blobs }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `sync failed (${res.status})`);
  }
}
