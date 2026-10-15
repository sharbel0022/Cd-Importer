import { createHash } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { AppError } from "../errors";
import { atomicJson, durationLimit, enforceQuota, jobDir, readJob, updateJob } from "./store";
import { capabilities, describeVideo, diarize, separate, synthesize, transcribe, translate, TranslationIntegrityError, validateOptions, type Turn } from "./providers";
import { chunk, createTimeline, ffmpeg, inputArgs, inspect, normalize, placeSpeech, renderTrack, renderVideo, speechDuration, trimSpeech, waveform } from "./media";
import { subtitles, timingPlan, type Job, type Segment, type Stage, type Translation } from "./types";
import { shorteningPreservesAnchors } from "./meaning";

async function exists(file: string) { try { return (await stat(file)).size > 0; } catch { return false; } }
function hash(text: string) { return createHash("sha256").update(text).digest("hex").slice(0, 32); }
// Whisper can split a single spoken thought into sub-second fragments. Group
// adjacent fragments before translation so context and the time budget agree.
export function phraseSegments(segments: Segment[]): Segment[] {
  const result: Segment[] = [];
  for (const segment of segments) {
    const last = result.at(-1);
    if (last && last.speaker === segment.speaker && last.end - last.start < 2.5 && segment.start - last.end >= -0.04 && segment.start - last.end <= 0.4 && segment.end - last.start <= 7.5 && !/[.!?؟。]$/.test(last.text.trim())) {
      last.text += ` ${segment.text}`; last.end = segment.end; last.uncertain ||= segment.uncertain;
      if (last.rawText || segment.rawText) last.rawText = `${last.rawText || last.text.slice(0, -(segment.text.length + 1))} ${segment.rawText || segment.text}`;
      if (last.words && segment.words) last.words.push(...segment.words); else last.words = undefined;
    } else result.push({ ...segment, words: segment.words ? [...segment.words] : undefined });
  }
  return result.map((s, i) => ({ ...s, id: `s${i + 1}` }));
}
export function speechWindow(segments: Segment[], index: number, duration: number) {
  const segment = segments[index];
  const boundary = Math.min(duration, segments[index + 1]?.start ?? duration);
  // Borrow at most 750 ms of silence, never another speaker's/segment's window.
  return Math.max(segment.end - segment.start, Math.min(segment.end + 0.75, boundary) - segment.start);
}
export function assignSpeakers(segments: Segment[], turns: Turn[]): Segment[] {
  function matches(start: number, end: number) { return turns.map((t) => ({ ...t, overlap: Math.max(0, Math.min(end, t.end) - Math.max(start, t.start)) })).filter((t) => t.overlap > 0).sort((a, b) => b.overlap - a.overlap); }
  const result: Segment[] = [];
  for (const segment of segments) {
    if (segment.words?.length) {
      let group: Segment | undefined;
      for (const word of segment.words) {
        const candidates = matches(word.start, word.end); const speaker = candidates[0]?.speaker || "unknown";
        if (!group || group.speaker !== speaker) { group = { id: "", start: word.start, end: word.end, text: word.word, speaker, uncertain: !!segment.uncertain || !candidates.length || candidates.length > 1, words: [word] }; result.push(group); }
        else { group.end = word.end; group.text += ` ${word.word}`; group.words!.push(word); group.uncertain ||= candidates.length > 1; }
      }
    } else {
      const candidates = matches(segment.start, segment.end);
      result.push({ ...segment, speaker: candidates[0]?.speaker || "unknown", uncertain: !!segment.uncertain || candidates.length !== 1 });
    }
  }
  return result.map((s, n) => ({ ...s, id: `s${n + 1}` }));
}
async function persistExports(job: Job) {
  const dir = jobDir(job.id);
  for (const target of job.options.targets) {
    const translations = job.translations[target];
    await writeFile(path.join(dir, `${target}.srt`), subtitles(job.segments, translations, "srt"));
    await writeFile(path.join(dir, `${target}.vtt`), subtitles(job.segments, translations, "vtt"));
    const lookup = new Map(translations.map((t) => [t.id, t]));
    await writeFile(path.join(dir, `${target}.txt`), job.segments.map((s) => `[${s.start.toFixed(3)}–${s.end.toFixed(3)}] ${s.speaker}\nOriginal: ${s.text}\n${lookup.get(s.id)?.text || ""}`).join("\n\n"));
    await atomicJson(path.join(dir, `${target}.json`), { sourceLanguage: job.detectedLanguage, targetLanguage: target, aiGenerated: true, segments: job.segments.map((s) => ({ ...s, translation: lookup.get(s.id) })), metrics: job.metrics, warnings: job.warnings });
  }
}
export async function runJob(id: string, externalSignal?: AbortSignal) {
  const controller = new AbortController(); const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  const monitor = setInterval(() => { void readJob(id).then((job) => { if (job.command) controller.abort(new Error(job.command)); }).catch(() => controller.abort()); }, 400);
  const started = Date.now(); let stageStart = started; let activeStage: Stage | undefined;
  let claimed = false;
  async function step(stage: Stage, message: string) {
    signal.throwIfAborted(); const now = Date.now();
    await updateJob(id, (j) => { if (activeStage) j.metrics.stages[activeStage] = (j.metrics.stages[activeStage] || 0) + now - stageStart; j.stage = stage; j.message = message; });
    activeStage = stage; stageStart = now;
  }
  try {
    let job = await updateJob(id, (j) => { if (j.status === "queued" && !j.command) { j.status = "running"; j.error = undefined; claimed = true; } });
    if (!claimed) return;
    await validateOptions(job.options);
    const dir = jobDir(id); const original = path.join(dir, `original.${job.extension}`); const normalized = path.join(dir, "normalized.wav");
    await step("transcribing", "Validerar media och extraherar ljudspåret.");
    if (!job.media) {
      const media = await inspect(original, signal, job.extension);
      if (media.duration > durationLimit()) throw new AppError(`Filen är längre än gränsen ${durationLimit()} sekunder.`, 413);
      await enforceQuota(media.duration * (32000 + job.options.targets.length * 288000 + (job.options.preserveBackground ? 384000 : 0)) + (media.video ? (await stat(original)).size * job.options.targets.length : 0));
      await normalize(original, normalized, signal, durationLimit(), job.extension);
      const wave = await waveform(normalized, dir, signal, media.duration);
      job = await updateJob(id, (j) => { j.media = { ...media, waveform: wave }; });
    }
    if (!(await exists(normalized))) await normalize(original, normalized, signal, durationLimit(), job.extension);
    const duration = job.media!.duration;
    const asrDuration = Math.min(duration, (await inspect(normalized, signal)).duration);
    if (job.media!.video && !job.segments.length && !job.sourceContext) {
      const frames: string[] = [];
      try {
        await step("transcribing", "Läser lokal bildkontext för ord och samtalsämne.");
        for (const [i, time] of [Math.min(0.5, duration / 4), duration / 2].entries()) {
          const frame = path.join(dir, `context-${i}.jpg`);
          await ffmpeg(["-ss", String(time), ...inputArgs(original), "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=640:-2", frame], signal);
          frames.push(frame);
        }
        const detail = path.join(dir, 'context-detail.jpg');
        await ffmpeg(["-ss", String(Math.min(0.5, duration / 4)), ...inputArgs(original), "-map", "0:v:0", "-frames:v", "1", "-vf", "crop=iw*0.6:ih*0.5:iw*0.2:ih*0.2,scale=640:-2", detail], signal);
        frames.push(detail);
        const sourceContext = await describeVideo(frames, signal);
        if (sourceContext) job = await updateJob(id, (j) => { j.sourceContext = sourceContext; });
      } catch (error) {
        if (signal.aborted) throw error;
        job = await updateJob(id, (j) => { j.warnings = [...new Set([...j.warnings, "Lokal bildkontext kunde inte läsas. Översättningen använder ljudet och samtalets text."])]; });
      } finally { for (const frame of frames) await rm(frame, { force: true }); }
    }
    if (!job.segments.length) {
      const all: Segment[] = []; const languages: string[] = [];
      const partSeconds = Math.max(10, Math.min(120, Number(process.env.STUDIO_ASR_CHUNK_SECONDS) || 60));
      for (let start = 0; start < asrDuration; start += partSeconds) {
        signal.throwIfAborted(); await step("transcribing", `Transkriberar ${Math.floor(start)}–${Math.min(Math.ceil(duration), start + partSeconds)} s av ${Math.ceil(duration)} s.`);
        const asrVersion = hash(JSON.stringify([process.env.WHISPER_MODEL, job.options.source, "beam5-temp-fallback-context-vad-ordinal-v4"]));
        const cache = path.join(dir, `asr-${start}-${partSeconds}-${asrVersion}.json`); let data: Awaited<ReturnType<typeof transcribe>>;
        if (await exists(cache)) data = JSON.parse(await readFile(cache, "utf8"));
        else { const part = path.join(dir, "asr-current.wav"); await chunk(normalized, part, start, Math.min(partSeconds, asrDuration - start), signal); data = await transcribe(part, job.options.source, signal, job.sourceContext?.arabicKeywords); await atomicJson(cache, data); await rm(part, { force: true }); }
        const speechSegments = data.segments.filter((s) => s.text.trim() && (s.no_speech_prob || 0) <= 0.8);
        if (data.language && speechSegments.length) languages.push(data.language);
        for (const s of speechSegments) {
          if (s.end <= s.start || s.start >= partSeconds || s.end > Math.min(partSeconds, duration - start) + 1) throw new AppError("ASR gav tidsstämplar utanför ljudet.", 502);
          const words = (s.words || data.words?.filter((w) => w.start >= s.start && w.end <= s.end))?.filter((w) => w.end > w.start && w.start >= 0 && w.end <= s.end + 0.1).map((w) => ({ ...w, start: w.start + start, end: Math.min(duration, w.end + start) }));
          all.push({ id: `s${all.length + 1}`, start: s.start + start, end: Math.min(duration, s.end + start), text: s.text.trim(), rawText: s.raw_text, speaker: "unknown", uncertain: s.uncertain || (s.avg_logprob !== undefined && s.avg_logprob < -0.8), words });
        }
        if (all.length > 6000) throw new AppError("Filen innehåller fler än 6 000 segment. Dela upp den.", 413);
      }
      if (!all.length) throw new AppError("Inget tal kunde identifieras. Ingen översättning skapades.", 422);
      let segments = all;
      if (job.options.diarize) {
        await step("transcribing", "Identifierar talare över hela inspelningen.");
        const diarizationAudio = path.join(dir, "diarization.mp3");
        await ffmpeg([...inputArgs(normalized), "-c:a", "libmp3lame", "-b:a", "32k", diarizationAudio], signal);
        if ((await stat(diarizationAudio)).size > 24 * 1024 ** 2) throw new AppError("Filen är för lång för sammanhängande talaridentifiering. Dela upp filen eller stäng av talaridentifiering.", 413);
        segments = assignSpeakers(all, await diarize(diarizationAudio, signal));
      }
      if (segments.length > 6000) throw new AppError("Talaridentifieringen gav fler än 6 000 segment. Dela upp filen.", 413);
      job = await updateJob(id, (j) => {
        j.segments = phraseSegments(segments); j.detectedLanguage = job.options.source === "auto" ? languages[0] || "okänt" : job.options.source;
        if (new Set(languages).size > 1) j.warnings.push("Flera källspråk identifierades i olika delar av filen.");
        if (!job.options.diarize) j.warnings.push("Talaridentifiering är avstängd. Okända talare använder samma standardröst.");
        if (segments.some((s) => s.rawText)) j.warnings.push("Arabisk stavning/böjning har språkgranskats automatiskt. Råtranskript finns i JSON-exporten; rättningarna är språkliga bedömningar.");
        if (segments.some((s) => s.uncertain)) j.warnings.push("Osäkra eller överlappande segment finns. Granska transkript och talaridentiteter.");
      });
    }
    for (const target of job.options.targets) {
      if (job.translations[target]?.length === job.segments.length) continue;
      const done = job.translations[target] || [];
      for (let i = done.length; i < job.segments.length; i += 6) {
        await step("translating", `Översätter till ${target}: segment ${i + 1} av ${job.segments.length}.`);
        const context = `Visual context (vocabulary only, never invent spoken facts):\n${job.sourceContext?.context || ""}\nWhole conversation (context only):\n${job.segments.map((s) => s.text).join("\n").slice(0, 3500)}\nEarlier source:\n${job.segments.slice(Math.max(0, i - 4), i).map((s) => s.text).join("\n")}\nFollowing source (context only):\n${job.segments.slice(i + 6, i + 10).map((s) => s.text).join("\n")}`;
        const translated = await translate(job.segments.slice(i, i + 6), target, job.options, context, signal);
        done.push(...translated); job = await updateJob(id, (j) => { j.translations[target] = [...done]; });
      }
    }
    let background: string | undefined;
    if (job.options.preserveBackground && job.options.mode === "replace") {
      background = path.join(dir, "background.wav");
      if (!(await exists(background))) {
        await step("generating", "Separerar bakgrund. Resultatet kan innehålla talrester och artefakter.");
        const separationSource = path.join(dir, "separation-source.wav");
        await ffmpeg([...inputArgs(original), "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", separationSource], signal);
        const response = await separate(separationSource, signal); let bytes = 0;
        await streamPipeline(Readable.fromWeb(response.body as never), async function* (source) { for await (const c of source) { bytes += c.length; if (bytes > 1024 ** 3) throw new AppError("Separerat ljud är för stort.", 413); yield c; } }, createWriteStream(`${background}.tmp`), { signal });
        await ffmpeg([...inputArgs(`${background}.tmp`, "wav"), "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", background], signal);
        await rm(`${background}.tmp`, { force: true }); await rm(separationSource, { force: true });
      }
    }
    const caps = await capabilities(); const speakers = [...new Set(job.segments.map((s) => s.speaker))].sort();
    const speechFiles: Record<string, string[]> = {}; let review = 0; let maxDeviation = 0;
    if (job.options.mode !== "subtitles") {
      for (const target of job.options.targets) {
        speechFiles[target] = [];
        for (let i = 0; i < job.segments.length; i++) {
          const segment = job.segments[i]; const translated = job.translations[target][i];
          await step("generating", `Genererar AI-röst (${target}), segment ${i + 1} av ${job.segments.length}.`);
          const availableVoices = caps.voices.filter((v) => !caps.voiceLanguages[v] || caps.voiceLanguages[v].includes(target));
          if (!availableVoices.length) throw new AppError(`Ingen installerad röst stöder ${target}.`, 422);
          const requested = job.options.speakerVoices[segment.speaker] || job.options.voice;
          const firstVoice = Math.max(0, availableVoices.indexOf(requested));
          const voice = job.options.speakerVoices[segment.speaker] && availableVoices.includes(requested) ? requested : availableVoices[(firstVoice + (segment.speaker === "unknown" ? 0 : speakers.indexOf(segment.speaker))) % availableVoices.length];
          let reference: string | undefined;
          if (job.options.preserveVoice) {
            const sample = job.segments.filter((s) => s.speaker === segment.speaker && !s.uncertain).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
            if (!sample || sample.end - sample.start < 3) throw new AppError(`Talare ${segment.speaker} saknar ett rent röstprov på minst tre sekunder.`, 422);
            reference = path.join(dir, `reference-${hash(segment.speaker)}.wav`);
            if (!(await exists(reference))) await chunk(normalized, reference, sample.start, Math.min(12, sample.end - sample.start), signal);
          }
          async function generate(t: Translation) {
            const file = path.join(dir, `speech-${hash(JSON.stringify([target, t.text, voice, caps.tts, !!reference, process.env.MMS_SEED || "555", "trim-edges-sv-pronunciation-v5"]))}.wav`);
            if (!(await exists(file))) { const bytes = await synthesize(t.text, target, voice, signal, reference); await writeFile(file, bytes); }
            try {
              const trimmed = `${file}.trim.wav`;
              if (!(await exists(trimmed))) await trimSpeech(file, signal);
              return { file: trimmed, duration: await speechDuration(trimmed, signal) };
            }
            catch (error) { if (!signal.aborted) { await rm(file, { force: true }); await rm(`${file}.trim.wav`, { force: true }); } throw error; }
          }
          const window = speechWindow(job.segments, i, duration); const fullText = translated.text;
          let generated = await generate(translated); let timing = timingPlan(generated.duration, window); let attempts = 0;
          const tried = new Set([translated.text]);
          for (; timing.review && attempts < 3; attempts++) {
            const count = translated.text.split(/\s+/).filter(Boolean).length;
            const maxWords = Math.max(1, Math.floor(count * window * 1.16 / generated.duration) - attempts);
            const context = `Visual context (vocabulary only):\n${job.sourceContext?.context || ""}\nSurrounding source (context only):\n${job.segments.slice(Math.max(0, i - 2), i + 3).map((s) => s.text).join("\n")}\nFull target translation to shorten without changing its meaning:\n${fullText}\nCurrent wording (${generated.duration.toFixed(2)} seconds of measured speech):\n${translated.text}`;
            let concise: Awaited<ReturnType<typeof translate>>;
            try { concise = await translate([segment], target, job.options, context, signal, true, { maxWords, measuredSeconds: generated.duration, availableSeconds: window }); }
            catch (error) { if (error instanceof TranslationIntegrityError) continue; throw error; }
            if (tried.has(concise[0].text)) continue;
            tried.add(concise[0].text);
            if (target === "sv" && !shorteningPreservesAnchors(fullText, concise[0].text).ok) continue;
            const candidate = await generate(concise[0]);
            if (candidate.duration < generated.duration) { translated.text = concise[0].text; generated = candidate; timing = timingPlan(generated.duration, window); }
          }
          // A slow TTS voice may tolerate more compression at a normal spoken
          // word rate. Prefer faithful concise speech at <=1.2; only then allow
          // <=1.4, and never pack more than 180 words/minute into the window.
          if (timing.review && translated.text.split(/\s+/).filter(Boolean).length / window * 60 <= 180) timing = timingPlan(generated.duration, window, 1.4);
          timing.attempts = attempts; timing.borrowedSeconds = Math.max(0, window - (segment.end - segment.start));
          translated.timing = timing; speechFiles[target].push(generated.file);
          if (timing.review) review++;
          maxDeviation = Math.max(maxDeviation, timing.deviationMs);
          job = await updateJob(id, (j) => { j.translations[target] = job.translations[target]; });
        }
      }
    }
    job = await updateJob(id, (j) => { j.metrics.reviewSegments = review; j.metrics.syncMaxDeviationMs = maxDeviation; });
    await persistExports(job);
    if (review) {
      await updateJob(id, (j) => { j.status = "review"; j.message = `${review} segment ryms inte med naturligt tempo. Förkorta texten eller justera tidsfönstret och återuppta.`; j.outputs = Object.fromEntries(j.options.targets.map((t) => [t, ["srt", "vtt", "txt", "json"]])); });
      return;
    }
    for (const target of job.options.targets) {
      if (job.options.mode !== "subtitles") {
        await step("synchronizing", `Placerar talet på absoluta tidspositioner (${target}).`);
        const timeline = path.join(dir, `${target}.pcm`); await createTimeline(timeline, duration);
        for (let i = 0; i < job.segments.length; i++) { signal.throwIfAborted(); await placeSpeech(timeline, speechFiles[target][i], job.segments[i].start, job.translations[target][i].timing!.tempo, dir, signal); }
        await step("exporting", `Exporterar WAV, MP3 och M4A (${target}).`);
        await renderTrack(dir, target, duration, original, job.options.mode, background, signal);
        await speechDuration(path.join(dir, `${target}.wav`), signal);
        const actual = (await inspect(path.join(dir, `${target}.wav`), signal)).duration;
        if (Math.abs(actual - duration) > 0.08) throw new AppError("Exportens längd avviker från originalet. Ingen godkänd ljudexport publicerades.", 502);
        await rm(timeline, { force: true });
      }
      if (job.media!.video) {
        await step("exporting", `Exporterar MP4 med ${job.options.mode === "subtitles" ? "originalljud" : "översatt tal"} (${target}).`);
        await renderVideo(original, job.options.mode === "subtitles" ? undefined : path.join(dir, `${target}.wav`), path.join(dir, `${target}.mp4`), duration, signal);
      }
    }
    signal.throwIfAborted();
    await updateJob(id, (j) => {
      if (j.command) throw new AppError("Jobbkontroll inväntas.", 409);
      j.status = "completed"; j.stage = "completed"; j.message = "Klart. Granska översättning och AI-röst innan vidare användning.";
      j.outputs = Object.fromEntries(j.options.targets.map((t) => [t, ["srt", "vtt", "txt", "json", ...(j.options.mode !== "subtitles" ? ["wav", "mp3", "m4a"] : []), ...(j.media!.video ? ["mp4"] : [])]]));
      if (j.options.mode === "replace") j.warnings = [...new Set([...j.warnings, background ? "Bakgrundsseparering kan ge artefakter och kvarvarande originaltal. Lyssna igenom resultatet." : "Hela originalljudspåret ersätts. Bakgrundsmusik och ljudeffekter bevaras inte utan separering."])];
    });
  } catch (error) {
    if (!claimed) throw error;
    await updateJob(id, (j) => {
      if (j.command === "cancel") { j.status = "cancelled"; j.message = "Jobbet avbröts."; }
      else if (j.command === "pause" || externalSignal?.aborted) { j.status = "paused"; j.message = "Pausat. Slutförda steg har sparats."; }
      else { j.status = "failed"; j.error = error instanceof AppError ? error.message : "Bearbetningen misslyckades. Kontrollera worker-loggen och modellinstallationen."; j.message = j.error; console.error(`[translation ${id}] ${error instanceof AppError ? error.message : "Oväntat pipelinefel"}`); }
      j.command = undefined;
    });
  } finally {
    clearInterval(monitor);
    if (claimed) {
      const final = await updateJob(id, (j) => { j.metrics.processingMs += Date.now() - started; if (activeStage) j.metrics.stages[activeStage] = (j.metrics.stages[activeStage] || 0) + Date.now() - stageStart; j.command = undefined; });
      if (["completed", "review"].includes(final.status)) await persistExports(final);
    }
  }
}
