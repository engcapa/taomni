import { describe, expect, it } from "vitest";
import type { SockscapStatsSeriesPoint, SockscapStatsTotals } from "./sockscap";
import {
  downsampleSockscapSeries,
  formatSockscapBytes,
  latestSockscapEgressHealth,
  sockscapActionBreakdown,
} from "./sockscapDashboard";

const point = (bucketStart: number): SockscapStatsSeriesPoint => ({
  bucketStart,
  resolutionSeconds: 60,
  bytesUp: 10,
  bytesDown: 30,
  connections: 2,
  errors: 0,
  directConnections: 1,
  proxyConnections: 1,
  blockedConnections: 0,
});

describe("Sockscap dashboard helpers", () => {
  it("bounds chart points while preserving aggregate counters", () => {
    const result = downsampleSockscapSeries(Array.from({ length: 240 }, (_, index) => point(index)), 96);
    expect(result.length).toBeLessThanOrEqual(96);
    expect(result.reduce((sum, item) => sum + item.bytesUp, 0)).toBe(2_400);
    expect(result.reduce((sum, item) => sum + item.connections, 0)).toBe(480);
    expect(result[0].bucketStart).toBe(0);
    expect(result.at(-1)?.bucketStart).toBeGreaterThan(0);
  });

  it("keeps unknown-hostname attribution separate from mutually exclusive actions", () => {
    const totals: SockscapStatsTotals = {
      bytesUp: 0,
      bytesDown: 0,
      connections: 10,
      errors: 0,
      directConnections: 3,
      proxyConnections: 5,
      blockedConnections: 2,
      unknownHostnameConnections: 4,
      connectMillisTotal: 0,
    };
    expect(sockscapActionBreakdown(totals)).toEqual({
      direct: 3,
      proxy: 5,
      block: 2,
      unknownHostname: 4,
      classifiedTotal: 10,
    });
  });

  it("selects the latest health point for each profile", () => {
    const base = {
      egressKind: "ssh_jump",
      controlState: "healthy",
      activeControlsMax: 1,
      activeChannelsMax: 1,
      channelErrors: 0,
      reconnects: 0,
      bytesUp: 0,
      bytesDown: 0,
      handshakeMillisTotal: 0,
      handshakeSamples: 0,
      hostKeyState: "verified",
      lastErrorCode: null,
    };
    expect(latestSockscapEgressHealth([
      { ...base, bucketStart: 1, profileId: "b" },
      { ...base, bucketStart: 3, profileId: "a" },
      { ...base, bucketStart: 2, profileId: "a", controlState: "degraded" },
    ])).toEqual([
      expect.objectContaining({ profileId: "a", bucketStart: 3, controlState: "healthy" }),
      expect.objectContaining({ profileId: "b", bucketStart: 1 }),
    ]);
  });

  it("formats finite byte totals compactly", () => {
    expect(formatSockscapBytes(0)).toBe("0 B");
    expect(formatSockscapBytes(1536)).toBe("1.5 KB");
    expect(formatSockscapBytes(Number.NaN)).toBe("0 B");
  });
});
