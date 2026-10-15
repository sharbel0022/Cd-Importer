import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { boundedJson, guardRequest } from "@/lib/request";
import { ffmpeg, inputArgs, speechDuration } from "@/lib/translation/media";
import { resolveVoice, synthesize, validateOptions } from "@/lib/translation/providers";
import { optionsSchema } from "@/lib/translation/types";

export const runtime = "nodejs";
export const maxDuration = 300;
const previewSchema = z.object({ text: z.string().trim().min(1).max(400), options: optionsSchema }).strict();

export async function POST(request: Request) {
  let dir: string | undefined;
  try {
    guardRequest(request, "studio-preview", true);
    const parsed = previewSchema.safeParse(await boundedJson(request, 16_384));
    if (!parsed.success) throw new AppError("Ange en kort förhandslyssningstext och giltiga röstinställningar.");
    const { text, options } = parsed.data;
    if (options.targets.length !== 1 || options.preserveVoice || options.mode === "subtitles") throw new AppError("Förhandslyssning använder ett språk och en installerad AI-standardröst.");
    const caps = await validateOptions(options);
    const voice = resolveVoice(options.targets[0], options, caps);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(240_000)]);
    const audio = await synthesize(text, options.targets[0], voice, signal, undefined, options);
    dir = await mkdtemp(path.join(os.tmpdir(), "cd-voice-preview-"));
    const source = path.join(dir, "speech.wav"); const output = path.join(dir, "preview.wav");
    await writeFile(source, audio);
    await speechDuration(source, signal);
    await ffmpeg([...inputArgs(source), "-af", `atempo=${options.speechRate},loudnorm=I=-16:TP=-1.5:LRA=11`, "-c:a", "pcm_s16le", output], signal);
    return new Response(new Uint8Array(await readFile(output)), { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Studio-Voice": voice } });
  } catch (e) { return errorResponse(e); }
  finally { if (dir) await rm(dir, { recursive: true, force: true }); }
}
