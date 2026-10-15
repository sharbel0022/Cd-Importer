import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { performance } from "node:perf_hooks";
import { AppError } from "../errors";
import { atomicJson, durationLimit, enforceQuota, jobDir, readJob, updateJob } from "./store";
import { capabilities, diarize, resolveVoice, separate, synthesize, transcribe, transcriptionSchema, translate, TranslationIntegrityError, validateOptions, type Turn } from "./providers";
import { cachedSpeech, chunk, createTimeline, ffmpeg, inputArgs, inspect, normalize, placeSpeech, renderCaptionedVideo, renderTrack, renderVideo, silenceBoundaries, speechDuration, SpeechWindowError, verifyExport, waveform } from "./media";
import { describeArtifacts, digestFile, retainTextArtifacts, TEXT_FORMATS, writeTextArtifacts, type ExportProvenance } from "./artifacts";
import { pendingSourceSegments, timingPlan, type Job, type JobStatus, type Segment, type Stage, type Translation } from "./types";

async function exists(file: string) { try { return (await stat(file)).size > 0; } catch { return false; } }
function hash(text: string) { return createHash("sha256").update(text).digest("hex").slice(0, 32); }
function hasDiscontinuousWordTimestamps(segment: Segment) {
  return segment.words?.some((word, n, words) => n > 0 && word.start - words[n - 1].end > 2) ?? false;
}
// Whisper can split a single spoken thought into sub-second fragments. Group
// adjacent fragments before translation so context and the time budget agree.
export function phraseSegments(segments: Segment[]): Segment[] {
  const result: Segment[] = [];
  for (const segment of segments) {
    const last = result.at(-1);
    if (last && last.speaker === segment.speaker && last.end - last.start < 2.5 && segment.start - last.end >= -0.04 && segment.start - last.end <= 0.4 && segment.end - last.start <= 7.5 && !/[.!?؟。]$/.test(last.text.trim())) {
      last.text += ` ${segment.text}`; last.end = segment.end; last.uncertain ||= segment.uncertain; last.codeSwitch ||= segment.codeSwitch;
      if (last.qualityReasons || segment.qualityReasons) last.qualityReasons = [...new Set([...(last.qualityReasons || []), ...(segment.qualityReasons || [])])];
      if (segment.confidence !== undefined) last.confidence = Math.min(last.confidence ?? 1, segment.confidence);
      if (last.rawText || segment.rawText) last.rawText = `${last.rawText || last.text.slice(0, -(segment.text.length + 1))} ${segment.rawText || segment.text}`;
      if (last.words && segment.words) last.words.push(...segment.words); else last.words = undefined;
    } else result.push({ ...segment, words: segment.words ? [...segment.words] : undefined });
  }
  return result.map((s, i) => ({ ...s, id: `s${i + 1}` }));
}
export function speechWindow(segments: Segment[], index: number, duration: number) {
  const segment = segments[index];
  const boundary = Math.min(duration, segments[index + 1]?.start ?? duration);
  // Use the available pause before the next segment (including trailing
  // silence) before changing tempo. Never cross the next speech onset/file end.
  return Math.max(0, boundary - segment.start);
}
export function safeChunkPlan(duration: number, maximum: number, silences: number[]) {
  if (!(duration > 0 && maximum >= 10 && Number.isFinite(duration + maximum))) throw new AppError("Ogiltig ASR-chunklängd.", 422);
  const result: { start: number; duration: number; hardBoundary: boolean }[] = [];
  for (let start = 0; start < duration;) {
    let end = Math.min(duration, start + maximum); let hardBoundary = end < duration;
    if (hardBoundary) {
      const choices = silences.filter((s) => Number.isFinite(s) && s >= start + Math.max(10, maximum - 10) && s <= end);
      if (choices.length) { end = Math.max(...choices); hardBoundary = false; }
    }
    result.push({ start, duration: end - start, hardBoundary }); start = end;
  }
  return result;
}
export function assignSpeakers(segments: Segment[], turns: Turn[]): Segment[] {
  function matches(start: number, end: number) { return turns.map((t) => ({ ...t, overlap: Math.max(0, Math.min(end, t.end) - Math.max(start, t.start)) })).filter((t) => t.overlap > 0).sort((a, b) => b.overlap - a.overlap); }
  const result: Segment[] = [];
  for (const segment of segments) {
    if (segment.words?.length) {
      let group: Segment | undefined;
      for (const word of segment.words) {
        const candidates = matches(word.start, word.end); const speaker = candidates[0]?.speaker || "unknown";
        if (!group || group.speaker !== speaker) { group = { id: "", start: word.start, end: word.end, text: word.word, speaker, uncertain: !!segment.uncertain || !candidates.length || candidates.length > 1, qualityReasons: segment.qualityReasons, confidence: segment.confidence, words: [word] }; result.push(group); }
        else { group.end = word.end; group.text += ` ${word.word}`; group.words!.push(word); group.uncertain ||= candidates.length > 1; }
      }
    } else {
      const candidates = matches(segment.start, segment.end);
      result.push({ ...segment, speaker: candidates[0]?.speaker || "unknown", uncertain: !!segment.uncertain || candidates.length !== 1 });
    }
  }
  return result.map((s, n) => ({ ...s, id: `s${n + 1}` }));
}
async function persistExports(job: Job, provenance: ExportProvenance) {
  const manifest = await writeTextArtifacts(job, provenance);
  return updateJob(job.id, (j) => {
    if (j.revision !== job.revision) throw new AppError("Exportens version har ändrats. Återuppta jobbet.", 409);
    for (const target of j.options.targets) {
      const media = (j.outputs[target] || []).filter((format) => !(TEXT_FORMATS as readonly string[]).includes(format));
      if (manifest[target]) {
        j.outputs[target] = [...TEXT_FORMATS, ...media];
        (j.outputManifest ??= {})[target] = { ...j.outputManifest?.[target], ...manifest[target] };
      }
    }
  });
}
export async function runJob(id: string, externalSignal?: AbortSignal) {
  const controller = new AbortController(); const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  const monitor = setInterval(() => { void readJob(id).then((job) => { if (job.command) controller.abort(new Error(job.command)); }).catch(() => controller.abort()); }, 400);
  const started = performance.now(); let stageStart = started; let activeStage: Stage | undefined;
  let claimed = false; let provenance: ExportProvenance | undefined; let outcome: JobStatus | undefined;
  let preparedMedia: NonNullable<Job["outputManifest"]> = {};
  async function step(stage: Stage, message: string) {
    signal.throwIfAborted(); const now = performance.now();
    await updateJob(id, (j) => { if (activeStage) j.metrics.stages[activeStage] = Math.max(0, j.metrics.stages[activeStage] || 0) + Math.max(0, Math.round(now - stageStart)); j.stage = stage; j.message = message; });
    activeStage = stage; stageStart = now;
  }
  try {
    let job = await updateJob(id, (j) => { if (j.status === "queued" && !j.command) { const retained = retainTextArtifacts(j); j.status = "running"; j.error = undefined; j.outputs = retained.outputs; j.outputManifest = retained.outputManifest; j.reviewReason = undefined; claimed = true; } });
    if (!claimed) return;
    await validateOptions(job.options);
    const dir = jobDir(id); const original = path.join(dir, `original.${job.extension}`); const normalized = path.join(dir, "normalized.wav");
    await step("transcribing", "Validerar media och extraherar ljudspåret.");
    if (!job.media) {
      const media = await inspect(original, signal, job.extension);
      if (media.duration > durationLimit()) throw new AppError(`Filen är längre än gränsen ${durationLimit()} sekunder.`, 413);
      await enforceQuota(media.duration * (32000 + job.options.targets.length * 288000 + (job.options.preserveBackground ? 384000 : 0)) + (media.video ? (await stat(original)).size * (job.options.targets.length + 1) : 0));
      await normalize(original, normalized, signal, durationLimit(), job.extension);
      const wave = await waveform(normalized, dir, signal, media.duration);
      job = await updateJob(id, (j) => { j.media = { ...media, waveform: wave }; });
    }
    if (!(await exists(normalized))) await normalize(original, normalized, signal, durationLimit(), job.extension);
    const [sourceDigest, normalizedDigest] = await Promise.all([digestFile(original, signal), digestFile(normalized, signal)]);
    const caps = await capabilities();
    provenance = { sourceSha256: sourceDigest.sha256, normalizedSha256: normalizedDigest.sha256, providers: { asr: caps.asr, translation: caps.translation, tts: caps.tts } };
    const duration = job.media!.duration;
    if (job.media!.video && !(await exists(path.join(dir, "source-preview.mp4")))) {
      await step("transcribing", "Förbereder originalvideon för uppspelning i webbläsaren.");
      await renderVideo(original, undefined, path.join(dir, "source-preview.mp4"), duration, signal);
    }
    const asrDuration = Math.min(duration, (await inspect(normalized, signal)).duration);
    if (!job.segments.length) {
      const all: Segment[] = []; const languages: string[] = []; const languageScores = new Map<string, number>(); const languageConfidences: number[] = [];
      const partSeconds = Math.max(10, Math.min(120, Number(process.env.STUDIO_ASR_CHUNK_SECONDS) || 60));
      const chunks = safeChunkPlan(asrDuration, partSeconds, asrDuration > partSeconds ? await silenceBoundaries(normalized, signal) : []);
      for (const [chunkIndex, current] of chunks.entries()) {
        const { start, duration: partDuration, hardBoundary } = current;
        signal.throwIfAborted(); await step("transcribing", `Transkriberar ${Math.floor(start)}–${Math.ceil(start + partDuration)} s av ${Math.ceil(duration)} s.`);
        const asrVersion = hash(JSON.stringify([normalizedDigest.sha256, process.env.STUDIO_ASR_PROVIDER || "openai", process.env.WHISPER_MODEL, job.options.source, "acoustic-only-raw-codeswitch-v7"]));
        const cache = path.join(dir, `asr-${start}-${partDuration}-${asrVersion}.json`); let data: Awaited<ReturnType<typeof transcribe>>;
        let cached: Awaited<ReturnType<typeof transcribe>> | undefined;
        if (await exists(cache)) {
          try { const parsed = transcriptionSchema.safeParse(JSON.parse(await readFile(cache, "utf8"))); if (parsed.success) cached = parsed.data; }
          catch { /* Interrupted or obsolete checkpoints are recomputed. */ }
          if (!cached) await rm(cache, { force: true });
        }
        if (cached) data = cached;
        else { const part = path.join(dir, "asr-current.wav"); await chunk(normalized, part, start, partDuration, signal); data = await transcribe(part, job.options.source, signal); await atomicJson(cache, data); await rm(part, { force: true }); }
        // A high no-speech score can also be faint real speech. Keep its words
        // for human review instead of silently deleting them from the dub.
        const speechSegments = data.segments.filter((s) => s.text.trim());
        if (data.language && speechSegments.length) { languages.push(data.language); languageScores.set(data.language, (languageScores.get(data.language) || 0) + speechSegments.reduce((sum, s) => sum + s.end - s.start, 0)); }
        if (data.language_probability !== undefined && speechSegments.length) languageConfidences.push(data.language_probability);
        for (const s of speechSegments) {
          if (s.end <= s.start || s.start >= partDuration || s.end > partDuration + 1) throw new AppError("ASR gav tidsstämplar utanför ljudet.", 502);
          const words = (s.words || data.words?.filter((w) => w.start >= s.start && w.end <= s.end))?.filter((w) => w.end > w.start && w.start >= 0 && w.end <= s.end + 0.1).map(({ raw_word, ...w }) => ({ ...w, ...(raw_word ? { rawWord: raw_word } : {}), start: w.start + start, end: Math.min(duration, w.end + start) }));
          const boundarySpeech = hardBoundary && s.end > partDuration - 0.15 || chunks[chunkIndex - 1]?.hardBoundary && s.start < 0.15;
          all.push({ id: `s${all.length + 1}`, start: s.start + start, end: Math.min(duration, start + partDuration, s.end + start), text: s.text.trim(), rawText: s.raw_text ?? s.text, codeSwitch: s.code_switch || (/\p{Script=Arabic}/u.test(s.text) && /[a-zA-Z]/u.test(s.text)), speaker: "unknown", uncertain: s.uncertain || boundarySpeech || (s.avg_logprob !== undefined && s.avg_logprob < -0.8) || (s.no_speech_prob !== undefined && s.no_speech_prob > 0.55) || words?.some((w) => w.uncertain || (w.probability !== undefined && w.probability < 0.5)) || (data.language_probability !== undefined && data.language_probability < 0.6), qualityReasons: [...(s.quality_reasons || []), ...(boundarySpeech ? ["speech_at_chunk_boundary"] : []), ...(s.no_speech_prob !== undefined && s.no_speech_prob > 0.55 ? ["possible_background_noise_or_silence"] : [])], confidence: s.confidence ?? (s.avg_logprob !== undefined ? Math.min(1, Math.exp(s.avg_logprob)) : undefined), words });
          const acousticSegment = all.at(-1)!;
          if (hasDiscontinuousWordTimestamps(acousticSegment)) {
            acousticSegment.uncertain = true;
            acousticSegment.qualityReasons = [...new Set([...(acousticSegment.qualityReasons || []), "discontinuous_word_timestamps"])];
          }
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
        j.rawSegments = structuredClone(all);
        j.segments = phraseSegments(segments); j.detectedLanguage = job.options.source === "auto" ? [...languageScores].sort((a, b) => b[1] - a[1])[0]?.[0] || "okänt" : job.options.source;
        for (const s of j.segments) s.rawText ??= s.text;
        if (j.segments.some((s) => s.uncertain)) j.sourceReviewed = false;
        if (languageConfidences.length) j.sourceConfidence = Math.min(...languageConfidences);
        if (new Set(languages).size > 1) j.warnings.push("Flera källspråk identifierades i olika delar av filen.");
        if (!job.options.diarize) j.warnings.push("Talaridentifiering är avstängd. Okända talare använder samma standardröst.");
        if (segments.some((s) => s.uncertain)) j.warnings.push("Osäkra eller överlappande segment finns. Granska transkript och talaridentiteter.");
      });
    }
    const discontinuous = job.segments.filter((s) => hasDiscontinuousWordTimestamps(s) && !s.qualityReasons?.includes("discontinuous_word_timestamps"));
    if (discontinuous.length) {
      const ids = new Set(discontinuous.map((s) => s.id));
      job = await updateJob(id, (j) => {
        for (const segment of j.segments) if (ids.has(segment.id)) {
          // High decoder probability is not confidence in VAD-restored timing.
          // Preserve the acoustic timestamps; a person must review alignment.
          segment.uncertain = true;
          segment.reviewedAt = undefined;
          segment.qualityReasons = [...new Set([...(segment.qualityReasons || []), "discontinuous_word_timestamps"])];
        }
        j.sourceReviewed = false;
        j.warnings = [...new Set([...j.warnings, "Ordtidsstämplar innehåller ovanligt långa luckor inom en replik. Granska segmentets verkliga start och slut före dubbning."])];
      });
    }
    const pendingSource = new Set(pendingSourceSegments(job).map((s) => s.id));
    const translationIssues: string[] = [];
    for (const target of job.options.targets) {
      const done = new Map((job.translations[target] || []).map((t) => [t.id, t]));
      for (let i = 0; i < job.segments.length; i++) {
        const pending = job.segments.slice(i, i + 1).filter((s) => !pendingSource.has(s.id) && (!done.has(s.id) || done.get(s.id)?.reviewRequired));
        if (!pending.length) continue;
        await step("translating", `Översätter till ${target}: segment ${i + 1} av ${job.segments.length}.`);
        const context = job.segments.slice(Math.max(0, i - 4), i).filter((s) => !pendingSource.has(s.id)).map((s) => s.text).join("\n");
        try {
          const translated = await translate(pending, target, { ...job.options, source: job.detectedLanguage || job.options.source }, context, signal);
          for (const t of translated) done.set(t.id, t);
        } catch (error) {
          if (!(error instanceof TranslationIntegrityError)) throw error;
          translationIssues.push(pending[0].id);
          done.set(pending[0].id, { id: pending[0].id, text: error.drafts?.find((t) => t.id === pending[0].id)?.text || "", reviewRequired: true, reviewMessage: error.message });
        }
        job = await updateJob(id, (j) => { j.translations[target] = j.segments.flatMap((s) => done.has(s.id) ? [done.get(s.id)!] : []); });
      }
    }
    // Publish safe text before separation or synthesis, so either downstream
    // service can fail without hiding already reviewed translations/subtitles.
    job = await persistExports(job, provenance);
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
    const speakers = [...new Set(job.segments.map((s) => s.speaker))].sort();
    const speechFiles: Record<string, string[]> = {}; let review = 0; let maxDeviation = 0;
    if (job.options.mode !== "subtitles") {
      for (const target of job.options.targets) {
        speechFiles[target] = [];
        for (let i = 0; i < job.segments.length; i++) {
          const segment = job.segments[i]; const translated = job.translations[target]?.find((t) => t.id === segment.id);
          if (pendingSource.has(segment.id) || !translated || translated.reviewRequired) continue;
          await step("generating", `Genererar AI-röst (${target}), segment ${i + 1} av ${job.segments.length}.`);
          const voice = resolveVoice(target, job.options, caps, segment.speaker, speakers.indexOf(segment.speaker));
          let reference: string | undefined;
          if (job.options.preserveVoice) {
            const sample = job.segments.filter((s) => s.speaker === segment.speaker && !s.uncertain).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
            if (!sample || sample.end - sample.start < 3) throw new AppError(`Talare ${segment.speaker} saknar ett rent röstprov på minst tre sekunder.`, 422);
            reference = path.join(dir, `reference-${hash(JSON.stringify([normalizedDigest.sha256, segment.speaker, sample.start, Math.min(12, sample.end - sample.start)]))}.wav`);
            if (!(await exists(reference))) await chunk(normalized, reference, sample.start, Math.min(12, sample.end - sample.start), signal);
          }
          async function generate(t: Translation) {
            const file = path.join(dir, `speech-${hash(JSON.stringify([target, job.options.englishLocale || "en-US", t.text, t.generation || 0, voice, caps.tts, reference ? hash(await readFile(reference).then((v) => v.toString("base64"))) : "", process.env.MMS_SEED || "555", "trim-edges-locale-v6"]))}.wav`);
            return cachedSpeech(file, () => synthesize(t.text, target, voice, signal, reference, job.options), signal);
          }
          const window = speechWindow(job.segments, i, duration);
          if (window <= 0) throw new AppError(`Segment ${segment.id} saknar ett eget tidsfönster. Justera överlappande tidsstämplar.`, 422);
          const generated = await generate(translated); const timing = timingPlan(generated.duration, window, 1.2, job.options.speechRate || 1);
          timing.attempts = 0; timing.borrowedSeconds = Math.max(0, window - (segment.end - segment.start));
          translated.timing = timing; speechFiles[target][i] = generated.file;
          if (timing.review) review++;
          maxDeviation = Math.max(maxDeviation, timing.deviationMs);
          job = await updateJob(id, (j) => { j.translations[target] = job.translations[target]; ((j.segmentOutputs ??= {})[target] ??= {})[segment.id] = { file: path.basename(generated.file), text: translated.text }; });
        }
      }
    }
    job = await updateJob(id, (j) => { j.metrics.reviewSegments = review; j.metrics.syncMaxDeviationMs = maxDeviation; });
    job = await persistExports(job, provenance);
    if (pendingSource.size || translationIssues.length) {
      await updateJob(id, (j) => { j.reviewReason = pendingSource.size ? "source" : "translation"; j.outputs = {}; j.message = pendingSource.size ? `${pendingSource.size} källsegment behöver granskas. Tillförlitliga segment är bearbetade; lyssna och godkänn de markerade segmenten.` : `Översättningen av ${[...new Set(translationIssues)].join(", ")} behöver granskas. Rätta texten och spara före export.`; });
      outcome = "review";
      return;
    }
    if (review) {
      await updateJob(id, (j) => { j.reviewReason = "timing"; j.message = `${review} segment ryms inte med naturligt tempo. Justera tidsfönstret eller granska formuleringen utan att ta bort innehåll. Hela texten finns kvar.`; j.outputs = Object.fromEntries(j.options.targets.map((t) => [t, ["srt", "vtt", "txt", "json"]])); });
      outcome = "review";
      return;
    }
    const mediaManifest: NonNullable<Job["outputManifest"]> = {};
    for (const target of job.options.targets) {
      if (job.options.mode !== "subtitles") {
        await step("synchronizing", `Placerar talet på absoluta tidspositioner (${target}).`);
        const timeline = path.join(dir, `${target}.pcm`); await createTimeline(timeline, duration);
        for (let i = 0; i < job.segments.length; i++) {
          signal.throwIfAborted();
          const window = speechWindow(job.segments, i, duration); const translated = job.translations[target][i]; const timing = translated.timing!;
          const maxTempo = 1.2;
          let overflow: SpeechWindowError | undefined;
          for (let attempt = 0; attempt < 3; attempt++) {
            try { await placeSpeech(timeline, speechFiles[target][i], job.segments[i].start, timing.tempo, dir, signal, window); overflow = undefined; break; }
            catch (error) {
              if (!(error instanceof SpeechWindowError)) throw error;
              overflow = error;
              // atempo's sample output is not exactly duration / rate. Measure
              // its actual overflow and retry within the same natural bounds.
              const adjusted = timing.tempo * (1 + (error.overflowMs + 2) / (window * 1000));
              if (adjusted > maxTempo) break;
              timing.tempo = adjusted;
            }
          }
          if (overflow) {
            await updateJob(id, (j) => {
              timing.review = true; timing.deviationMs = overflow!.overflowMs; j.translations[target][i].timing = timing;
              j.metrics.reviewSegments = (j.metrics.reviewSegments || 0) + 1; j.metrics.syncMaxDeviationMs = Math.max(j.metrics.syncMaxDeviationMs || 0, overflow!.overflowMs);
              j.reviewReason = "timing"; j.message = `Segment ${j.segments[i].id} ryms inte efter uppmätt tempojustering. Ingen dubbning klipptes bort; justera text eller tid.`;
              j.outputs = Object.fromEntries(j.options.targets.map((t) => [t, ["srt", "vtt", "txt", "json"]]));
            });
            await rm(timeline, { force: true });
            outcome = "review";
            return;
          }
          job = await updateJob(id, (j) => { j.translations[target][i].timing = timing; });
        }
        await step("exporting", `Exporterar WAV, MP3 och M4A (${target}).`);
        await renderTrack(dir, target, duration, original, job.options.mode === "voiceover" ? "voiceover" : "replace", background, signal, job.options.mix);
        await speechDuration(path.join(dir, `${target}.wav`), signal);
        const actual = (await inspect(path.join(dir, `${target}.wav`), signal)).duration;
        if (Math.abs(actual - duration) > 0.08) throw new AppError("Exportens längd avviker från originalet. Ingen godkänd ljudexport publicerades.", 502);
        await rm(timeline, { force: true });
      }
      if (job.media!.video) {
        await step("exporting", `Exporterar MP4 med ${job.options.mode === "subtitles" ? "originalljud" : "översatt tal"} (${target}).`);
        await renderVideo(original, job.options.mode === "subtitles" ? undefined : path.join(dir, `${target}.wav`), path.join(dir, `${target}.mp4`), duration, signal, job.options.mode === "subtitles" ? { file: path.join(dir, `${target}.srt`), language: target } : undefined);
      }
      const formats = [...(job.options.mode !== "subtitles" ? ["wav", "mp3", "m4a"] : []), ...(job.media!.video ? ["mp4"] : [])];
      for (const format of formats) await verifyExport(path.join(dir, `${target}.${format}`), duration, signal, job.options.mode !== "subtitles");
      if (job.media!.video && job.options.subtitles?.burnIn) {
        await step("exporting", `Bränner in granskade undertexter i en separat MP4 (${target}).`);
        const captioned = await renderCaptionedVideo(dir, target, duration, signal, job.options.subtitles);
        await verifyExport(captioned, duration, signal, job.options.mode !== "subtitles");
        formats.push("mp4-captioned");
      }
      mediaManifest[target] = await describeArtifacts(job, target, formats);
    }
    signal.throwIfAborted();
    await updateJob(id, (j) => {
      if (j.command) throw new AppError("Jobbkontroll inväntas.", 409);
      j.message = j.options.mode === "subtitles" ? "Klart. Granska översättning och undertexter innan vidare användning." : "Klart. Granska översättning och AI-röst innan vidare användning.";
      j.reviewReason = undefined;
      if (j.options.mode === "replace") j.warnings = [...new Set([...j.warnings, background ? "Bakgrundsseparering kan ge artefakter och kvarvarande originaltal. Lyssna igenom resultatet." : "Hela originalljudspåret ersätts. Bakgrundsmusik och ljudeffekter bevaras inte utan separering."])];
    });
    preparedMedia = mediaManifest;
    outcome = "completed";
  } catch (error) {
    if (!claimed) throw error;
    await updateJob(id, (j) => {
      if (j.command === "cancel") { outcome = "cancelled"; j.message = "Jobbet avbröts."; }
      else if (j.command === "pause" || externalSignal?.aborted) { outcome = "paused"; j.message = "Pausat. Slutförda steg har sparats."; }
      else { outcome = "failed"; j.error = error instanceof AppError ? error.message : "Bearbetningen misslyckades. Kontrollera worker-loggen och modellinstallationen."; j.message = j.error; console.error(`[translation ${id}] ${error instanceof AppError ? error.message : "Oväntat pipelinefel"}`); }
    });
  } finally {
    clearInterval(monitor);
    if (claimed) {
      // Keep the job non-editable until metrics, text files and their manifest
      // agree. No terminal status is observable while files can still change.
      const final = await updateJob(id, (j) => { const now = performance.now(); j.metrics.processingMs = Math.max(0, j.metrics.processingMs) + Math.max(0, Math.round(now - started)); if (activeStage) j.metrics.stages[activeStage] = Math.max(0, j.metrics.stages[activeStage] || 0) + Math.max(0, Math.round(now - stageStart)); });
      if (provenance && (outcome === "completed" || outcome === "review")) await persistExports(final, provenance);
      await updateJob(id, (j) => {
        if (j.command === "cancel") { j.status = "cancelled"; j.message = "Jobbet avbröts."; }
        else if (j.command === "pause" || externalSignal?.aborted) { j.status = "paused"; j.message = "Pausat. Slutförda steg har sparats."; }
        else j.status = outcome || "failed";
        if (j.status === "completed") {
          j.stage = "completed";
          j.outputs = Object.fromEntries(j.options.targets.map((target) => [target, [...TEXT_FORMATS, ...Object.keys(preparedMedia[target] || {})]]));
          for (const target of j.options.targets) (j.outputManifest ??= {})[target] = { ...j.outputManifest?.[target], ...preparedMedia[target] };
        } else {
          const retained = retainTextArtifacts(j); j.outputs = retained.outputs; j.outputManifest = retained.outputManifest;
        }
        j.command = undefined;
      });
    }
  }
}
