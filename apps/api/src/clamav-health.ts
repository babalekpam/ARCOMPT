import { connect } from "node:net";

/** A successful TCP connect alone does not prove clamd loaded its signatures. */
export function checkClamd(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let response = "";
    socket.setTimeout(1_500, () => socket.destroy(new Error("clamd timed out")));
    socket.on("connect", () => socket.write("zPING\0"));
    socket.on("data", (chunk) => { response += chunk.toString(); });
    socket.on("error", reject);
    socket.on("close", () => {
      if (response === "PONG\0") resolve();
      else reject(new Error("clamd did not answer PONG"));
    });
  });
}