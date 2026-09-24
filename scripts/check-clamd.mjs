import { connect } from "node:net";

const socket = connect({ host: "127.0.0.1", port: 3310 });
socket.setTimeout(2_000);
let response = "";
socket.on("connect", () => socket.write("zPING\0"));
socket.on("data", (chunk) => { response += chunk.toString(); });
socket.on("error", () => { process.exitCode = 1; });
socket.on("timeout", () => socket.destroy(new Error("clamd timed out")));
socket.on("close", () => {
  if (response !== "PONG\0") process.exitCode = 1;
});