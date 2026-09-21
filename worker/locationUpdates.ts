import type { ListeningPort } from "../shared/types";
import { applyCachedLocations, enrichLocations } from "./monitor";

// A slow provider must never hold the sampling lock or publish stale counters.
export function createLocationUpdates<T extends { listeningPorts: ListeningPort[] }>(
  publish: (sample: T) => void,
  lookup = enrichLocations,
  applyCache = applyCachedLocations
) {
  let latest: T | null = null;
  let running = false;
  let closed = false;
  return {
    update(sample: T) {
      if (closed) return;
      latest = sample;
      applyCache(sample.listeningPorts);
      publish(sample);
      if (running || !sample.listeningPorts.some(port => port.connectedIps.some(peer => !peer.region))) return;
      running = true;
      void lookup(sample.listeningPorts).then(() => {
        if (closed || !latest) return;
        applyCache(latest.listeningPorts);
        publish(latest);
      }).catch(() => {}).finally(() => { running = false; });
    },
    close() { closed = true; latest = null; }
  };
}
