/**
 * Image Analyzer — Client-side deepfake detection for images.
 *
 * Loads the image into an off-screen canvas, reads raw pixel data,
 * and runs several statistical tests that distinguish real camera
 * photos from AI-generated / GAN images.
 *
 * Each test returns a score between 0 (authentic) and 1 (fake).
 * The scores are combined with weights to produce a final verdict.
 */

export interface ImageAnalysisResult {
  isFake: boolean;
  confidence: number;
  reasons: string[];
  scores: Record<string, number>;
}

// ── helpers ────────────────────────────────────────────────────────

/** Load a File (image) into an HTMLImageElement */
const loadImage = (file: File): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    const url = URL.createObjectURL(file);
    img.src = url;
    // Revoke after load to avoid memory leak
    img.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
  });

/** Draw image on an off-screen canvas and return pixel data */
const getPixelData = (
  img: HTMLImageElement,
  maxDim = 512
): { data: Uint8ClampedArray; width: number; height: number } => {
  const canvas = document.createElement("canvas");
  // Down-scale large images for performance
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.round(img.naturalWidth * scale);
  const height = Math.round(img.naturalHeight * scale);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return { data: imageData.data, width, height };
};

// ── individual analysis tests ──────────────────────────────────────

/**
 * 1. Noise Uniformity Analysis
 *
 * Real photos have varying noise levels — more noise in dark/shadow
 * regions and less in highlights. GAN images tend to have
 * abnormally *uniform* noise across the entire image.
 *
 * We divide the image into patches, compute local noise variance
 * in each patch, and then measure the coefficient of variation
 * of those variances. Low CoV → uniform noise → more likely fake.
 */
