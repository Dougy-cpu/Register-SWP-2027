import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BadgeCameraController,
  CAMERA_START_TIMEOUT_MS,
  CAMERA_STALL_TIMEOUT_MS,
  cameraErrorMessage,
} from "./badge-camera";
import { cameraMock, installCameraMock, latestCamera } from "@/test/badge-camera-mock";
import { BADGE_SCANNER_OPTIONS } from "./scanner-camera";

vi.mock("qr-scanner", async () => ({
  default: (await import("@/test/badge-camera-mock")).MockQrScanner,
}));
let dispose = () => undefined as void;
beforeEach(() => {
  installCameraMock();
  vi.useFakeTimers();
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function harness(mountVideo = true) {
  let video: HTMLVideoElement | null = null;
  const controller = new BadgeCameraController((state) => {
    if (mountVideo && video?.dataset.cameraSession !== String(state.session)) attach();
  });
  function attach() {
    video?.remove();
    video = document.createElement("video");
    video.dataset.cameraSession = String(controller.state.session);
    document.body.append(video);
    controller.attachVideo(video);
  }
  dispose = controller.mount();
  controller.onDecode = vi.fn();
  controller.onActive = vi.fn();
  return { controller, attach, video: () => video };
}
const tick = (ms = 101) => vi.advanceTimersByTimeAsync(ms);

describe("bounded camera lifecycle", () => {
  it("handles qr-scanner's masked camera error without misdiagnosing hardware", () => {
    expect(cameraErrorMessage("Camera not found.")).toContain("Camera permission");
    expect(cameraErrorMessage("Camera not found.")).toContain("close other camera apps");
  });
  it("handles a browser without camera APIs", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    const { controller } = harness();
    controller.start();
    await tick();
    expect(controller.state.phase).toBe("error");
    expect(controller.state.message).toContain("Safari or Chrome over HTTPS");
    expect(cameraMock.start).not.toHaveBeenCalled();
  });
  it("bounds a torch request that never settles", async () => {
    cameraMock.torch = true;
    cameraMock.flash.mockImplementation(() => new Promise(() => undefined));
    const { controller } = harness();
    controller.start();
    await tick();
    controller.toggleFlash();
    await tick(5_001);
    expect(controller.state.phase).toBe("error");
    expect(controller.state.message).toContain("torch did not respond");
    expect(latestCamera().track.readyState).toBe("ended");
  });
  it("waits for a temporarily missing ref and then starts", async () => {
    const { controller, attach } = harness(false);
    controller.start();
    await tick(300);
    expect(controller.state.phase).toBe("starting");
    expect(cameraMock.start).not.toHaveBeenCalled();
    attach();
    await tick();
    expect(controller.state.phase).toBe("active");
  });
  it("makes a permanently missing ref a recoverable error with no restart loop", async () => {
    const { controller } = harness(false);
    controller.start();
    await tick(CAMERA_START_TIMEOUT_MS);
    expect(controller.state.phase).toBe("error");
    expect(controller.state.message).toContain("Retry camera");
    await tick(CAMERA_START_TIMEOUT_MS * 2);
    expect(cameraMock.start).not.toHaveBeenCalled();
  });
  it.each(["display", "visibility", "zero-size"])(
    "never constructs against %s video",
    async (kind) => {
      const { controller, video } = harness();
      controller.start();
      if (kind === "display") video()!.style.display = "none";
      if (kind === "visibility") video()!.style.visibility = "hidden";
      if (kind === "zero-size")
        vi.spyOn(HTMLVideoElement.prototype, "getBoundingClientRect").mockReturnValue({
          width: 0,
          height: 0,
        } as DOMRect);
      await tick(500);
      expect(cameraMock.instances).toHaveLength(0);
      if (kind === "zero-size")
        vi.spyOn(HTMLVideoElement.prototype, "getBoundingClientRect").mockReturnValue({
          width: 360,
          height: 400,
        } as DOMRect);
      else video()!.removeAttribute("style");
      await tick();
      expect(controller.state.phase).toBe("active");
      expect(latestCamera().options).toMatchObject(BADGE_SCANNER_OPTIONS);
    },
  );
  it("bounds an unresolved start, ignores late permission and permits retry", async () => {
    let allow!: () => void;
    cameraMock.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          allow = resolve;
        }),
    );
    const { controller } = harness();
    controller.start();
    await tick();
    const old = latestCamera();
    await tick(CAMERA_START_TIMEOUT_MS);
    expect(controller.state.phase).toBe("error");
    controller.start();
    await tick();
    const current = latestCamera();
    allow();
    await tick(500);
    old.decode({ data: "FACADE000001" });
    expect(controller.onDecode).not.toHaveBeenCalled();
    expect(current.video).not.toBe(old.video);
    expect(current.track.readyState).toBe("live");
    expect(old.track.readyState).toBe("ended");
    expect(controller.state.phase).toBe("active");
  });
  it("deduplicates start taps and isolates old delayed stops from new streams", async () => {
    const { controller } = harness();
    controller.start();
    controller.start();
    controller.start();
    await tick();
    expect(cameraMock.start).toHaveBeenCalledTimes(1);
    const old = latestCamera();
    controller.stop();
    controller.start();
    controller.stop();
    controller.start();
    await tick(600);
    expect(controller.state.phase).toBe("active");
    expect(latestCamera().track.readyState).toBe("live");
    expect(latestCamera().video).not.toBe(old.video);
    expect(old.track.readyState).toBe("ended");
  });
  it("releases resources on unmount, ignores stale callbacks, and supports remount", async () => {
    const { controller } = harness();
    controller.start();
    await tick();
    const old = latestCamera();
    dispose();
    old.decode({ data: "FACADE000001" });
    expect(controller.onDecode).not.toHaveBeenCalled();
    expect(old.track.readyState).toBe("ended");
    dispose = controller.mount();
    controller.start();
    await tick(600);
    expect(controller.state.phase).toBe("active");
    expect(latestCamera().video.srcObject).not.toBeNull();
  });
  it("bounds missing intrinsic frames even when start resolves", async () => {
    vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(0);
    const { controller } = harness();
    controller.start();
    await tick(CAMERA_START_TIMEOUT_MS + 1);
    expect(controller.state.phase).toBe("error");
    expect(controller.onActive).not.toHaveBeenCalled();
    expect(latestCamera().track.readyState).toBe("ended");
  });
  it.each(["ended", "error", "mute", "frozen", "paused"])(
    "recovers from %s streams without loops",
    async (kind) => {
      const { controller, video } = harness();
      controller.start();
      await tick();
      if (kind === "ended") latestCamera().track.dispatchEvent(new Event("ended"));
      if (kind === "error") video()!.dispatchEvent(new Event("error"));
      if (kind === "mute") latestCamera().track.muted = true;
      if (kind === "frozen")
        vi.spyOn(HTMLVideoElement.prototype, "currentTime", "get").mockReturnValue(0);
      if (kind === "paused")
        vi.spyOn(HTMLVideoElement.prototype, "paused", "get").mockReturnValue(true);
      await tick(CAMERA_STALL_TIMEOUT_MS + 1000);
      expect(controller.state.phase).toBe("error");
      expect(controller.state.message).toContain("Retry camera");
      expect(latestCamera().track.readyState).toBe("ended");
      expect(cameraMock.start).toHaveBeenCalledTimes(1);
    },
  );
  it("tolerates brief low-light track muting", async () => {
    const { controller } = harness();
    controller.start();
    await tick();
    latestCamera().track.muted = true;
    await tick(2000);
    latestCamera().track.muted = false;
    await tick(1000);
    expect(controller.state.phase).toBe("active");
  });
  it.each(["visibilitychange", "pagehide"])(
    "pauses on %s and requires one explicit resume",
    async (type) => {
      const { controller } = harness();
      controller.start();
      await tick();
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      (type === "pagehide" ? window : document).dispatchEvent(new Event(type));
      expect(controller.state.phase).toBe("paused");
      expect(latestCamera().track.readyState).toBe("ended");
      vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pageshow"));
      await tick(1000);
      expect(cameraMock.start).toHaveBeenCalledTimes(1);
      controller.start();
      await tick();
      expect(controller.state.phase).toBe("active");
    },
  );
  it("offers resume after intrinsic orientation changes or a removed video", async () => {
    const { controller, video } = harness();
    controller.start();
    await tick();
    vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(720);
    video()!.dispatchEvent(new Event("resize"));
    expect(controller.state.phase).toBe("paused");
    controller.start();
    await tick();
    controller.attachVideo(null);
    expect(controller.state.phase).toBe("paused");
    expect(latestCamera().track.readyState).toBe("ended");
  });
  it("selects rear/front and enumerated cameras using fresh sessions", async () => {
    const { controller } = harness();
    controller.start();
    await tick();
    expect(controller.state.cameras).toHaveLength(2);
    controller.selectCamera("user");
    await tick();
    expect(latestCamera().options.preferredCamera).toBe("user");
    controller.selectCamera("rear1");
    await tick();
    expect(latestCamera().options.preferredCamera).toBe("rear1");
    expect(cameraMock.instances.filter((item) => item.track.readyState === "live")).toHaveLength(1);
  });
  it("handles torch support, rapid toggles and torch-off with bounded fresh startup", async () => {
    cameraMock.torch = true;
    const { controller } = harness();
    controller.start();
    await tick();
    controller.toggleFlash();
    controller.toggleFlash();
    await tick();
    expect(cameraMock.flash).toHaveBeenCalledTimes(1);
    expect(controller.state.flashOn).toBe(true);
    controller.toggleFlash();
    await tick(500);
    expect(controller.state.flashOn).toBe(false);
    expect(controller.state.phase).toBe("active");
  });
  it("handles optional torch/enumeration failure without breaking scanning", async () => {
    cameraMock.torch = true;
    cameraMock.flash.mockRejectedValue("No flash available");
    vi.spyOn(navigator.mediaDevices, "enumerateDevices").mockRejectedValue(
      new Error("unavailable"),
    );
    const { controller } = harness();
    controller.start();
    await tick();
    controller.toggleFlash();
    await tick();
    expect(controller.state.phase).toBe("active");
    expect(controller.state.flashAvailable).toBe(false);
    expect(controller.state.message).toContain("Torch unavailable");
  });
  it("ignores normal no-code frames but surfaces a broken decoder", async () => {
    const { controller } = harness();
    controller.start();
    await tick();
    for (let i = 0; i < 10; i++) latestCamera().error("No QR code found");
    expect(controller.state.phase).toBe("active");
    for (let i = 0; i < 3; i++) latestCamera().error("Worker failed");
    expect(controller.state.phase).toBe("error");
  });
  it.each([
    "NotAllowedError",
    "NotFoundError",
    "NotReadableError",
    "AbortError",
    "NotSupportedError",
  ])("makes %s actionable", async (name) => {
    cameraMock.start.mockRejectedValue(new DOMException("camera failure", name));
    const { controller } = harness();
    controller.start();
    await tick();
    expect(controller.state.phase).toBe("error");
    expect(controller.state.message).toMatch(/Retry camera|another camera/);
    expect(latestCamera().track.readyState).toBe("ended");
    expect(cameraErrorMessage(name)).toBe(controller.state.message);
  });
});
