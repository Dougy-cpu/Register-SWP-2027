import QrScanner from "qr-scanner";
import { BADGE_SCANNER_OPTIONS } from "./scanner-camera";

export const CAMERA_START_TIMEOUT_MS = 12_000;
export const CAMERA_STALL_TIMEOUT_MS = 8_000;
export type CameraPhase = "idle" | "starting" | "active" | "paused" | "error";
export interface BadgeCameraState {
  phase: CameraPhase;
  session: number;
  message: string;
  selectedCamera: string;
  cameras: Array<{ id: string; label: string }>;
  flashAvailable: boolean;
  flashOn: boolean;
  flashBusy: boolean;
}
export const INITIAL_CAMERA_STATE: BadgeCameraState = {
  phase: "idle",
  session: 0,
  message: "",
  selectedCamera: "environment",
  cameras: [],
  flashAvailable: false,
  flashOn: false,
  flashBusy: false,
};

export function cameraErrorMessage(caught: unknown): string {
  // qr-scanner can reject with strings as well as DOMExceptions.
  const detail = caught instanceof Error ? `${caught.name} ${caught.message}` : String(caught);
  // 1.4.2 collapses permission/busy/device failures into this same string after
  // trying its camera constraints. Do not misreport it as missing hardware.
  if (/camera not found/i.test(detail))
    return "No camera could be opened. Check Camera permission in your browser settings, close other camera apps, then tap Retry camera. You can also choose another camera or use a badge photo.";
  if (/notallowed|permission|denied|security/i.test(detail))
    return "Camera access was blocked. Allow Camera in this site's browser settings, then tap Retry camera. You can also use a badge photo.";
  if (/notfound|devicesnotfound|no camera|overconstrained/i.test(detail))
    return "No available camera was found. Choose another camera or use a badge photo.";
  if (/notreadable|trackstart|busy|abort/i.test(detail))
    return "The camera is busy or was interrupted. Close other camera apps or scanner tabs, then tap Retry camera.";
  if (/play|autoplay|notsupported/i.test(detail))
    return "The camera could not play. Tap Retry camera to allow playback, or use a badge photo.";
  return "The camera could not start. Tap Retry camera, choose another camera or use a badge photo.";
}

export function videoIsVisible(video: HTMLVideoElement): boolean {
  const box = video.getBoundingClientRect();
  const style = getComputedStyle(video);
  return (
    video.isConnected &&
    !video.hidden &&
    box.width > 1 &&
    box.height > 1 &&
    style.display !== "none" &&
    style.visibility === "visible" &&
    style.opacity !== "0"
  );
}

function tracks(video: HTMLVideoElement): MediaStreamTrack[] {
  const stream = video.srcObject as MediaStream | null;
  return stream?.getTracks?.() ?? [];
}
function releaseVideo(video: HTMLVideoElement) {
  for (const track of tracks(video)) track.stop();
  video.srcObject = null;
}
interface Attempt {
  id: number;
  video: HTMLVideoElement | null;
  scanner: QrScanner | null;
  timers: Set<ReturnType<typeof setTimeout>>;
  removeListeners: Array<() => void>;
}

/** Owns only camera resources. It never reads or writes lead data or storage. */
export class BadgeCameraController {
  state = INITIAL_CAMERA_STATE;
  onDecode: (value: string) => void = () => undefined;
  onActive: () => void = () => undefined;
  private mounted = false;
  private video: HTMLVideoElement | null = null;
  private attempt: Attempt | null = null;

  constructor(private readonly publish: (state: BadgeCameraState) => void) {}

