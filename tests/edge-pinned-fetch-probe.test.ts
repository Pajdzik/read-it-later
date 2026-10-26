import { describe, expect, it } from "vitest";
import { classifyConnectionError, classifyTlsError, isProbeEnabled, isProbeRequest } from "../probes/edge-pinned-fetch/guard";

describe("fixed-target edge fetch probe guard", () => {
  it("stays disabled for zero, invalid, non-finite, and expired deadlines", () => {
    const now = 1_800_000_000_000;
    for (const value of [undefined, "", "0", "nope", "Infinity", String(now)]) {
      expect(isProbeEnabled(value, now)).toBe(false);
    }
    expect(isProbeEnabled(String(now + 1), now)).toBe(true);
  });

  it("accepts only the fixed GET endpoint without query input", () => {
    expect(isProbeRequest(new Request("https://probe.example/probe"))).toBe(true);
    expect(isProbeRequest(new Request("https://probe.example/probe?url=https://example.com"))).toBe(false);
    expect(isProbeRequest(new Request("https://probe.example/probe", { method: "POST" }))).toBe(false);
    expect(isProbeRequest(new Request("https://probe.example/anything"))).toBe(false);
  });

  it("reduces runtime errors to coarse fixed outcomes", () => {
    expect(classifyTlsError("The expectedServerHostname option is not currently supported in startTls.")).toBe("option_rejected");
    expect(classifyTlsError("TLS certificate verification failed for github.com")).toBe("tls_rejected");
    expect(classifyTlsError("probe_timeout")).toBe("timeout");
    expect(classifyTlsError("private runtime detail with account data")).toBe("connection_error");
    expect(classifyTlsError("private runtime detail with account data")).toBe("connection_error");
    expect(classifyConnectionError("probe_timeout")).toBe("timeout");
    expect(classifyConnectionError("private runtime detail with account data")).toBe("connection_error");
  });
});
