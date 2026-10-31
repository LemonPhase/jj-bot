import { RUNTIME_STATUS } from "@jj/runtime";

console.info(
  `JJ worker started in scaffold mode (runtime: ${RUNTIME_STATUS}). No jobs are being claimed.`,
);
const heartbeat = setInterval(() => {}, 60_000);
function shutdown() {
  clearInterval(heartbeat);
  console.info("JJ worker stopped.");
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