  private emit(patch: Partial<BadgeCameraState>) {
    this.state = { ...this.state, ...patch };
    if (this.mounted) this.publish(this.state);
  }
  private current(attempt: Attempt) {
    return this.mounted && this.attempt === attempt;
  }
  private later(attempt: Attempt, action: () => void, ms: number) {
    const timer = setTimeout(() => {
      attempt.timers.delete(timer);
      if (this.current(attempt)) action();
    }, ms);
    attempt.timers.add(timer);
    return timer;
  }
  private cancel() {
    const attempt = this.attempt;
    this.attempt = null; // Invalidate callbacks before stopping any browser resources.
    if (!attempt) return;
    attempt.timers.forEach(clearTimeout);
    attempt.removeListeners.forEach((remove) => remove());
    if (attempt.scanner) {
      void attempt.scanner.pause(true).catch(() => undefined);
      attempt.scanner.destroy();
      attempt.scanner.$overlay?.remove();
    }
    if (attempt.video) releaseVideo(attempt.video);
  }
  private end(phase: CameraPhase, message: string) {
    this.cancel();
    this.emit({ phase, message, flashAvailable: false, flashOn: false, flashBusy: false });
  }
  stop = () => this.end("idle", "");
  private background = () => {
    if (this.attempt)
      this.end(
        "paused",
        "Camera paused while you were away. Tap Resume camera when you are ready.",
      );
  };
  private visibility = () => {
    if (document.hidden) this.background();
  };
  mount = () => {
    this.mounted = true;
    document.addEventListener("visibilitychange", this.visibility);
    window.addEventListener("pagehide", this.background);
    return () => {
      this.mounted = false;
      this.cancel();
      document.removeEventListener("visibilitychange", this.visibility);
      window.removeEventListener("pagehide", this.background);
    };
  };
  attachVideo = (video: HTMLVideoElement | null) => {
    this.video = video;
    if (this.attempt?.video && this.attempt.video !== video)
      this.end("paused", "The camera view changed. Tap Resume camera to continue.");
  };
  start = () => {
    if (!this.attempt) this.begin(this.state.selectedCamera);
  };
  isSessionActive = (session: number) =>
    this.attempt?.id === session && this.state.phase === "active";
  selectCamera = (selected: string) => this.begin(selected);

