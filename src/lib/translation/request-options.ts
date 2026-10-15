import type { StudioOptions } from "./types";

/** Voice samples do not translate source text or mix/render source media. */
export function voiceSampleOptions(options: StudioOptions): StudioOptions {
  return {
    source: "auto", targets: [options.targets[0]], rights: options.rights,
    cloudConsent: options.cloudConsent, style: options.style, translationMode: options.translationMode,
    voice: options.voice, englishLocale: options.englishLocale, speechRate: options.speechRate,
    mode: "replace", speakerVoices: {}, diarize: false, preserveVoice: false, voiceConsent: false, preserveBackground: false,
  };
}
export function boundedLiveContext(value: string) {
  const context = value.slice(-2000);
  // Do not start with half an emoji when clipping UTF-16 text.
  const first = context.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? context.slice(1) : context;
}
export function liveRequestBody(options: StudioOptions, context: string, audio: Blob) {
  const body = new FormData();
  body.set("options", JSON.stringify(options)); body.set("context", boundedLiveContext(context)); body.set("audio", audio, "block.wav");
  return body;
}
