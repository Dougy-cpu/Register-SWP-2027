import { vi } from "vitest";
import type QrScanner from "qr-scanner";

export const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
export const cameraMock = {
  instances: [] as MockQrScanner[],
  start: vi.fn(),
  photo: vi.fn(),
  flash: vi.fn(),
  torch: false,
};
export class MockTrack extends EventTarget {
  kind = "video";
  readyState = "live";
  muted = false;
  enabled = true;
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  getCapabilities = () => ({ torch: cameraMock.torch });
}
export class MockQrScanner {
  static NO_QR_CODE_FOUND = "No QR code found";
  static scanImage = cameraMock.photo;
  track = new MockTrack();
  destroyed = false;
  $overlay = document.createElement("div");
  constructor(
    public video: HTMLVideoElement,
    public decode: (value: { data: string }) => void,
    public options: Record<string, unknown>,
  ) {
    const style = getComputedStyle(video);
    if (
      !video.isConnected ||
      style.display === "none" ||
      style.visibility !== "visible" ||
      video.getBoundingClientRect().width <= 1
    )
      throw new Error("Scanner constructed with invisible video");
    cameraMock.instances.push(this);
  }
  start = async () => {
    await cameraMock.start(this);
    if (this.destroyed) {
      this.track.stop();
      return;
    }
    this.video.srcObject = {
      getTracks: () => [this.track],
      getVideoTracks: () => [this.track],
    } as unknown as MediaStream;
  };
  pause = vi.fn(async (immediate = false) => {
    if (immediate) {
      this.track.stop();
      this.video.srcObject = null;
    }
    return true;
  });
  // Match qr-scanner's delayed cleanup, including its unsafe use of the video ref.
  stop = vi.fn(() => {
    setTimeout(() => {
      const stream = this.video.srcObject as MediaStream | null;
      stream?.getTracks().forEach((track) => track.stop());
      this.video.srcObject = null;
    }, 300);
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.stop();
  });
  hasFlash = async () => cameraMock.torch;
  turnFlashOn = cameraMock.flash;
  error(value: string) {
    (this.options.onDecodeError as (value: string) => void)(value);
  }
}

export function installCameraMock() {
  vi.restoreAllMocks();
  cameraMock.instances = [];
  cameraMock.start.mockReset().mockResolvedValue(undefined);
  cameraMock.photo.mockReset();
  cameraMock.flash.mockReset().mockResolvedValue(undefined);
  cameraMock.torch = false;
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(),
      enumerateDevices: vi.fn(async () => [
        { kind: "videoinput", deviceId: "rear1", label: "Back camera" },
        { kind: "videoinput", deviceId: "front1", label: "Front camera" },
      ]),
    },
  });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLVideoElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 360,
    height: 400,
  } as DOMRect);
  for (const [key, value] of Object.entries({
    videoWidth: 1280,
    videoHeight: 720,
    readyState: 4,
    paused: false,
    ended: false,
  })) {
    vi.spyOn(HTMLVideoElement.prototype, key as "videoWidth", "get").mockReturnValue(
      value as number,
    );
  }
  vi.spyOn(HTMLVideoElement.prototype, "currentTime", "get").mockImplementation(
    () => Date.now() / 1000,
  );
}
export function latestCamera() {
  return cameraMock.instances.at(-1)!;
}
export type CameraOptions = ConstructorParameters<typeof QrScanner>;
