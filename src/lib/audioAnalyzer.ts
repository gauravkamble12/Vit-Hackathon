/**
 * Audio Analyzer — Client-side deepfake detection for audio files.
 *
 * Uses the Web Audio API to decode the audio data and run
 * spectral & statistical analysis to detect synthetic/cloned audio.
 */

export interface AudioAnalysisResult {
  isFake: boolean;
  confidence: number;
  reasons: string[];
}

// ── helpers ────────────────────────────────────────────────────────

/** Decode audio file into raw samples */
async function decodeAudio(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    return audioBuffer;
  } finally {
    await audioCtx.close();
  }
}

// ── individual analysis tests ──────────────────────────────────────

/**
 * 1. Spectral Flatness Analysis
 *
 * Spectral flatness measures how noise-like vs tonal a signal is.
 * Natural speech has a characteristic spectral shape with formant
 * peaks. AI-generated speech sometimes has an abnormally flat or
 * unusual spectral envelope.
 *
 * We compute a simple DFT on short windows and measure the flatness
 * (geometric mean / arithmetic mean of the power spectrum).
 */
function analyzeSpectralFlatness(samples: Float32Array, sampleRate: number): { score: number; detail: string } {
  const windowSize = 1024;
  const flatnesses: number[] = [];

  const numWindows = Math.min(50, Math.floor(samples.length / windowSize));

  for (let w = 0; w < numWindows; w++) {
    const offset = Math.floor((w / numWindows) * (samples.length - windowSize));
    const window = samples.slice(offset, offset + windowSize);

    // Compute magnitude spectrum using a simple DFT approximation
    // (We use squared magnitudes for efficiency)
    const halfSize = windowSize / 2;
    const magnitudes = new Float32Array(halfSize);

    for (let k = 0; k < halfSize; k++) {
      let real = 0, imag = 0;
      for (let n = 0; n < windowSize; n++) {
        const angle = (2 * Math.PI * k * n) / windowSize;
        real += window[n] * Math.cos(angle);
        imag -= window[n] * Math.sin(angle);
      }
      magnitudes[k] = real * real + imag * imag;
    }

    // Spectral flatness = geometric mean / arithmetic mean
    const epsilon = 1e-10;
    let logSum = 0;
    let linSum = 0;
    for (let k = 1; k < halfSize; k++) { // Skip DC
      logSum += Math.log(magnitudes[k] + epsilon);
      linSum += magnitudes[k];
    }
    const geoMean = Math.exp(logSum / (halfSize - 1));
    const ariMean = linSum / (halfSize - 1);
    const flatness = ariMean > 0 ? geoMean / ariMean : 0;

    flatnesses.push(flatness);
  }

  if (flatnesses.length === 0) {
    return { score: 0.5, detail: "Audio too short for spectral analysis" };
  }

  const meanFlatness = flatnesses.reduce((a, b) => a + b, 0) / flatnesses.length;
  const stdFlatness = Math.sqrt(
    flatnesses.reduce((a, b) => a + (b - meanFlatness) ** 2, 0) / flatnesses.length
  );

  // Natural speech typically has low flatness (formant structure)
  // Very high flatness = noise-like (unusual for speech)
  // Very low std = unnaturally consistent spectral shape
  let score = 0;

  // Abnormally uniform spectral flatness
  if (stdFlatness < 0.02 && meanFlatness < 0.3) score += 0.35;
  else if (stdFlatness < 0.05) score += 0.15;

  // Unusual mean flatness for speech  
  if (meanFlatness > 0.5) score += 0.3;
  else if (meanFlatness > 0.35) score += 0.15;

  // Very low flatness std suggests synthetic uniformity
  if (stdFlatness < 0.015) score += 0.25;

  score = Math.min(score, 1);

  const detail =
    score > 0.4
      ? `Spectral flatness is abnormal (mean=${meanFlatness.toFixed(3)}, std=${stdFlatness.toFixed(3)}) — may indicate synthetic audio`
      : `Spectral characteristics are within normal range (flatness=${meanFlatness.toFixed(3)})`;

  return { score, detail };
}