function analyzeNoiseUniformity(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { score: number; detail: string } {
  const patchSize = 16;
  const patchVariances: number[] = [];

  for (let py = 0; py + patchSize <= height; py += patchSize) {
    for (let px = 0; px + patchSize <= width; px += patchSize) {
      const lumas: number[] = [];
      for (let y = py; y < py + patchSize; y++) {
        for (let x = px; x < px + patchSize; x++) {
          const idx = (y * width + x) * 4;
          // Convert to luminance
          const luma = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          lumas.push(luma);
        }
      }
      const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length;
      const variance = lumas.reduce((a, b) => a + (b - mean) ** 2, 0) / lumas.length;
      patchVariances.push(variance);
    }
  }

  if (patchVariances.length < 4) {
    return { score: 0.5, detail: "Image too small for noise analysis" };
  }

  const meanVar = patchVariances.reduce((a, b) => a + b, 0) / patchVariances.length;
  const stdVar = Math.sqrt(
    patchVariances.reduce((a, b) => a + (b - meanVar) ** 2, 0) / patchVariances.length
  );
  // Coefficient of variation
  const cov = meanVar > 0 ? stdVar / meanVar : 0;

  // Low CoV (< 0.3) is suspicious (uniform noise ≈ GAN)
  // High CoV (> 0.8) is typical of real photos
  let score: number;
  if (cov < 0.2) score = 0.9;
  else if (cov < 0.35) score = 0.7;
  else if (cov < 0.5) score = 0.45;
  else if (cov < 0.7) score = 0.25;
  else score = 0.1;

  const detail =
    score > 0.5
      ? `Noise uniformity is abnormally high (CoV=${cov.toFixed(2)}) — consistent with GAN output`
      : `Noise distribution is natural (CoV=${cov.toFixed(2)})`;

  return { score, detail };
}

/**
 * 2. Color Channel Correlation
 *
 * In real photographs, the red, green, and blue channels are
 * highly correlated because natural lighting affects all channels
 * similarly.  Some AI models generate channels more independently
 * leading to lower inter-channel correlation.
 */
function analyzeChannelCorrelation(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { score: number; detail: string } {
  const n = width * height;
  let sumR = 0, sumG = 0, sumB = 0;
  let sumRG = 0, sumRB = 0, sumGB = 0;
  let sumR2 = 0, sumG2 = 0, sumB2 = 0;

  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    sumR += r; sumG += g; sumB += b;
    sumR2 += r * r; sumG2 += g * g; sumB2 += b * b;
    sumRG += r * g; sumRB += r * b; sumGB += g * b;
  }

  const pearson = (sumXY: number, sumX: number, sumY: number, sumX2: number, sumY2: number) => {
    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    return den === 0 ? 1 : num / den;
  };

  const corrRG = pearson(sumRG, sumR, sumG, sumR2, sumG2);
  const corrRB = pearson(sumRB, sumR, sumB, sumR2, sumB2);
  const corrGB = pearson(sumGB, sumG, sumB, sumG2, sumB2);
  const avgCorr = (corrRG + corrRB + corrGB) / 3;

  // Real photos typically have avgCorr > 0.85
  // AI images sometimes drop below 0.75
  let score: number;
  if (avgCorr > 0.92) score = 0.1;
  else if (avgCorr > 0.85) score = 0.25;
  else if (avgCorr > 0.75) score = 0.5;
  else if (avgCorr > 0.6) score = 0.7;
  else score = 0.85;

  const detail =
    score > 0.5
      ? `Color channel correlation is unusually low (${avgCorr.toFixed(3)}) — possible synthetic origin`
      : `Color channel correlation is within normal range (${avgCorr.toFixed(3)})`;

  return { score, detail };
}

/**
 * 3. Edge Consistency Analysis
 *
 * We compute a simple Sobel-like gradient magnitude across the image,
 * then measure the distribution of gradient values. GAN images
 * often produce unnaturally sharp or uniform edges,
 * while real photos have a more organic gradient distribution.
 */
function analyzeEdgeConsistency(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { score: number; detail: string } {
  const luma = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    luma[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  const gradients: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const gx =
        -luma[(y - 1) * width + (x - 1)] +
        luma[(y - 1) * width + (x + 1)] +
        -2 * luma[y * width + (x - 1)] +
        2 * luma[y * width + (x + 1)] +
        -luma[(y + 1) * width + (x - 1)] +
        luma[(y + 1) * width + (x + 1)];
      const gy =
        -luma[(y - 1) * width + (x - 1)] +
        -2 * luma[(y - 1) * width + x] +
        -luma[(y - 1) * width + (x + 1)] +
        luma[(y + 1) * width + (x - 1)] +
        2 * luma[(y + 1) * width + x] +
        luma[(y + 1) * width + (x + 1)];
      gradients.push(Math.sqrt(gx * gx + gy * gy));
    }
  }

  if (gradients.length < 100) {
    return { score: 0.5, detail: "Image too small for edge analysis" };
  }

  const meanG = gradients.reduce((a, b) => a + b, 0) / gradients.length;
  const stdG = Math.sqrt(
    gradients.reduce((a, b) => a + (b - meanG) ** 2, 0) / gradients.length
  );
  const kurtosis =
    gradients.reduce((a, b) => a + ((b - meanG) / (stdG || 1)) ** 4, 0) / gradients.length - 3;

  // Real photos tend to have higher kurtosis (heavy-tailed gradient distribution)
  // GAN images have more peaked/narrow distributions (lower kurtosis)
  let score: number;
  if (kurtosis > 15) score = 0.1;
  else if (kurtosis > 8) score = 0.2;
  else if (kurtosis > 4) score = 0.35;
  else if (kurtosis > 2) score = 0.55;
  else score = 0.75;

  const detail =
    score > 0.5
      ? `Edge distribution has abnormally low kurtosis (${kurtosis.toFixed(1)}) — uniform edges suggest synthesis`
      : `Edge distribution is natural (kurtosis=${kurtosis.toFixed(1)})`;

  return { score, detail };
}

/**
 * 4. Saturation & Color Histogram Analysis
 *
 * AI-generated images sometimes have unusual saturation
 * distributions — either hyper-saturated or oddly quantized colours.
 * We compute a histogram of hue-saturation values and check
 * for anomalies.
 */
function analyzeSaturation(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { score: number; detail: string } {
  const saturations: number[] = [];
  const n = width * height;

  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const r = data[idx] / 255;
    const g = data[idx + 1] / 255;
    const b = data[idx + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    saturations.push(sat);
  }

  const meanSat = saturations.reduce((a, b) => a + b, 0) / saturations.length;
  const stdSat = Math.sqrt(
    saturations.reduce((a, b) => a + (b - meanSat) ** 2, 0) / saturations.length
  );

  // Count pixels in very high saturation (>0.85)
  const highSatRatio = saturations.filter((s) => s > 0.85).length / n;

  // AI images often have either very high mean saturation or unusual
  // high-saturation pixel ratios
  let score = 0;

  // Abnormally high average saturation
  if (meanSat > 0.55) score += 0.3;
  else if (meanSat > 0.45) score += 0.15;

  // Too many hyper-saturated pixels
  if (highSatRatio > 0.15) score += 0.3;
  else if (highSatRatio > 0.08) score += 0.15;

  // Very low saturation standard deviation (unnaturally uniform)
  if (stdSat < 0.08) score += 0.25;
  else if (stdSat < 0.12) score += 0.1;

  score = Math.min(score, 1);

  const detail =
    score > 0.5
      ? `Unusual saturation profile (mean=${meanSat.toFixed(2)}, highSat=${(highSatRatio * 100).toFixed(1)}%) — possible AI enhancement`
      : `Saturation distribution appears natural (mean=${meanSat.toFixed(2)})`;

  return { score, detail };
}

/**
 * 5. EXIF / Metadata Check
 *
 * Real photos from cameras contain EXIF metadata.
 * AI-generated images almost never have valid EXIF data.
 * We do a simple check by reading the first bytes of the file
 * looking for EXIF markers.
 */
async function analyzeMetadata(file: File): Promise<{ score: number; detail: string }> {
  const buffer = await file.slice(0, 65536).arrayBuffer();
  const view = new Uint8Array(buffer);

  let hasExif = false;
  let hasXmp = false;

  // Search for EXIF marker in JPEG (0xFF 0xE1) or TIFF header
  for (let i = 0; i < view.length - 4; i++) {
    // JPEG EXIF APP1 marker
    if (view[i] === 0xff && view[i + 1] === 0xe1) {
      hasExif = true;
      break;
    }
    // TIFF header "Exif"
    if (
      view[i] === 0x45 && // E
      view[i + 1] === 0x78 && // x
      view[i + 2] === 0x69 && // i
      view[i + 3] === 0x66 // f
    ) {
      hasExif = true;
      break;
    }
  }

  // Check for XMP metadata (common in Adobe/camera files)
  const textDecoder = new TextDecoder("ascii", { fatal: false });
  const headerText = textDecoder.decode(view.slice(0, Math.min(view.length, 4096)));
  if (headerText.includes("xmp") || headerText.includes("XMP") || headerText.includes("photoshop")) {
    hasXmp = true;
  }

  // Also check if filename suggests camera origin
  const name = file.name.toLowerCase();
  const cameraPatterns = /^(img|dsc|dcim|photo|p\d|dji|gopro|samsung|iphone)/;
  const hasCameraName = cameraPatterns.test(name);

  let score: number;
  if (hasExif && hasXmp) score = 0.05;
  else if (hasExif) score = 0.15;
  else if (hasXmp || hasCameraName) score = 0.3;
  else score = 0.65;

  const detail = hasExif
    ? "EXIF metadata present — consistent with camera-captured image"
    : "No EXIF metadata found — may indicate AI-generated or heavily processed image";

  return { score, detail };
}

/**
 * 6. Pixel-Level Regularity / Grid Artifact Detection
 *
 * Some GAN architectures (especially older ones) leave subtle
 * grid-like artifacts. We check for periodic patterns in the
 * spatial gradient at specific frequencies.
 */
function analyzeGridArtifacts(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { score: number; detail: string } {
  const luma = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    luma[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  // Check for periodicity by computing auto-correlation at common GAN grid sizes
  const gridSizes = [2, 4, 8, 16];
  let maxPeriodicity = 0;

  for (const gs of gridSizes) {
    if (gs >= width || gs >= height) continue;

    let correlation = 0;
    let count = 0;

    // Sample horizontal lines
    for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 32))) {
      for (let x = 0; x + gs < width; x++) {
        const diff = Math.abs(luma[y * width + x] - luma[y * width + x + gs]);
        correlation += diff;
        count++;
      }
    }

    if (count === 0) continue;
    const avgDiff = correlation / count;

    // Also compute baseline diff at offset 1
    let baseDiff = 0;
    let baseCount = 0;
    for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 32))) {
      for (let x = 0; x + 1 < width; x++) {
        baseDiff += Math.abs(luma[y * width + x] - luma[y * width + x + 1]);
        baseCount++;
      }
    }
    const avgBaseDiff = baseCount > 0 ? baseDiff / baseCount : 1;

    // If the diff at grid-size frequency is significantly *lower* than baseline,
    // it hints at a periodic structure
    const ratio = avgBaseDiff > 0 ? avgDiff / avgBaseDiff : 1;
    if (ratio < 0.7) {
      maxPeriodicity = Math.max(maxPeriodicity, 1 - ratio);
    }
  }

  const score = Math.min(maxPeriodicity * 2, 1);

  const detail =
    score > 0.4
      ? `Periodic grid artifacts detected (periodicity strength=${maxPeriodicity.toFixed(2)})`
      : "No significant grid artifacts detected";

  return { score, detail };
}

