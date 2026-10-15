import { z } from "zod";

// Explicit TTS language allowlist. Local providers further narrow this list.
export const LANGUAGES = {
  sv: "Svenska", en: "Engelska", ar: "Arabiska", de: "Tyska", fr: "Franska", es: "Spanska", it: "Italienska", pt: "Portugisiska", nl: "Nederländska", da: "Danska", no: "Norska", fi: "Finska", pl: "Polska", uk: "Ukrainska", ru: "Ryska", tr: "Turkiska", fa: "Persiska", he: "Hebreiska", hi: "Hindi", ur: "Urdu", zh: "Kinesiska", ja: "Japanska", ko: "Koreanska", el: "Grekiska", cs: "Tjeckiska", ro: "Rumänska", hu: "Ungerska", id: "Indonesiska", vi: "Vietnamesiska", th: "Thailändska", sw: "Swahili", af: "Afrikaans", hy: "Armeniska", az: "Azerbajdzjanska", be: "Belarusiska", bs: "Bosniska", bg: "Bulgariska", ca: "Katalanska", hr: "Kroatiska", et: "Estniska", gl: "Galiciska", is: "Isländska", kn: "Kannada", kk: "Kazakiska", lv: "Lettiska", lt: "Litauiska", mk: "Makedonska", ms: "Malajiska", mr: "Marathi", mi: "Maori", ne: "Nepalesiska", sr: "Serbiska", sk: "Slovakiska", sl: "Slovenska", tl: "Tagalog", ta: "Tamil", cy: "Walesiska",
} as const;
export type Language = keyof typeof LANGUAGES;
export const VOICES = ["coral", "alloy", "ash", "ballad", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];
export const EXTENSIONS: Record<string, string> = { mp3: "mp3", wav: "wav", m4a: "mov", aac: "aac", flac: "flac", ogg: "ogg", mp4: "mov", mov: "mov", mkv: "matroska", webm: "matroska" };
const language = z.string().refine((v) => v in LANGUAGES, "Språket stöds inte.");
export const glossaryEntrySchema = z.object({
  source: z.string().trim().min(1).max(160),
  translation: z.string().trim().max(240).default(""),
  target: z.union([z.literal("*"), language]).default("*"),
  protect: z.boolean().default(false),
  abbreviation: z.string().trim().max(240).optional(),
}).strict().refine((v) => v.protect || !!v.translation, "Ange översättning eller skydda uttrycket.");
export const glossarySchema = z.array(glossaryEntrySchema).max(100);
export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;
export const optionsSchema = z.object({
  source: z.union([z.literal("auto"), language]).default("auto"),
  targets: z.array(language).min(1).max(3).refine((v) => new Set(v).size === v.length),
  style: z.enum(["natural", "literal", "professional", "casual"]).default("natural"),
  translationMode: z.enum(["faithful", "natural", "professional", "literal"]).default("faithful"),
  domain: z.enum(["general", "sports", "medical", "technology", "business", "education"]).optional(),
  glossary: glossarySchema.optional(),
  mix: z.object({ speechGainDb: z.number().min(-18).max(12).default(0), backgroundGainDb: z.number().min(-36).max(12).default(0), originalGainDb: z.number().min(-60).max(0).default(-16.5), fadeInSeconds: z.number().min(0).max(5).default(0), fadeOutSeconds: z.number().min(0).max(5).default(0), loudnessLufs: z.number().min(-24).max(-12).default(-16), normalize: z.boolean().default(true) }).strict().optional(),
  subtitles: z.object({ bilingual: z.boolean().default(false), speakerLabels: z.boolean().default(false), burnIn: z.boolean().default(false), font: z.enum(["Arial", "Tahoma", "Noto Sans", "DejaVu Sans"]).default("Arial"), fontSize: z.number().int().min(12).max(48).default(24), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFFFFF"), outline: z.number().min(0).max(4).default(2), position: z.enum(["top", "bottom"]).default("bottom") }).strict().optional(),
  mode: z.enum(["replace", "voiceover", "subtitles"]).default("replace"),
  voice: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).default("auto"),
  englishLocale: z.enum(["en-US", "en-GB"]).default("en-US"),
  speechRate: z.number().min(0.85).max(1.2).default(1),
  speakerVoices: z.record(z.string().max(80), z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).default({}),
  diarize: z.boolean().default(false), preserveBackground: z.boolean().default(false),
  preserveVoice: z.boolean().default(false), voiceConsent: z.boolean().default(false),
  rights: z.literal(true, { error: "Bekräfta din rätt att bearbeta filen." }),
  cloudConsent: z.boolean().default(false),
}).strict();
export type StudioOptions = z.infer<typeof optionsSchema>;
export interface Word { start: number; end: number; word: string; rawWord?: string; probability?: number; uncertain?: boolean }
export interface Segment { id: string; start: number; end: number; text: string; speaker: string; uncertain?: boolean; words?: Word[]; rawText?: string; qualityReasons?: string[]; confidence?: number; reviewedAt?: string; codeSwitch?: boolean; asrAlternatives?: { model: string; text: string; disagreement: number; requestId?: string; createdAt?: string; start?: number; end?: number; denoised?: boolean; settings?: Record<string, string | number | boolean | number[]>; words?: Word[] }[] }
export interface Timing { generated: number; window: number; tempo: number; deviationMs: number; review: boolean; attempts?: number; borrowedSeconds?: number }
export interface Translation { id: string; text: string; timing?: Timing; generation?: number; reviewRequired?: boolean; reviewMessage?: string; editedByUser?: boolean }
export interface SourceEdit { id: string; at: string; before: { text: string; start: number; end: number }; after: { text: string; start: number; end: number } }
export type Stage = "uploading" | "transcribing" | "translating" | "generating" | "synchronizing" | "exporting" | "completed";
export type JobStatus = "queued" | "running" | "paused" | "cancelled" | "failed" | "review" | "completed";
export interface MediaInfo { duration: number; sampleRate: number; channels: number; video: boolean; waveform: number[] }
export interface Job {
  id: string; name: string; originalName?: string; extension: string; createdAt: string; updatedAt: string;
  revision: number; options: StudioOptions; status: JobStatus; stage: Stage;
  command?: "pause" | "cancel"; message: string; error?: string;
  reviewReason?: "source" | "translation" | "timing"; sourceReviewed?: boolean;
  media?: MediaInfo; detectedLanguage?: string; sourceConfidence?: number; segments: Segment[];
  rawSegments?: Segment[]; sourceEdits?: SourceEdit[];
  segmentOutputs?: Record<string, Record<string, { file: string; text: string }>>;
  sourceContext?: { context: string; arabicKeywords: string };
  translations: Record<string, Translation[]>; outputs: Record<string, string[]>;
  outputManifest?: Record<string, Record<string, { sha256: string; bytes: number; revision: number; createdAt: string }>>;
  warnings: string[]; metrics: { processingMs: number; stages: Record<string, number>; syncMaxDeviationMs?: number; reviewSegments?: number };
}
export function pendingSourceSegments(job: Job) { return job.segments.filter((s) => s.uncertain && !s.reviewedAt && !job.sourceReviewed); }
export interface Capabilities {
  ready: boolean; cloud: boolean; asr: string; translation: string; tts: string;
  subtitleReady?: boolean; subtitleCloud?: boolean;
  languages: string[]; voices: string[]; diarization: boolean; cloning: boolean; separation: boolean;
  voiceLanguages: Record<string, string[]>; cloningLanguages: string[];
  voiceLocales?: Record<string, string>; voiceGenders?: Record<string, string>;
  asrModels?: { id: string; label: string; selected: boolean }[];
  translationModels?: Record<string, string>;
  commercial?: boolean; licenseMessage?: string;
  captionBurnIn?: boolean;
  message: string; maxUploadMb: number; maxDuration: number; worker: boolean;
}
export function timingPlan(generated: number, window: number, maxTempo = 1.2, preferredTempo = 1): Timing {
  if (!(generated > 0 && window > 0 && Number.isFinite(generated + window))) throw new Error("Ogiltig segmentlängd.");
  // Keep short phrases at the user's natural pace; accelerate only to fit.
  const tempo = Math.max(0.85, Math.min(maxTempo, Math.max(preferredTempo, generated / window)));
  const deviationMs = Math.max(0, generated / tempo - window) * 1000;
  return { generated, window, tempo, deviationMs: Math.round(deviationMs), review: deviationMs > 1 };
}
function stamp(seconds: number, vtt: boolean) {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${vtt ? "." : ","}${String(ms % 1000).padStart(3, "0")}`;
}
export function subtitles(segments: Segment[], translations: Translation[], format: "srt" | "vtt") {
  const text = new Map(translations.map((v) => [v.id, v.text]));
  return (format === "vtt" ? "WEBVTT\n\n" : "") + segments.map((s, i) => `${i + 1}\n${stamp(s.start, format === "vtt")} --> ${stamp(s.end, format === "vtt")}\n${(text.get(s.id) ?? s.text).replace(/[<>\r]/g, "").replace(/-->/g, "→").replace(/\n\s*\n/g, "\n")}\n`).join("\n");
}
