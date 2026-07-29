// OpenCV.js ships as a UMD bundle without TypeScript types; we treat the
// module as `any` and load it lazily since the WASM blob is ~10MB.
export type CV = any;

let cvPromise: Promise<CV> | null = null;

export function loadOpenCV(): Promise<CV> {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/opencv.js";
    script.async = true;
    script.onload = () => {
      const mod = (window as any).cv;
      if (!mod) {
        reject(new Error("opencv.js loaded but no cv global"));
        return;
      }
      // Depending on the build, cv is a Promise, an initialized module, or a
      // module that fires onRuntimeInitialized.
      if (typeof mod.then === "function") {
        // Old Emscripten builds expose a fake `then` that calls back with the
        // still-thenable Module itself. Resolving a Promise with it makes the
        // promise machinery unwrap it forever and wedges the main thread
        // (emscripten#5820), so strip `then` before resolving.
        mod.then((m: any) => {
          delete m.then;
          resolve(m);
        }, reject);
      } else if (mod.Mat) {
        resolve(mod);
      } else {
        mod.onRuntimeInitialized = () => resolve(mod);
      }
    };
    script.onerror = () => reject(new Error("failed to load /opencv.js"));
    document.head.appendChild(script);
  });
  return cvPromise;
}
