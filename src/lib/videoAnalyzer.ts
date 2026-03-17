/**
 * Video Analyzer — Client-side deepfake detection for video files.
 *
 * Extracts several frames from the video at different timestamps,
 * runs image-level analysis on each, and also checks for temporal
 * consistency between consecutive frames.
 */

import { analyzeImage, type ImageAnalysisResult } from "./imageAnalyzer";

export interface VideoAnalysisResult {
  isFake: boolean;
  confidence: number;
  reasons: string[];
}

// ── helpers ────────────────────────────────────────────────────────

/** Load video metadata (duration, dimensions) */
const loadVideo = (file: File): Promise<HTMLVideoElement> =>
  new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    video.src = url;

    video.onloadedmetadata = () => {
      resolve(video);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load video"));
    };
  });

/** Seek video to a specific time and capture a frame as a File (PNG blob) */
const captureFrameAt = (
  video: HTMLVideoElement,
  time: number,
  maxDim = 512
): Promise<{ file: File; pixelData: Uint8ClampedArray; width: number; height: number }> =>
  new Promise((resolve, reject) => {
    video.currentTime = time;
    video.onseeked = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
        const w = Math.round(video.videoWidth * scale);
        const h = Math.round(video.videoHeight * scale);

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(video, 0, 0, w, h);

        const imageData = ctx.getImageData(0, 0, w, h);

        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("Failed to capture frame"));
            return;
          }
          const frameFile = new File([blob], `frame_${time.toFixed(2)}.png`, { type: "image/png" });
          resolve({ file: frameFile, pixelData: imageData.data, width: w, height: h });
        }, "image/png");
      } catch (err) {
        reject(err);
      }
    };
    video.onerror = () => reject(new Error("Video seek error"));
  });

// ── temporal consistency analysis ──────────────────────────────────

/**
 * Compare two consecutive frames for temporal consistency.
 *
 * Deepfake videos often exhibit:
 * - Sudden luminance/color jumps between frames
 * - Inconsistent face geometry (face region jitter)
 * - Flickering around face boundaries
 *
 * We compute per-pixel differences between frames and look
 * for unusually large or uneven changes.
 */
function analyzeTemporalConsistency(
  frameA: Uint8ClampedArray,
  frameB: Uint8ClampedArray,
  width: number,
  height: number
): { score: number; detail: string } {
  const n = width * height;
  const diffs: number[] = [];

  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const dr = Math.abs(frameA[idx] - frameB[idx]);
    const dg = Math.abs(frameA[idx + 1] - frameB[idx + 1]);
    const db = Math.abs(frameA[idx + 2] - frameB[idx + 2]);
    diffs.push((dr + dg + db) / 3);
  }

  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const stdDiff = Math.sqrt(
    diffs.reduce((a, b) => a + (b - meanDiff) ** 2, 0) / diffs.length
  );

  // Check for abnormal jitter — high std relative to mean indicates
  // localised flickering (face swap boundaries flicker)
  const jitterRatio = meanDiff > 0 ? stdDiff / meanDiff : 0;

  // Count pixels with large frame-to-frame change
  const largeChangeRatio = diffs.filter((d) => d > 40).length / n;

  let score = 0;

  // Localised jitter
  if (jitterRatio > 3.5) score += 0.4;
  else if (jitterRatio > 2.5) score += 0.2;

  // Too many large-change pixels in a short time interval
  if (largeChangeRatio > 0.3) score += 0.4;
  else if (largeChangeRatio > 0.15) score += 0.2;

  score = Math.min(score, 1);

  const detail =
    score > 0.4
      ? `Temporal inconsistency detected between frames (jitter=${jitterRatio.toFixed(2)}, largeChange=${(largeChangeRatio * 100).toFixed(1)}%)`
      : `Frame-to-frame consistency is within normal range`;

  return { score, detail };
}

/**
 * Analyze compression consistency across frames.
 *
 * In manipulated videos the compression level is often inconsistent
 * because the fake region was rendered separately from the background.
 */
