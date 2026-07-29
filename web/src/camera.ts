const FIRST_FRAME_TIMEOUT_MS = 3000;

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  // Labels are only exposed after permission is granted, so open and
  // immediately close a throwaway stream first.
  const probe = await navigator.mediaDevices.getUserMedia({ video: true });
  probe.getTracks().forEach((t) => t.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

export async function openCamera(
  video: HTMLVideoElement,
  deviceId?: string,
): Promise<MediaStream> {
  const existing = video.srcObject as MediaStream | null;
  existing?.getTracks().forEach((t) => t.stop());

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      // Ask for the largest frame the sensor can give (2K+ cameras); cameras
      // with smaller sensors treat "ideal" as an upper bound and stay native.
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    },
    audio: false,
  });
  video.srcObject = stream;
  void video.play();
  // A camera can enumerate and hand out a "live" track yet never deliver a
  // frame (seen with an idle C930e); awaiting play() would then hang forever.
  // Gate on real frame delivery so callers can fall back to another camera.
  const gotFrame = await Promise.race([
    new Promise<boolean>((resolve) => video.requestVideoFrameCallback(() => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), FIRST_FRAME_TIMEOUT_MS)),
  ]);
  if (!gotFrame) {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    throw new Error("camera delivered no frames");
  }
  return stream;
}
