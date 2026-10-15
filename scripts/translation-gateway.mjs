import { spawn } from "node:child_process";
import path from "node:path";
const python = path.resolve("local-ai/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const child = spawn(python, ["-m", "uvicorn", "server:app", "--app-dir", "local-ai", "--host", "127.0.0.1", "--port", "8765"], {
  cwd: process.cwd(), env: { ...process.env, PYTHONUTF8: "1", HF_HUB_DISABLE_TELEMETRY: "1" }, windowsHide: true, stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error("Gateway kunde inte startas:", error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code || 0; });
