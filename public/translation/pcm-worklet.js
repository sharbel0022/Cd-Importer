// Resample microphone input to independently decodable 16 kHz PCM blocks.
class TranslationPCM extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; this.position = 0; this.sum = 0; this.count = 0; this.port.onmessage = (e) => { if (e.data === "flush") this.emit(); }; }
  emit() { if (!this.samples.length) return; const pcm = Int16Array.from(this.samples); this.samples = []; this.port.postMessage(pcm.buffer, [pcm.buffer]); }
  process(inputs, outputs) {
    const channels = inputs[0]; if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i] / channels.length;
      this.sum += sample; this.count++; this.position += 16000;
      if (this.position >= sampleRate) { this.position -= sampleRate; this.samples.push(Math.round(Math.max(-1, Math.min(1, this.sum / this.count)) * 32767)); this.sum = 0; this.count = 0; }
      if (this.samples.length >= 64000) this.emit();
    }
    for (const channel of outputs[0] || []) channel.fill(0);
    return true;
  }
}
registerProcessor("translation-pcm", TranslationPCM);
