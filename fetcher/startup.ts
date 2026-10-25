import { CONTAINER_STARTUP_TIMEOUT_MS } from "../src/articles/capture-limits.js";

export class ContainerStartupError extends Error {
  constructor(readonly code: "timeout" | "network_error") {
    super(code);
    this.name = "ContainerStartupError";
  }
}

/** Bound readiness independently of the subsequent upstream network request. */
export async function waitForContainerReady(
  start: (signal: AbortSignal) => Promise<void>,
  callerSignal: AbortSignal,
  timeoutMs = CONTAINER_STARTUP_TIMEOUT_MS,
): Promise<void> {
  if (callerSignal.aborted) throw new ContainerStartupError("timeout");
  const controller = new AbortController();
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      controller.abort();
      reject(new ContainerStartupError("timeout"));
    };
  });
  callerSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const started = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new ContainerStartupError("timeout");
      return start(controller.signal);
    });
    await Promise.race([started, aborted]);
    if (controller.signal.aborted) throw new ContainerStartupError("timeout");
  } catch (error) {
    if (controller.signal.aborted) throw new ContainerStartupError("timeout");
    if (error instanceof ContainerStartupError) throw error;
    throw new ContainerStartupError("network_error");
  } finally {
    clearTimeout(timer);
    callerSignal.removeEventListener("abort", abort);
  }
}
