import { useEffect, useLayoutEffect, useState } from "react";
import { BadgeCameraController, INITIAL_CAMERA_STATE } from "@/lib/badge-camera";

export function useBadgeCamera(onDecode: (value: string) => void, onActive?: () => void) {
  const [state, setState] = useState(INITIAL_CAMERA_STATE);
  const [controller] = useState(() => new BadgeCameraController(setState));
  useLayoutEffect(() => {
    controller.onDecode = onDecode;
    controller.onActive = onActive ?? (() => undefined);
  }, [controller, onDecode, onActive]);
  useEffect(() => controller.mount(), [controller]);
  return {
    ...state,
    start: controller.start,
    stop: controller.stop,
    selectCamera: controller.selectCamera,
    toggleFlash: controller.toggleFlash,
    isSessionActive: controller.isSessionActive,
    videoRef: controller.attachVideo,
  };
}