function analyzeCompressionConsistency(
  frames: Array<{ pixelData: Uint8ClampedArray; width: number; height: number }>
): { score: number; detail: string } {
  // Measure block-level variance for each frame (8x8 blocks like JPEG)
  const frameBlockVariances: number[] = [];

  for (const { pixelData, width, height } of frames) {
    const blockSize = 8;
    const blockVars: number[] = [];

    for (let by = 0; by + blockSize <= height; by += blockSize) {
      for (let bx = 0; bx + blockSize <= width; bx += blockSize) {
        const lumas: number[] = [];
        for (let y = by; y < by + blockSize; y++) {
          for (let x = bx; x < bx + blockSize; x++) {
            const idx = (y * width + x) * 4;
            lumas.push(0.299 * pixelData[idx] + 0.587 * pixelData[idx + 1] + 0.114 * pixelData[idx + 2]);
          }
        }
        const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length;
        const variance = lumas.reduce((a, b) => a + (b - mean) ** 2, 0) / lumas.length;
        blockVars.push(variance);
      }
    }

    if (blockVars.length > 0) {
      const meanBlockVar = blockVars.reduce((a, b) => a + b, 0) / blockVars.length;
      frameBlockVariances.push(meanBlockVar);
    }
  }

  if (frameBlockVariances.length < 2) {
    return { score: 0.3, detail: "Not enough frames for compression analysis" };
  }

  // Measure how consistent block variance is across frames
  const meanFBV = frameBlockVariances.reduce((a, b) => a + b, 0) / frameBlockVariances.length;
  const stdFBV = Math.sqrt(
    frameBlockVariances.reduce((a, b) => a + (b - meanFBV) ** 2, 0) / frameBlockVariances.length
  );
  const cov = meanFBV > 0 ? stdFBV / meanFBV : 0;

  // High variation in compression across frames suggests manipulation
  let score: number;
  if (cov > 0.5) score = 0.8;
  else if (cov > 0.3) score = 0.55;
  else if (cov > 0.15) score = 0.3;
  else score = 0.1;

  const detail =
    score > 0.5
      ? `Compression level is inconsistent across frames (CoV=${cov.toFixed(2)}) — suggests manipulation`
      : `Compression consistency across frames is normal (CoV=${cov.toFixed(2)})`;

  return { score, detail };
}

// ── main analyser ──────────────────────────────────────────────────

export async function analyzeVideo(file: File): Promise<VideoAnalysisResult> {
  const video = await loadVideo(file);
  const duration = video.duration;

  // Determine frame capture timestamps — up to 6 evenly spaced frames
  const numFrames = Math.min(6, Math.max(2, Math.floor(duration)));
  const timestamps: number[] = [];
  for (let i = 0; i < numFrames; i++) {
    // Avoid the very start (often black) and very end
    const t = 0.5 + ((duration - 1) * i) / Math.max(1, numFrames - 1);
    timestamps.push(Math.min(t, duration - 0.1));
  }

  // Capture frames
  const capturedFrames: Array<{
    file: File;
    pixelData: Uint8ClampedArray;
    width: number;
    height: number;
  }> = [];

  for (const t of timestamps) {
    try {
      const frame = await captureFrameAt(video, t);
      capturedFrames.push(frame);
    } catch {
      // Skip frames that fail to capture
    }
  }

  // Clean up video source
  URL.revokeObjectURL(video.src);

  if (capturedFrames.length === 0) {
    return {
      isFake: false,
      confidence: 50,
      reasons: ["Unable to extract frames for analysis"],
    };
  }

  // 1. Run image-level analysis on each frame
  const frameResults: ImageAnalysisResult[] = [];
  for (const frame of capturedFrames) {
    const result = await analyzeImage(frame.file);
    frameResults.push(result);
  }

  // Average per-frame fake score
  const avgFrameComposite =
    frameResults.reduce((sum, r) => {
      const allScores = Object.values(r.scores);
      const avgScore = allScores.reduce((a, b) => a + b, 0) / allScores.length;
      return sum + avgScore;
    }, 0) / frameResults.length;

  // 2. Temporal consistency between consecutive frames
  const temporalScores: number[] = [];
  const temporalDetails: string[] = [];
  for (let i = 0; i < capturedFrames.length - 1; i++) {
    const a = capturedFrames[i];
    const b = capturedFrames[i + 1];
    if (a.width === b.width && a.height === b.height) {
      const temporal = analyzeTemporalConsistency(a.pixelData, b.pixelData, a.width, a.height);
      temporalScores.push(temporal.score);
      if (temporal.score > 0.4) temporalDetails.push(temporal.detail);
    }
  }
  const avgTemporal =
    temporalScores.length > 0
      ? temporalScores.reduce((a, b) => a + b, 0) / temporalScores.length
      : 0;

  // 3. Compression consistency
  const compression = analyzeCompressionConsistency(capturedFrames);

  // Composite scoring
  const composite =
    avgFrameComposite * 0.45 +   // per-frame image analysis
    avgTemporal * 0.30 +          // temporal consistency
    compression.score * 0.25;     // compression consistency

  const isFake = composite > 0.42;

  const rawConf = Math.abs(composite - 0.42) / 0.58;
  const confidence = Math.round((72 + rawConf * 26) * 10) / 10;

  // Collect reasons
  const reasons: string[] = [];

  // From frames that flagged as fake
  const fakeFrames = frameResults.filter((r) => r.isFake);
  if (fakeFrames.length > 0) {
    reasons.push(
      `${fakeFrames.length}/${frameResults.length} extracted frames show synthetic characteristics`
    );
    // Add top reasons from the most-flagged frame
    const mostFlagged = fakeFrames.reduce((a, b) =>
      a.reasons.length >= b.reasons.length ? a : b
    );
    reasons.push(...mostFlagged.reasons.slice(0, 2));
  }

  // Temporal reasons
  reasons.push(...temporalDetails.slice(0, 2));

  // Compression reasons
  if (compression.score > 0.5) {
    reasons.push(compression.detail);
  }

  return { isFake, confidence, reasons };
}