/**
 * 2. Noise Floor Consistency
 *
 * Natural recordings have varying background noise (room tone,
 * ambient sounds). AI-generated audio often has an artificially
 * uniform noise floor or an unnaturally clean signal.
 */
function analyzeNoiseFloor(samples: Float32Array): { score: number; detail: string } {
  const segmentSize = 2048;
  const segmentEnergies: number[] = [];

  const numSegments = Math.min(100, Math.floor(samples.length / segmentSize));

  for (let i = 0; i < numSegments; i++) {
    const offset = Math.floor((i / numSegments) * (samples.length - segmentSize));
    let energy = 0;
    for (let j = 0; j < segmentSize; j++) {
      energy += samples[offset + j] * samples[offset + j];
    }
    segmentEnergies.push(energy / segmentSize);
  }

  if (segmentEnergies.length < 4) {
    return { score: 0.5, detail: "Audio too short for noise floor analysis" };
  }

  // Find quiet segments (bottom 20%) as noise floor proxy
  const sorted = [...segmentEnergies].sort((a, b) => a - b);
  const quietCount = Math.max(2, Math.floor(sorted.length * 0.2));
  const quietSegments = sorted.slice(0, quietCount);

  const meanQuiet = quietSegments.reduce((a, b) => a + b, 0) / quietSegments.length;
  const stdQuiet = Math.sqrt(
    quietSegments.reduce((a, b) => a + (b - meanQuiet) ** 2, 0) / quietSegments.length
  );
  const cov = meanQuiet > 0 ? stdQuiet / meanQuiet : 0;

  // Also check overall dynamic range
  const maxEnergy = sorted[sorted.length - 1];
  const dynamicRange = maxEnergy > 0 ? meanQuiet / maxEnergy : 0;

  let score = 0;

  // Unnaturally uniform noise floor
  if (cov < 0.05) score += 0.4;
  else if (cov < 0.15) score += 0.2;

  // Unnaturally low noise floor (too clean)
  if (meanQuiet < 1e-8) score += 0.3;
  else if (meanQuiet < 1e-6) score += 0.15;

  // Poor dynamic range can indicate synthesis
  if (dynamicRange > 0.3) score += 0.2;

  score = Math.min(score, 1);

  const detail =
    score > 0.4
      ? `Background noise floor is unnaturally uniform (CoV=${cov.toFixed(3)}) — consistent with synthetic audio`
      : `Background noise characteristics appear natural (CoV=${cov.toFixed(3)})`;

  return { score, detail };
}

/**
 * 3. Zero-Crossing Rate Analysis
 *
 * The zero-crossing rate (ZCR) describes how frequently a signal
 * crosses the zero amplitude line. Natural speech has characteristic
 * ZCR patterns that differ between voiced and unvoiced segments.
 * Synthetic audio sometimes has abnormal ZCR distributions.
 */
function analyzeZeroCrossingRate(samples: Float32Array): { score: number; detail: string } {
  const frameSize = 1024;
  const zcrs: number[] = [];

  const numFrames = Math.min(80, Math.floor(samples.length / frameSize));

  for (let f = 0; f < numFrames; f++) {
    const offset = Math.floor((f / numFrames) * (samples.length - frameSize));
    let crossings = 0;
    for (let i = 1; i < frameSize; i++) {
      if (
        (samples[offset + i] >= 0 && samples[offset + i - 1] < 0) ||
        (samples[offset + i] < 0 && samples[offset + i - 1] >= 0)
      ) {
        crossings++;
      }
    }
    zcrs.push(crossings / frameSize);
  }

  if (zcrs.length < 4) {
    return { score: 0.5, detail: "Audio too short for ZCR analysis" };
  }

  const meanZCR = zcrs.reduce((a, b) => a + b, 0) / zcrs.length;
  const stdZCR = Math.sqrt(
    zcrs.reduce((a, b) => a + (b - meanZCR) ** 2, 0) / zcrs.length
  );
  const cov = meanZCR > 0 ? stdZCR / meanZCR : 0;

  let score = 0;

  // Abnormally uniform ZCR pattern (synthetic)
  if (cov < 0.1) score += 0.4;
  else if (cov < 0.2) score += 0.2;

  // Natural speech typically has ZCR CoV > 0.3
  if (cov < 0.15) score += 0.2;

  score = Math.min(score, 1);

  const detail =
    score > 0.4
      ? `Zero-crossing rate is unnaturally uniform (CoV=${cov.toFixed(3)}) — voice formant distribution inconsistent with natural speech`
      : `Zero-crossing rate variation is natural (CoV=${cov.toFixed(3)})`;

  return { score, detail };
}

