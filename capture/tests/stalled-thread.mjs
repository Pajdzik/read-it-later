// A synchronous blocked thread cannot cooperate with a Promise timeout.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