/**
 * 7. Smoothness / Texture Analysis (Face-swap focused)
 *
 * Deepfake face swaps often produce unnaturally smooth skin textures
 * because the face generation network smooths over fine details.
 * We measure local texture energy in small patches — real photos
 * have higher and more varied texture energy.
 */
function analyzeSmoothnessTexture(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { score: number; detail: string } {
  const patchSize = 8;
  const textureEnergies: number[] = [];

  // Focus on the central region (where faces typically are)
  const startX = Math.floor(width * 0.15);
  const endX = Math.floor(width * 0.85);
  const startY = Math.floor(height * 0.1);
  const endY = Math.floor(height * 0.75);

  for (let py = startY; py + patchSize <= endY; py += patchSize) {
    for (let px = startX; px + patchSize <= endX; px += patchSize) {
      let energy = 0;
      let count = 0;

      for (let y = py; y < py + patchSize - 1; y++) {
        for (let x = px; x < px + patchSize - 1; x++) {
          const idx = (y * width + x) * 4;
          const idxR = (y * width + x + 1) * 4;
          const idxD = ((y + 1) * width + x) * 4;

          // Compute luminance differences to adjacent pixels
          const lumaC = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          const lumaR = 0.299 * data[idxR] + 0.587 * data[idxR + 1] + 0.114 * data[idxR + 2];
          const lumaD = 0.299 * data[idxD] + 0.587 * data[idxD + 1] + 0.114 * data[idxD + 2];

          energy += Math.abs(lumaC - lumaR) + Math.abs(lumaC - lumaD);
          count++;
        }
      }

      if (count > 0) {
        textureEnergies.push(energy / count);
      }
    }
  }

  if (textureEnergies.length < 4) {
    return { score: 0.5, detail: "Image too small for texture analysis" };
  }

  const meanEnergy = textureEnergies.reduce((a, b) => a + b, 0) / textureEnergies.length;
  const stdEnergy = Math.sqrt(
    textureEnergies.reduce((a, b) => a + (b - meanEnergy) ** 2, 0) / textureEnergies.length
  );

  // Count patches with very low texture (smooth areas)
  const smoothPatchRatio = textureEnergies.filter((e) => e < 2.0).length / textureEnergies.length;

  let score = 0;

  // High ratio of smooth patches = possible deepfake smoothing
  if (smoothPatchRatio > 0.5) score += 0.4;
  else if (smoothPatchRatio > 0.35) score += 0.25;
  else if (smoothPatchRatio > 0.2) score += 0.1;

  // Very low overall texture energy
  if (meanEnergy < 3.0) score += 0.3;
  else if (meanEnergy < 5.0) score += 0.15;

  // Low texture variation (face region uniformly smooth)
  const texCov = meanEnergy > 0 ? stdEnergy / meanEnergy : 0;
  if (texCov < 0.3) score += 0.2;
  else if (texCov < 0.5) score += 0.1;

  score = Math.min(score, 1);

  const detail =
    score > 0.4
      ? `Unnatural skin smoothness detected (smooth patches=${(smoothPatchRatio * 100).toFixed(0)}%, energy=${meanEnergy.toFixed(1)}) — consistent with face-swap smoothing`
      : `Texture detail appears natural (energy=${meanEnergy.toFixed(1)})`;

  return { score, detail };
}

/**
 * 8. Local Contrast Variance (Face-swap boundary detection)
 *
 * In face-swapped images, the inserted face region was generated
 * separately from the background, leading to differences in local
 * contrast, compression quality, and noise level between the face
 * area and its surroundings. We divide the image into quadrants
 * and measure the variance of local contrast — a large discrepancy
 * suggests that parts of the image were processed differently.
 */
function analyzeLocalContrastVariance(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { score: number; detail: string } {
  const regionSize = 4; // 4x4 grid of regions
  const regionContrasts: number[] = [];
  const rw = Math.floor(width / regionSize);
  const rh = Math.floor(height / regionSize);

  for (let ry = 0; ry < regionSize; ry++) {
    for (let rx = 0; rx < regionSize; rx++) {
      const startX = rx * rw;
      const startY = ry * rh;
      let minLuma = 255, maxLuma = 0;
      let sumLuma = 0;
      let count = 0;

      // Sample pixels within the region
      const step = Math.max(1, Math.floor(rw * rh / 500));
      for (let y = startY; y < startY + rh && y < height; y += step) {
        for (let x = startX; x < startX + rw && x < width; x += step) {
          const idx = (y * width + x) * 4;
          const luma = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          minLuma = Math.min(minLuma, luma);
          maxLuma = Math.max(maxLuma, luma);
          sumLuma += luma;
          count++;
        }
      }

      if (count > 0) {
        const contrast = maxLuma - minLuma;
        regionContrasts.push(contrast);
      }
    }
  }

  if (regionContrasts.length < 4) {
    return { score: 0.5, detail: "Image too small for local contrast analysis" };
  }

  const meanContrast = regionContrasts.reduce((a, b) => a + b, 0) / regionContrasts.length;
  const stdContrast = Math.sqrt(
    regionContrasts.reduce((a, b) => a + (b - meanContrast) ** 2, 0) / regionContrasts.length
  );
  const contrastCov = meanContrast > 0 ? stdContrast / meanContrast : 0;

  // Separate center vs edge regions for comparison
  // Center regions (indices 5,6,9,10 in a 4x4 grid) typically contain the face
  const centerIndices = [5, 6, 9, 10];
  const edgeIndices = regionContrasts
    .map((_, i) => i)
    .filter((i) => !centerIndices.includes(i));

  const centerContrasts = centerIndices
    .filter((i) => i < regionContrasts.length)
    .map((i) => regionContrasts[i]);
  const edgeContrasts = edgeIndices
    .filter((i) => i < regionContrasts.length)
    .map((i) => regionContrasts[i]);

  let centerVsEdgeDiff = 0;
  if (centerContrasts.length > 0 && edgeContrasts.length > 0) {
    const centerMean = centerContrasts.reduce((a, b) => a + b, 0) / centerContrasts.length;
    const edgeMean = edgeContrasts.reduce((a, b) => a + b, 0) / edgeContrasts.length;
    const avgMean = (centerMean + edgeMean) / 2;
    centerVsEdgeDiff = avgMean > 0 ? Math.abs(centerMean - edgeMean) / avgMean : 0;
  }

  let score = 0;

  // High center-vs-edge contrast difference = possible face swap
  if (centerVsEdgeDiff > 0.5) score += 0.4;
  else if (centerVsEdgeDiff > 0.3) score += 0.2;

  // Very high overall contrast variation suggests inconsistent processing
  if (contrastCov > 0.4) score += 0.3;
  else if (contrastCov > 0.25) score += 0.15;

  score = Math.min(score, 1);

  const detail =
    score > 0.4
      ? `Local contrast is inconsistent across image regions (center-edge diff=${(centerVsEdgeDiff * 100).toFixed(0)}%) — possible face-swap boundary`
      : `Local contrast distribution is consistent (variation=${contrastCov.toFixed(2)})`;

  return { score, detail };
}

// ── main analyser ──────────────────────────────────────────────────

import { analyzeFace, type FaceAnalysisResult } from "./faceAnalyzer";

/**
 * Pixel-level weights (these sum to ~0.60 — face analysis adds ~0.40)
 */
const PIXEL_WEIGHTS: Record<string, number> = {
  noise: 0.10,
  channel: 0.08,
  edge: 0.09,
  saturation: 0.06,
  metadata: 0.08,
  grid: 0.05,
  smoothness: 0.08,
  localContrast: 0.06,
};

/** Re-export helpers so Index.tsx can use them for temporal analysis */
export { loadImage, getPixelData };

export async function analyzeImage(
  file: File,
  prevFaceData?: Float32Array
): Promise<ImageAnalysisResult & { faceRegionData?: Float32Array }> {
  const img = await loadImage(file);
  const { data, width, height } = getPixelData(img);

  // ── Pixel-level tests ──
  const noise = analyzeNoiseUniformity(data, width, height);
  const channel = analyzeChannelCorrelation(data, width, height);
  const edge = analyzeEdgeConsistency(data, width, height);
  const saturation = analyzeSaturation(data, width, height);
  const metadata = await analyzeMetadata(file);
  const grid = analyzeGridArtifacts(data, width, height);
  const smoothness = analyzeSmoothnessTexture(data, width, height);
  const localContrast = analyzeLocalContrastVariance(data, width, height);

  // ── Face-focused analysis ──
  const faceResult: FaceAnalysisResult = analyzeFace(data, width, height, prevFaceData);

  // ── Combine scores ──
  const scores: Record<string, number> = {
    noise: noise.score,
    channel: channel.score,
    edge: edge.score,
    saturation: saturation.score,
    metadata: metadata.score,
    grid: grid.score,
    smoothness: smoothness.score,
    localContrast: localContrast.score,
    // Face-level scores
    ...Object.fromEntries(
      Object.entries(faceResult.scores).map(([k, v]) => [`face_${k}`, v])
    ),
  };

  // Weighted composite: pixel tests (60%) + face tests (40%)
  let pixelComposite = 0;
  for (const key of Object.keys(PIXEL_WEIGHTS)) {
    pixelComposite += PIXEL_WEIGHTS[key] * scores[key];
  }

  // Face composite (already calculated as isFake/confidence in faceResult)
  // Map face confidence to a 0-1 composite score:
  //   face fake → high composite, face authentic → low composite
  const faceComposite = faceResult.isFake
    ? 0.5 + ((faceResult.confidence - 72) / 27) * 0.5  // 0.5–1.0
    : 0.5 - ((faceResult.confidence - 72) / 27) * 0.5; // 0.0–0.5

  const composite = pixelComposite + 0.40 * faceComposite;

  const isFake = composite > 0.38;

  const rawConfidence = Math.abs(composite - 0.38) / 0.62;
  const confidence = Math.round((70 + rawConfidence * 29) * 10) / 10;

  // Collect reasons from pixel tests + face tests
  const reasons: string[] = [];
  const pixelTests = [
    { name: "noise", result: noise },
    { name: "channel", result: channel },
    { name: "edge", result: edge },
    { name: "saturation", result: saturation },
    { name: "metadata", result: metadata },
    { name: "grid", result: grid },
    { name: "smoothness", result: smoothness },
    { name: "localContrast", result: localContrast },
  ];

  for (const t of pixelTests) {
    if (t.result.score > 0.4) {
      reasons.push(t.result.detail);
    }
  }

  // Add face-specific reasons
  for (const reason of faceResult.reasons) {
    reasons.push(reason);
  }

  return {
    isFake,
    confidence,
    reasons: reasons.slice(0, 8),
    scores,
    faceRegionData: faceResult.faceRegionData,
  };
}


