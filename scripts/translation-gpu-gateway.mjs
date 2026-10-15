import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import console from "node:console";

const python = path.resolve("local-ai/.venv-gpu", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const port = Number(process.env.STUDIO_GPU_GATEWAY_PORT || 8766);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("STUDIO_GPU_GATEWAY_PORT måste vara 1024–65535.");
const child = spawn(python, ["local-ai/run_gpu_gateway.py", "--port", String(port)], {
  cwd: process.cwd(), env: { ...process.env, PYTHONUTF8: "1", HF_HUB_DISABLE_TELEMETRY: "1" }, windowsHide: true, stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error("GPU-gateway kunde inte startas:", error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code || 0; });
