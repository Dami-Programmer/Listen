// Strong noise reduction ("Strong noise reduction" in the mic menu).
//
// Browsers already clean the mic a little by themselves (steady noise: fans,
// hum). This goes much further: RNNoise — a small free neural network made for
// voices — takes out typing, traffic, a crying baby, people chatting nearby.
// It runs on this device, on the mic BEFORE it's sent, so everyone (and the
// recording) hears the clean version.
//
// How: mic track -> Web Audio -> RNNoise (an AudioWorklet) -> a new track,
// which is what gets sent. Only loaded the first time someone turns it on
// (this whole file is imported on demand), so nobody else downloads it.
//
// The choice is remembered on this device (wantsStrongNoise / saveStrongNoise
// live in webrtc.js so this file stays out of the main download).

import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import simdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

// The RNNoise program itself, fetched once and reused.
let wasm = null;

/**
 * A cleaned copy of a mic track. Returns { track, stop } — `track` is what to
 * send; `stop()` releases the cleaning (not the mic itself).
 */
export async function cleanMic(micTrack) {
  wasm ??= loadRnnoise({ url: wasmUrl, simdUrl: simdWasmUrl });
  const binary = await wasm;

  // RNNoise works on 48 kHz audio.
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.audioWorklet.addModule(workletUrl);
  await ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(new MediaStream([micTrack]));
  const denoise = new RnnoiseWorkletNode(ctx, { wasmBinary: binary, maxChannels: 1 });
  const out = ctx.createMediaStreamDestination();
  source.connect(denoise);
  denoise.connect(out);

  const track = out.stream.getAudioTracks()[0];
  return {
    track,
    stop() {
      track.stop();
      source.disconnect();
      denoise.destroy?.();
      denoise.disconnect();
      ctx.close().catch(() => {});
    },
  };
}