  private begin(selectedCamera: string) {
    if (!this.mounted) return;
    this.cancel();
    const attempt: Attempt = {
      id: this.state.session + 1,
      video: null,
      scanner: null,
      timers: new Set(),
      removeListeners: [],
    };
    this.attempt = attempt;
    // The consumer MUST key its video by session. qr-scanner 1.4.2 has delayed
    // stop callbacks, so a retired scanner must never share the next video node.
    this.emit({
      session: attempt.id,
      phase: "starting",
      message: "Starting camera…",
      selectedCamera,
      flashAvailable: false,
      flashOn: false,
      flashBusy: false,
    });
    if (document.hidden) {
      this.background();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.end(
        "error",
        "Camera access is unavailable. Open this link in Safari or Chrome over HTTPS, or use a badge photo.",
      );
      return;
    }
    const deadline = this.later(
      attempt,
      () =>
        this.end(
          "error",
          "The camera did not become ready. Check camera permission, close other camera apps, then tap Retry camera or use a badge photo.",
        ),
      CAMERA_START_TIMEOUT_MS,
    );
    const waitForVideo = () => {
      const video = this.video;
      // React can commit the result-to-camera transition after the button handler.
      // Keep waiting within the same deadline instead of silently returning.
      if (!video || video.dataset.cameraSession !== String(attempt.id) || !videoIsVisible(video)) {
        this.later(attempt, waitForVideo, 100);
        return;
      }
      attempt.video = video;
      let decodeErrors = 0;
      try {
        const scanner = new QrScanner(
          video,
          (result) => {
            if (this.current(attempt) && this.state.phase === "active" && !document.hidden)
              this.onDecode(result.data);
          },
          {
            ...BADGE_SCANNER_OPTIONS,
            preferredCamera: selectedCamera,
            onDecodeError: (error) => {
              if (!this.current(attempt)) return;
              if (String(error).includes(QrScanner.NO_QR_CODE_FOUND)) {
                decodeErrors = 0;
                return;
              }
              if (++decodeErrors >= 3)
                this.end(
                  "error",
                  "Badge reading was interrupted. Tap Retry camera or use a badge photo.",
                );
            },
          },
        );
        attempt.scanner = scanner;
        void scanner
          .start()
          .then(() => {
            if (!this.current(attempt)) {
              releaseVideo(video);
              return;
            }
            const waitForFrames = () => {
              const live = tracks(video).filter((track) => track.kind === "video");
              if (
                !videoIsVisible(video) ||
                video.videoWidth < 1 ||
                video.videoHeight < 1 ||
                video.readyState < 2 ||
                video.paused ||
                !live.length ||
                live.every((track) => track.readyState !== "live" || track.muted || !track.enabled)
              ) {
                this.later(attempt, waitForFrames, 100);
                return;
              }
              clearTimeout(deadline);
              attempt.timers.delete(deadline);
              const track = live[0];
              let flashAvailable = false;
              try {
                const capabilities = track.getCapabilities?.() as
                  | (MediaTrackCapabilities & { torch?: boolean })
                  | undefined;
                flashAvailable = Boolean(capabilities?.torch);
              } catch {
                /* Optional capability discovery must not block a working camera. */
              }
              this.emit({ phase: "active", message: "Camera ready", flashAvailable });
              this.watch(attempt, video);
              this.onActive();
              // Enumerate only after permission; this never opens a temporary stream.
              void navigator.mediaDevices
                .enumerateDevices?.()
                .then((devices) => {
                  if (this.current(attempt))
                    this.emit({
                      cameras: devices
                        .filter((d) => d.kind === "videoinput")
                        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` })),
                    });
                })
                .catch(() => undefined);
            };
            waitForFrames();
          })
          .catch((error: unknown) => {
            if (this.current(attempt)) this.end("error", cameraErrorMessage(error));
          });
      } catch (error) {
        this.end("error", cameraErrorMessage(error));
      }
    };
    this.later(attempt, waitForVideo, 0);
  }

  private watch(attempt: Attempt, video: HTMLVideoElement) {
    const listen = (target: EventTarget, type: string, listener: () => void) => {
      target.addEventListener(type, listener);
      attempt.removeListeners.push(() => target.removeEventListener(type, listener));
    };
    const failed = () => {
      if (this.current(attempt))
        this.end(
          "error",
          "The camera stopped. Check its permission, then tap Retry camera or use a badge photo.",
        );
    };
    for (const track of tracks(video)) listen(track, "ended", failed);
    listen(video, "error", failed);
    const width = video.videoWidth,
      height = video.videoHeight;
    listen(video, "resize", () => {
      if (this.current(attempt) && (video.videoWidth !== width || video.videoHeight !== height))
        this.end("paused", "The camera view changed. Tap Resume camera to refocus.");
    });
    let lastTime = video.currentTime,
      lastFrameAt = Date.now(),
      unhealthySince = 0;
    const check = () => {
      if (document.hidden) {
        this.background();
        return;
      }
      const live = tracks(video).some(
        (track) =>
          track.kind === "video" && track.readyState === "live" && !track.muted && track.enabled,
      );
      const healthy =
        live &&
        videoIsVisible(video) &&
        video.readyState >= 2 &&
        !video.paused &&
        !video.ended &&
        video.videoWidth > 0 &&
        video.videoHeight > 0;
      if (healthy && video.currentTime !== lastTime) lastFrameAt = Date.now();
      lastTime = video.currentTime;
      unhealthySince = healthy ? 0 : unhealthySince || Date.now();
      if (
        Date.now() - lastFrameAt >= CAMERA_STALL_TIMEOUT_MS ||
        (unhealthySince && Date.now() - unhealthySince >= CAMERA_STALL_TIMEOUT_MS)
      ) {
        this.end(
          "error",
          "The camera picture stopped updating. Tap Retry camera or use a badge photo.",
        );
        return;
      }
      this.later(attempt, check, 500);
    };
    this.later(attempt, check, 500);
  }

  toggleFlash = () => {
    const attempt = this.attempt;
    if (!attempt?.scanner || !attempt.video || !this.state.flashAvailable || this.state.flashBusy)
      return;
    // Stopping the stream is the dependable torch-off path on mobile browsers.
    if (this.state.flashOn) {
      this.begin(this.state.selectedCamera);
      return;
    }
    this.emit({ flashBusy: true });
    const timeout = this.later(
      attempt,
      () =>
        this.end("error", "The torch did not respond. Tap Retry camera to continue without it."),
      5_000,
    );
    void attempt.scanner
      .turnFlashOn()
      .then(
        () => {
          if (this.current(attempt)) this.emit({ flashOn: true, flashBusy: false });
        },
        () => {
          if (this.current(attempt))
            this.emit({
              flashAvailable: false,
              flashBusy: false,
              message: "Torch unavailable. Move to better light or use a badge photo.",
            });
        },
      )
      .finally(() => {
        clearTimeout(timeout);
        attempt.timers.delete(timeout);
      });
  };
}
