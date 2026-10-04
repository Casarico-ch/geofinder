// Runs export-shrink off the main thread: re-encoding a run's pictures takes
// seconds of CPU, which would otherwise stall every live investigation.
import { parentPort } from "node:worker_threads";
import { shrink, type Picture } from "./export-shrink";

parentPort?.on("message", (msg: { id: number; media: string; data: Uint8Array }) => {
  const pic = { media: msg.media, data: Buffer.from(msg.data) };
  const out = shrink(pic);
  parentPort!.postMessage({ id: msg.id, changed: out !== pic, data: out === pic ? new Uint8Array() : out.data });
});
