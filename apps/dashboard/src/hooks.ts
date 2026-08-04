import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { openProjectSocket } from "@crossagent/client";
import { useUi } from "./store.js";

export function useProjectSocket(projectId: string | null, lastSequence = 0): void {
  const queryClient = useQueryClient();
  const setConnected = useUi((state) => state.setConnected);
  const setStale = useUi((state) => state.setStale);

  useEffect(() => {
    if (!projectId) return;
    let closedByEffect = false;
    let retry: number | undefined;
    const connect = () => {
      const socket = openProjectSocket({
        baseUrl: window.location.origin,
        projectId,
        clientType: "dashboard",
        lastSequence,
        onFrame(frame) {
          if (frame.type === "subscribed") {
            setConnected(true);
            setStale(false);
          }
          if (frame.type === "resync_required") setStale(true);
          if (frame.type === "event") {
            void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
          }
        },
        onClose() {
          setConnected(false);
          if (!closedByEffect) retry = window.setTimeout(connect, 1200);
        },
      });
      return socket;
    };
    const socket = connect();
    return () => {
      closedByEffect = true;
      if (retry) window.clearTimeout(retry);
      socket.close();
    };
  }, [lastSequence, projectId, queryClient, setConnected, setStale]);
}
