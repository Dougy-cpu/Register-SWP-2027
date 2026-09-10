import { Camera, CameraOff, Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { useBadgeCamera } from "@/hooks/use-badge-camera";

export function BadgeCameraView({
  camera,
  startLabel,
  onStart,
  disabled = false,
}: {
  camera: ReturnType<typeof useBadgeCamera>;
  startLabel: string;
  onStart: () => void;
  disabled?: boolean;
}) {
  const active = camera.phase === "active",
    starting = camera.phase === "starting";
  return (
    <section className="space-y-3" aria-label="Badge camera">
      <div
        className={`relative h-[48svh] overflow-hidden rounded-2xl border border-white/15 bg-black ${camera.phase === "error" ? "min-h-[26rem]" : camera.phase === "paused" ? "min-h-[22rem]" : "min-h-64"}`}
      >
        <video
          key={camera.session}
          data-camera-session={camera.session}
          ref={camera.videoRef}
          className="absolute inset-0 h-full w-full object-cover"
          muted
          playsInline
          aria-label="Live badge camera"
        />
        {!active && (
          <div className="absolute inset-0 grid place-items-center bg-slate-950/90 p-5 text-center">
            <div className="space-y-4">
              <Camera className="mx-auto h-10 w-10 text-blue-300" />
              <p
                className="text-base text-slate-200"
                role={camera.phase === "error" ? "alert" : "status"}
              >
                {camera.message || "Point your phone at the whole badge QR code."}
              </p>
              <Button
                className="h-14 w-full px-6 text-base"
                onClick={onStart}
                disabled={disabled || starting}
              >
                {starting
                  ? "Starting camera…"
                  : camera.phase === "paused"
                    ? "Resume camera"
                    : camera.phase === "error"
                      ? "Retry camera"
                      : startLabel}
              </Button>
              {starting && (
                <Button variant="secondary" className="h-12 w-full" onClick={camera.stop}>
                  Cancel camera start
                </Button>
              )}
            </div>
          </div>
        )}
        {active && (
          <>
            <p
              role="status"
              className="absolute inset-x-0 top-0 bg-black/60 p-3 text-center text-sm text-white"
            >
              {camera.message}
            </p>
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="aspect-square w-[78%] max-w-md rounded-3xl border-[3px] border-white shadow-[0_0_0_999px_rgba(0,0,0,0.18)]" />
            </div>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-xs text-slate-300">
          Camera
          <select
            className="mt-1 h-12 w-full rounded-lg border border-white/30 bg-slate-900 px-3 text-base text-white"
            value={camera.selectedCamera}
            disabled={disabled || starting}
            onChange={(event) => camera.selectCamera(event.target.value)}
          >
            <option value="environment">Rear camera</option>
            <option value="user">Front camera</option>
            {camera.cameras
              .filter((item) => item.id)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
          </select>
        </label>
        {active && (
          <>
            {camera.flashAvailable && (
              <Button
                variant="secondary"
                className="h-12 min-w-12"
                disabled={camera.flashBusy}
                onClick={camera.toggleFlash}
                aria-label="Toggle torch"
                aria-pressed={camera.flashOn}
              >
                <Lightbulb className="h-5 w-5" />
              </Button>
            )}
            <Button variant="secondary" className="h-12" onClick={camera.stop}>
              <CameraOff className="h-5 w-5" /> Stop camera
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