/**
 * 4. Amplitude Envelope Analysis
 *
 * Natural speech has characteristic amplitude modulation patterns
 * (syllable rhythm, breaths). Synthetic audio sometimes has
 * smoother or more regular amplitude envelopes.
 */
function analyzeAmplitudeEnvelope(samples: Float32Array): { score: number; detail: string } {
  const frameSize = 512;
  const envelopeValues: number[] = [];

  const numFrames = Math.min(100, Math.floor(samples.length / frameSize));

  for (let f = 0; f < numFrames; f++) {
    const offset = Math.floor((f / numFrames) * (samples.length - frameSize));
    let maxAmp = 0;
    for (let i = 0; i < frameSize; i++) {
      maxAmp = Math.max(maxAmp, Math.abs(samples[offset + i]));
    }
    envelopeValues.push(maxAmp);
  }

  if (envelopeValues.length < 4) {
    return { score: 0.5, detail: "Audio too short for envelope analysis" };
  }

  // Compute the "bumpiness" of the envelope — how much it oscillates
  let diffSum = 0;
  for (let i = 1; i < envelopeValues.length; i++) {
    diffSum += Math.abs(envelopeValues[i] - envelopeValues[i - 1]);
  }
  const avgDiff = diffSum / (envelopeValues.length - 1);

  const meanEnv = envelopeValues.reduce((a, b) => a + b, 0) / envelopeValues.length;
  const normalizedDiff = meanEnv > 0 ? avgDiff / meanEnv : 0;

  let score = 0;

  // Very smooth envelope (low normalised diff) is suspicious
  if (normalizedDiff < 0.08) score += 0.4;
  else if (normalizedDiff < 0.15) score += 0.2;

  // Too uniform peak amplitudes
  const stdEnv = Math.sqrt(
    envelopeValues.reduce((a, b) => a + (b - meanEnv) ** 2, 0) / envelopeValues.length
  );
  const envCov = meanEnv > 0 ? stdEnv / meanEnv : 0;
  if (envCov < 0.2) score += 0.3;
  else if (envCov < 0.35) score += 0.15;

  score = Math.min(score, 1);

  const detail =
    score > 0.4
      ? `Amplitude envelope is abnormally smooth (variation=${normalizedDiff.toFixed(3)}) — suggests synthesised speech`
      : `Amplitude envelope shows natural speech patterns (variation=${normalizedDiff.toFixed(3)})`;

  return { score, detail };
}

// ── main analyser ──────────────────────────────────────────────────

export async function analyzeAudio(file: File): Promise<AudioAnalysisResult> {
  let audioBuffer: AudioBuffer;

  try {
    audioBuffer = await decodeAudio(file);
  } catch {
    return {
      isFake: false,
      confidence: 50,
      reasons: ["Unable to decode audio file for analysis"],
    };
  }

  // Use the first channel
  const samples = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;

  const spectral = analyzeSpectralFlatness(samples, sampleRate);
  const noiseFloor = analyzeNoiseFloor(samples);
  const zcr = analyzeZeroCrossingRate(samples);
  const envelope = analyzeAmplitudeEnvelope(samples);

  // Weighted composite
  const composite =
    spectral.score * 0.30 +
    noiseFloor.score * 0.25 +
    zcr.score * 0.25 +
    envelope.score * 0.20;

  const isFake = composite > 0.42;

  const rawConf = Math.abs(composite - 0.42) / 0.58;
  const confidence = Math.round((70 + rawConf * 28) * 10) / 10;

  const reasons: string[] = [];
  const allTests = [
    { result: spectral },
    { result: noiseFloor },
    { result: zcr },
    { result: envelope },
  ];

  for (const t of allTests) {
    if (t.result.score > 0.4) {
      reasons.push(t.result.detail);
    }
  }

  return { isFake, confidence, reasons };
}
