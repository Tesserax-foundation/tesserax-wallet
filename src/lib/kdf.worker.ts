/// <reference lib="webworker" />
// Argon2id off the main thread: 64 MiB and three passes take a second or two.

import { argon2id } from "@noble/hashes/argon2.js";

export interface KdfRequest {
  password: string;
  salt: Uint8Array;
  memoryKib: number;
  iterations: number;
  parallelism: number;
}

self.onmessage = (event: MessageEvent<KdfRequest>) => {
  const { password, salt, memoryKib, iterations, parallelism } = event.data;
  try {
    const key = argon2id(password, salt, { m: memoryKib, t: iterations, p: parallelism, dkLen: 32 });
    self.postMessage({ key });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
