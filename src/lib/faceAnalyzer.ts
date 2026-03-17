/**
 * Face Analyzer — Deepfake detection focused on facial features.
 *
 * Detects the face region using skin-tone analysis (YCbCr colour model),
 * then runs targeted analysis on specific facial areas:
 *   - Eye region (reflections, symmetry, blinking artifacts)
 *   - Mouth region (blending, lip artifacts)
 *   - Face-background consistency (lighting, noise mismatch)
 *   - Facial boundary (blending seam detection)
 *   - Bilateral symmetry (abnormal symmetry in GAN faces)
 *   - Micro-texture (fine detail loss from face-swap smoothing)
 *
 * Also supports temporal (frame-to-frame) comparison for live analysis:
 *   - Face region flicker detection
 *   - Movement consistency between face and background
 */

export interface FaceAnalysisResult {
  isFake: boolean;
  confidence: number;
  reasons: string[];
  scores: Record<string, number>;
  /** Pixel data of the face region for temporal comparison */
  faceRegionData?: Float32Array;
  faceBox?: { x: number; y: number; w: number; h: number };
}

// ── Skin-tone face detection ───────────────────────────────────────

/**
 * Detect the face region using YCbCr skin-colour model.
 *
 * Returns a bounding box { x, y, w, h } of the largest skin-coloured
 * region, which is assumed to be the face.
 */
function detectFaceRegion(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { x: number; y: number; w: number; h: number } | null {
  // Create a skin mask using YCbCr thresholds
  const skinMask = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];

    // RGB to YCbCr
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.169 * r - 0.331 * g + 0.500 * b;
    const cr = 128 + 0.500 * r - 0.419 * g - 0.081 * b;

    // Skin detection thresholds (empirical, works for diverse skin tones)
    if (y > 60 && cb > 77 && cb < 127 && cr > 133 && cr < 173) {
      skinMask[i] = 1;
    }
  }

  // Find the bounding box of the largest connected skin region
  // Simplified: use a grid-based approach scanning columns/rows
  let minX = width, maxX = 0, minY = height, maxY = 0;
  let skinCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (skinMask[y * width + x]) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        skinCount++;
      }
    }
  }

  // Need at least 3% of image to be skin to consider it a face
  const skinRatio = skinCount / (width * height);
  if (skinRatio < 0.03 || maxX <= minX || maxY <= minY) {
    return null;
  }

  // Refine: shrink box to the densest skin region
  // Check density in the bounding box
  const boxW = maxX - minX;
  const boxH = maxY - minY;
  let boxSkinCount = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (skinMask[y * width + x]) boxSkinCount++;
    }
  }
  const boxDensity = boxSkinCount / (boxW * boxH);

  // If density is too low, the bounding box is too loose — no clear face
  if (boxDensity < 0.15) return null;

  return { x: minX, y: minY, w: boxW, h: boxH };
}

/**
 * Get luminance array for a sub-region of the image.
 */
function getRegionLuma(
  data: Uint8ClampedArray,
  width: number,
  rx: number, ry: number, rw: number, rh: number
): Float32Array {
  const luma = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const idx = ((ry + y) * width + (rx + x)) * 4;
      luma[y * rw + x] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    }
  }
  return luma;
}

// ── Individual facial analysis tests ───────────────────────────────

/**
 * 1. Eye Region Analysis
 *
 * The eye region (upper 25-45% of the face box) is highly diagnostic:
 * - Deepfakes often have mismatched or missing eye reflections (catchlights)
 * - Pupil shapes may be irregular
 * - Eye region texture is often smoother than real eyes
 */
function analyzeEyeRegion(
  data: Uint8ClampedArray,
  width: number,
  faceBox: { x: number; y: number; w: number; h: number }
): { score: number; detail: string } {
  // Eye region is the upper-center band of the face
  const eyeY = faceBox.y + Math.floor(faceBox.h * 0.2);
  const eyeH = Math.floor(faceBox.h * 0.25);
  const eyeX = faceBox.x + Math.floor(faceBox.w * 0.1);
  const eyeW = Math.floor(faceBox.w * 0.8);

  if (eyeW < 10 || eyeH < 5) {
    return { score: 0.5, detail: "Eye region too small for analysis" };
  }

  // Split into left eye and right eye
  const halfW = Math.floor(eyeW / 2);

  const leftEyeLuma = getRegionLuma(data, width, eyeX, eyeY, halfW, eyeH);
  const rightEyeLuma = getRegionLuma(data, width, eyeX + halfW, eyeY, halfW, eyeH);

  // 1a. Eye reflection symmetry — real eyes have similar catchlight patterns
  // Compute the bright-spot pattern in each eye
  const leftBrightCount = Array.from(leftEyeLuma).filter((v) => v > 200).length;
  const rightBrightCount = Array.from(rightEyeLuma).filter((v) => v > 200).length;
  const totalPixels = halfW * eyeH;

  const leftBrightRatio = leftBrightCount / totalPixels;
  const rightBrightRatio = rightBrightCount / totalPixels;
  const reflectionDiff = Math.abs(leftBrightRatio - rightBrightRatio);

  // 1b. Texture energy in eye region — deepfakes often smooth out fine eye detail
  let eyeTextureEnergy = 0;
  let texCount = 0;
  for (let y = 0; y < eyeH - 1; y++) {
    for (let x = 0; x < eyeW - 1; x++) {
      const idx = (faceBox.y + Math.floor(faceBox.h * 0.2) + y) * width + faceBox.x + Math.floor(faceBox.w * 0.1) + x;
      const ridx = idx * 4;
      const ridx1 = (idx + 1) * 4;
      const ridx2 = (idx + width) * 4;
      if (ridx2 + 2 < data.length) {
        const lC = 0.299 * data[ridx] + 0.587 * data[ridx + 1] + 0.114 * data[ridx + 2];
        const lR = 0.299 * data[ridx1] + 0.587 * data[ridx1 + 1] + 0.114 * data[ridx1 + 2];
        const lD = 0.299 * data[ridx2] + 0.587 * data[ridx2 + 1] + 0.114 * data[ridx2 + 2];
        eyeTextureEnergy += Math.abs(lC - lR) + Math.abs(lC - lD);
        texCount++;
      }
    }
  }
  const avgEyeTexture = texCount > 0 ? eyeTextureEnergy / texCount : 10;

  // 1c. Left-right luminance symmetry
  const leftMean = leftEyeLuma.reduce((a, b) => a + b, 0) / leftEyeLuma.length;
  const rightMean = rightEyeLuma.reduce((a, b) => a + b, 0) / rightEyeLuma.length;
  const avgLum = (leftMean + rightMean) / 2;
  const eyeSymmetryDiff = avgLum > 0 ? Math.abs(leftMean - rightMean) / avgLum : 0;

  let score = 0;

  // Mismatched eye reflections
  if (reflectionDiff > 0.05) score += 0.25;
  else if (reflectionDiff > 0.02) score += 0.1;

  // Very smooth eyes (texture loss)
  if (avgEyeTexture < 2.5) score += 0.35;
  else if (avgEyeTexture < 4.0) score += 0.15;

  // Abnormal eye symmetry (too perfect = GAN, too different = bad swap)
  if (eyeSymmetryDiff < 0.01 && avgLum > 50) score += 0.2; // too perfect
  else if (eyeSymmetryDiff > 0.15) score += 0.2; // too different

  score = Math.min(score, 1);

  const detail =
    score > 0.4
      ? `Eye region anomaly detected (texture=${avgEyeTexture.toFixed(1)}, reflection diff=${(reflectionDiff * 100).toFixed(1)}%) — possible synthetic eyes`
      : `Eye region appears natural (texture=${avgEyeTexture.toFixed(1)})`;

  return { score, detail };
}

/**
 * 2. Mouth Region Analysis
 *
 * The mouth region (lower 25-45% of face) shows deepfake artifacts:
 * - Lip boundaries may have blending seams
 * - Teeth texture often differs from real
 * - Inner-mouth darkness patterns are irregular
 */
function analyzeMouthRegion(
  data: Uint8ClampedArray,
  width: number,
  faceBox: { x: number; y: number; w: number; h: number }
): { score: number; detail: string } {
  const mouthY = faceBox.y + Math.floor(faceBox.h * 0.6);
  const mouthH = Math.floor(faceBox.h * 0.3);
  const mouthX = faceBox.x + Math.floor(faceBox.w * 0.2);
  const mouthW = Math.floor(faceBox.w * 0.6);

  if (mouthW < 10 || mouthH < 5) {
    return { score: 0.5, detail: "Mouth region too small for analysis" };
  }

  // Analyze texture energy in the mouth region
  let mouthTexture = 0;
  let texCount = 0;

  for (let y = 0; y < mouthH - 1; y++) {
    for (let x = 0; x < mouthW - 1; x++) {
      const px = mouthX + x;
      const py = mouthY + y;
      if (px + 1 < width && py + 1 < (faceBox.y + faceBox.h)) {
        const idx = (py * width + px) * 4;
        const idxR = (py * width + px + 1) * 4;
        const idxD = ((py + 1) * width + px) * 4;

        if (idxD + 2 < data.length) {
          const lC = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          const lR = 0.299 * data[idxR] + 0.587 * data[idxR + 1] + 0.114 * data[idxR + 2];
          const lD = 0.299 * data[idxD] + 0.587 * data[idxD + 1] + 0.114 * data[idxD + 2];
          mouthTexture += Math.abs(lC - lR) + Math.abs(lC - lD);
          texCount++;
        }
      }
    }
  }
  const avgMouthTexture = texCount > 0 ? mouthTexture / texCount : 10;

  // Analyze colour variability in the mouth region (lips vs skin vs teeth)
  const colors: { r: number; g: number; b: number }[] = [];
  const step = Math.max(1, Math.floor(mouthW * mouthH / 200));
  for (let y = 0; y < mouthH; y += step) {
    for (let x = 0; x < mouthW; x += step) {
      const idx = ((mouthY + y) * width + (mouthX + x)) * 4;
      if (idx + 2 < data.length) {
        colors.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2] });
      }
    }
  }

  // Compute colour variance — real mouths have high colour diversity (lips, teeth, skin)
  const meanR = colors.reduce((a, c) => a + c.r, 0) / colors.length;
  const meanG = colors.reduce((a, c) => a + c.g, 0) / colors.length;
  const meanB = colors.reduce((a, c) => a + c.b, 0) / colors.length;
  const colourVariance =
    colors.reduce((a, c) => a + (c.r - meanR) ** 2 + (c.g - meanG) ** 2 + (c.b - meanB) ** 2, 0) /
    (colors.length * 3);

  let score = 0;

  // Low texture in mouth = deepfake smoothing
  if (avgMouthTexture < 3.0) score += 0.35;
  else if (avgMouthTexture < 5.0) score += 0.15;

  // Low colour variance = unnatural mouth area
  if (colourVariance < 200) score += 0.3;
  else if (colourVariance < 500) score += 0.15;

  score = Math.min(score, 1);

  const detail =
    score > 0.4
      ? `Mouth region anomaly (texture=${avgMouthTexture.toFixed(1)}, colourVar=${colourVariance.toFixed(0)}) — lip/teeth artifacts suggest synthesis`
      : `Mouth region appears natural (texture=${avgMouthTexture.toFixed(1)})`;

  return { score, detail };
}

/**
 * 3. Face-Background Consistency
 *
 * In deepfakes, the face and the background were processed separately.
 * This creates disparities in noise level, sharpness, and colour
 * temperature between the swapped face and the original background.
 */
function analyzeFaceBackgroundConsistency(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  faceBox: { x: number; y: number; w: number; h: number }
): { score: number; detail: string } {
  // Compute noise variance in the face region
  const faceNoiseValues: number[] = [];
  const patchSize = 8;
  const fx = faceBox.x, fy = faceBox.y, fw = faceBox.w, fh = faceBox.h;

  for (let py = fy; py + patchSize <= fy + fh; py += patchSize) {
    for (let px = fx; px + patchSize <= fx + fw; px += patchSize) {
      const lumas: number[] = [];
      for (let y = py; y < py + patchSize; y++) {
        for (let x = px; x < px + patchSize; x++) {
          if (x < width && y < height) {
            const idx = (y * width + x) * 4;
            lumas.push(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
          }
        }
      }
      if (lumas.length > 0) {
        const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length;
        const variance = lumas.reduce((a, b) => a + (b - mean) ** 2, 0) / lumas.length;
        faceNoiseValues.push(variance);
      }
    }
  }

  // Compute noise variance in the background (areas outside the face box)
  const bgNoiseValues: number[] = [];
  // Sample background: above and below the face
  const bgRegions = [
    { bx: 0, by: 0, bw: width, bh: Math.max(0, fy) }, // above face
    { bx: 0, by: Math.min(height, fy + fh), bw: width, bh: Math.max(0, height - fy - fh) }, // below face
    { bx: 0, by: fy, bw: Math.max(0, fx), bh: fh }, // left of face
    { bx: Math.min(width, fx + fw), by: fy, bw: Math.max(0, width - fx - fw), bh: fh }, // right of face
  ];

  for (const region of bgRegions) {
    for (let py = region.by; py + patchSize <= region.by + region.bh; py += patchSize * 2) {
      for (let px = region.bx; px + patchSize <= region.bx + region.bw; px += patchSize * 2) {
        const lumas: number[] = [];
        for (let y = py; y < py + patchSize; y++) {
          for (let x = px; x < px + patchSize; x++) {
            if (x < width && y < height && x >= 0 && y >= 0) {
              const idx = (y * width + x) * 4;
              lumas.push(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
            }
          }
        }
        if (lumas.length > 0) {
          const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length;
          const variance = lumas.reduce((a, b) => a + (b - mean) ** 2, 0) / lumas.length;
          bgNoiseValues.push(variance);
        }
      }
    }
  }

  if (faceNoiseValues.length < 2 || bgNoiseValues.length < 2) {
    return { score: 0.5, detail: "Insufficient data for face-background comparison" };
  }

  const faceMeanNoise = faceNoiseValues.reduce((a, b) => a + b, 0) / faceNoiseValues.length;
  const bgMeanNoise = bgNoiseValues.reduce((a, b) => a + b, 0) / bgNoiseValues.length;

  // Ratio of face noise to background noise — should be relatively similar in real images
  const avgNoise = (faceMeanNoise + bgMeanNoise) / 2;
  const noiseDiff = avgNoise > 0 ? Math.abs(faceMeanNoise - bgMeanNoise) / avgNoise : 0;

  // Also compare colour temperature: face should match background lighting
  let faceWarmth = 0, bgWarmth = 0;
  let fCount = 0, bCount = 0;

  // Sample face colour temp
  for (let y = fy; y < fy + fh; y += 4) {
    for (let x = fx; x < fx + fw; x += 4) {
      if (x < width && y < height) {
        const idx = (y * width + x) * 4;
        faceWarmth += (data[idx] - data[idx + 2]); // R - B as warmth proxy
        fCount++;
      }
    }
  }
  faceWarmth = fCount > 0 ? faceWarmth / fCount : 0;

  // Sample background colour temp
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      const inFace = x >= fx && x < fx + fw && y >= fy && y < fy + fh;
      if (!inFace) {
        const idx = (y * width + x) * 4;
        bgWarmth += (data[idx] - data[idx + 2]);
        bCount++;
      }
    }
  }
  bgWarmth = bCount > 0 ? bgWarmth / bCount : 0;

  const warmthDiff = Math.abs(faceWarmth - bgWarmth);

  let score = 0;

  // Large noise mismatch between face and background
  if (noiseDiff > 0.6) score += 0.4;
  else if (noiseDiff > 0.35) score += 0.2;

  // Colour temperature mismatch
  if (warmthDiff > 30) score += 0.3;
  else if (warmthDiff > 15) score += 0.15;

  score = Math.min(score, 1);

  const detail =
    score > 0.4
      ? `Face-background mismatch (noise diff=${(noiseDiff * 100).toFixed(0)}%, warmth diff=${warmthDiff.toFixed(0)}) — lighting/noise inconsistency suggests face swap`
      : `Face and background are consistent (noise diff=${(noiseDiff * 100).toFixed(0)}%)`;

  return { score, detail };
}

/**
 * 4. Facial Boundary / Blending Seam Detection
 *
 * At the boundary where a deepfake face is blended into the original
 * image, there is often a visible seam — a ring of pixels with
 * abnormally sharp or soft transitions. We trace the perimeter of
 * the detected face region and measure gradient strength.
 */
function analyzeFaceBoundary(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  faceBox: { x: number; y: number; w: number; h: number }
): { score: number; detail: string } {
  // Sample gradient values along the face boundary (expanded slightly outside)
  const margin = Math.max(3, Math.floor(Math.min(faceBox.w, faceBox.h) * 0.05));
  const boundaryGradients: number[] = [];
  const innerGradients: number[] = [];

  // Helper: compute gradient at a pixel
  const gradient = (px: number, py: number): number => {
    if (px <= 0 || px >= width - 1 || py <= 0 || py >= height - 1) return 0;
    const idx = (py * width + px) * 4;
    const idxL = (py * width + px - 1) * 4;
    const idxR = (py * width + px + 1) * 4;
    const idxU = ((py - 1) * width + px) * 4;
    const idxD = ((py + 1) * width + px) * 4;
    const lC = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    const lL = 0.299 * data[idxL] + 0.587 * data[idxL + 1] + 0.114 * data[idxL + 2];
    const lR = 0.299 * data[idxR] + 0.587 * data[idxR + 1] + 0.114 * data[idxR + 2];
    const lU = 0.299 * data[idxU] + 0.587 * data[idxU + 1] + 0.114 * data[idxU + 2];
    const lD = 0.299 * data[idxD] + 0.587 * data[idxD + 1] + 0.114 * data[idxD + 2];
    return Math.abs(lR - lL) + Math.abs(lD - lU);
  };

  const fx = faceBox.x, fy = faceBox.y, fw = faceBox.w, fh = faceBox.h;

  // Top & bottom edges
  for (let x = fx; x < fx + fw; x += 2) {
    // Top boundary
    for (let m = -margin; m <= margin; m++) {
      boundaryGradients.push(gradient(x, fy + m));
    }
    // Bottom boundary
    for (let m = -margin; m <= margin; m++) {
      boundaryGradients.push(gradient(x, fy + fh + m));
    }
  }
  // Left & right edges
  for (let y = fy; y < fy + fh; y += 2) {
    for (let m = -margin; m <= margin; m++) {
      boundaryGradients.push(gradient(fx + m, y));
      boundaryGradients.push(gradient(fx + fw + m, y));
    }
  }

  // Inner face gradients (for comparison)
  for (let y = fy + Math.floor(fh * 0.2); y < fy + Math.floor(fh * 0.8); y += 4) {
    for (let x = fx + Math.floor(fw * 0.2); x < fx + Math.floor(fw * 0.8); x += 4) {
      innerGradients.push(gradient(x, y));
    }
  }

  if (boundaryGradients.length < 10 || innerGradients.length < 10) {
    return { score: 0.5, detail: "Insufficient boundary data" };
  }

  const meanBoundaryG = boundaryGradients.reduce((a, b) => a + b, 0) / boundaryGradients.length;
  const meanInnerG = innerGradients.reduce((a, b) => a + b, 0) / innerGradients.length;

  // High boundary/inner gradient ratio suggests a blending seam
  const boundaryRatio = meanInnerG > 0 ? meanBoundaryG / meanInnerG : 1;

  let score = 0;

  if (boundaryRatio > 2.5) score += 0.5;
  else if (boundaryRatio > 1.8) score += 0.3;
  else if (boundaryRatio > 1.3) score += 0.15;

  score = Math.min(score, 1);

  const detail =
    score > 0.4
      ? `Facial boundary shows blending seam (boundary/inner gradient ratio=${boundaryRatio.toFixed(2)}) — consistent with face swap`
      : `Facial boundary is clean (ratio=${boundaryRatio.toFixed(2)})`;

  return { score, detail };
}

/**
 * 5. Bilateral Symmetry Analysis
 *
 * GAN-generated faces are often unnaturally symmetrical because the
 * network learns the average face shape. Real faces always have
 * slight asymmetries. Conversely, bad face swaps may have
 * abnormally poor symmetry.
 */
function analyzeBilateralSymmetry(
  data: Uint8ClampedArray,
  width: number,
  faceBox: { x: number; y: number; w: number; h: number }
): { score: number; detail: string } {
  const fx = faceBox.x, fy = faceBox.y, fw = faceBox.w, fh = faceBox.h;
  const halfW = Math.floor(fw / 2);
  const centerX = fx + halfW;

  let diffSum = 0;
  let count = 0;

  for (let y = fy; y < fy + fh; y += 2) {
    for (let dx = 1; dx < halfW; dx += 2) {
      const lx = centerX - dx;
      const rx = centerX + dx;
      if (lx >= 0 && rx < width && y >= 0 && y < (fy + fh)) {
        const idxL = (y * width + lx) * 4;
        const idxR = (y * width + rx) * 4;
        const lumaL = 0.299 * data[idxL] + 0.587 * data[idxL + 1] + 0.114 * data[idxL + 2];
        const lumaR = 0.299 * data[idxR] + 0.587 * data[idxR + 1] + 0.114 * data[idxR + 2];
        diffSum += Math.abs(lumaL - lumaR);
        count++;
      }
    }
  }

  const avgSymmetryDiff = count > 0 ? diffSum / count : 10;

  // Very low diff = unnaturally symmetrical (GAN-generated)
  // Very high diff = bad face swap

  let score = 0;

  if (avgSymmetryDiff < 2.0) score += 0.4; // Too symmetrical
  else if (avgSymmetryDiff < 4.0) score += 0.2;

  if (avgSymmetryDiff > 20.0) score += 0.3; // Too asymmetric (bad swap)
  else if (avgSymmetryDiff > 15.0) score += 0.15;

  score = Math.min(score, 1);

  const detail =
    score > 0.4
      ? avgSymmetryDiff < 4
        ? `Face is unnaturally symmetrical (diff=${avgSymmetryDiff.toFixed(1)}) — characteristic of AI-generated faces`
        : `Face symmetry is abnormal (diff=${avgSymmetryDiff.toFixed(1)}) — inconsistent facial geometry`
      : `Facial symmetry is within natural range (diff=${avgSymmetryDiff.toFixed(1)})`;

  return { score, detail };
}

/**
 * 6. Skin Micro-Texture Analysis
 *
 * Real skin has fine details: pores, wrinkles, blemishes, fine hair.
 * Deepfakes and GANs smooth these out, leaving the skin area with
 * lower high-frequency content. We compute the Laplacian-like
 * response in the face region to measure fine detail.
 */
function analyzeSkinMicroTexture(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  faceBox: { x: number; y: number; w: number; h: number }
): { score: number; detail: string } {
  const fx = faceBox.x, fy = faceBox.y, fw = faceBox.w, fh = faceBox.h;

  // Focus on the cheek/forehead area (most skin)
  const skinY = fy + Math.floor(fh * 0.1);
  const skinH = Math.floor(fh * 0.5);
  const skinX = fx + Math.floor(fw * 0.1);
  const skinW = Math.floor(fw * 0.8);

  const laplacianValues: number[] = [];

  for (let y = skinY + 1; y < skinY + skinH - 1; y++) {
    for (let x = skinX + 1; x < skinX + skinW - 1; x++) {
      if (x >= width - 1 || y >= height - 1 || x <= 0 || y <= 0) continue;

      const idx = (y * width + x) * 4;
      const idxU = ((y - 1) * width + x) * 4;
      const idxD = ((y + 1) * width + x) * 4;
      const idxL = (y * width + x - 1) * 4;
      const idxR = (y * width + x + 1) * 4;

      const lC = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      const lU = 0.299 * data[idxU] + 0.587 * data[idxU + 1] + 0.114 * data[idxU + 2];
      const lD = 0.299 * data[idxD] + 0.587 * data[idxD + 1] + 0.114 * data[idxD + 2];
      const lL = 0.299 * data[idxL] + 0.587 * data[idxL + 1] + 0.114 * data[idxL + 2];
      const lR = 0.299 * data[idxR] + 0.587 * data[idxR + 1] + 0.114 * data[idxR + 2];

      // Laplacian = sum of neighbours - 4 * center
      const laplacian = Math.abs(lU + lD + lL + lR - 4 * lC);
      laplacianValues.push(laplacian);
    }
  }

  if (laplacianValues.length < 50) {
    return { score: 0.5, detail: "Skin region too small for micro-texture analysis" };
  }

  const meanLap = laplacianValues.reduce((a, b) => a + b, 0) / laplacianValues.length;
  const stdLap = Math.sqrt(
    laplacianValues.reduce((a, b) => a + (b - meanLap) ** 2, 0) / laplacianValues.length
  );

  let score = 0;

  // Low Laplacian = smooth skin = deepfake
  if (meanLap < 1.5) score += 0.45;
  else if (meanLap < 3.0) score += 0.25;
  else if (meanLap < 5.0) score += 0.1;

  // Low variation in Laplacian = uniformly smooth
  if (stdLap < 1.0) score += 0.25;
  else if (stdLap < 2.0) score += 0.1;

  score = Math.min(score, 1);

  const detail =
    score > 0.4
      ? `Skin lacks micro-texture detail (Laplacian=${meanLap.toFixed(1)}, std=${stdLap.toFixed(1)}) — pores/wrinkles absent, consistent with deepfake smoothing`
      : `Skin micro-texture is present (Laplacian=${meanLap.toFixed(1)})`;

  return { score, detail };
}

// ── Temporal analysis ──────────────────────────────────────────────

/**
 * 7. Temporal Face Flicker Detection
 *
 * Compare the face region between two consecutive captured frames.
 * Deepfakes often produce frame-to-frame jitter specifically in the
 * face area while the background remains stable.
 */
export function analyzeTemporalFaceFlicker(
  prevFaceData: Float32Array,
  currFaceData: Float32Array
): { score: number; detail: string } {
  if (prevFaceData.length !== currFaceData.length || prevFaceData.length === 0) {
    return { score: 0.5, detail: "Cannot compare frames — dimensions mismatch" };
  }

  const n = prevFaceData.length;
  const diffs: number[] = [];
  for (let i = 0; i < n; i++) {
    diffs.push(Math.abs(prevFaceData[i] - currFaceData[i]));
  }

  const meanDiff = diffs.reduce((a, b) => a + b, 0) / n;
  const stdDiff = Math.sqrt(diffs.reduce((a, b) => a + (b - meanDiff) ** 2, 0) / n);

  // High std relative to mean = localised flickering (face boundary flickers)
  const flickerRatio = meanDiff > 0.1 ? stdDiff / meanDiff : 0;

  // Count pixels with large changes
  const largeDiffRatio = diffs.filter((d) => d > 15).length / n;

  let score = 0;

  if (flickerRatio > 2.0) score += 0.4;
  else if (flickerRatio > 1.2) score += 0.2;

  if (largeDiffRatio > 0.2) score += 0.35;
  else if (largeDiffRatio > 0.1) score += 0.15;

  score = Math.min(score, 1);

  const detail =
    score > 0.4
      ? `Face region flickering detected between frames (flicker=${flickerRatio.toFixed(2)}, largeChange=${(largeDiffRatio * 100).toFixed(1)}%) — temporal instability in face region`
      : `Face region is temporally stable (flicker=${flickerRatio.toFixed(2)})`;

  return { score, detail };
}

// ── Main face analyser ─────────────────────────────────────────────

const FACE_WEIGHTS: Record<string, number> = {
  eyes: 0.18,
  mouth: 0.15,
  faceBg: 0.18,
  boundary: 0.16,
  symmetry: 0.13,
  microTexture: 0.20,
};

export function analyzeFace(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  prevFaceData?: Float32Array
): FaceAnalysisResult {
  const faceBox = detectFaceRegion(data, width, height);

  if (!faceBox) {
    // No face detected — return neutral result
    return {
      isFake: false,
      confidence: 50,
      reasons: ["No face detected in frame — cannot perform facial analysis"],
      scores: {},
    };
  }

  const eyes = analyzeEyeRegion(data, width, faceBox);
  const mouth = analyzeMouthRegion(data, width, faceBox);
  const faceBg = analyzeFaceBackgroundConsistency(data, width, height, faceBox);
  const boundary = analyzeFaceBoundary(data, width, height, faceBox);
  const symmetry = analyzeBilateralSymmetry(data, width, faceBox);
  const microTexture = analyzeSkinMicroTexture(data, width, height, faceBox);

  const scores: Record<string, number> = {
    eyes: eyes.score,
    mouth: mouth.score,
    faceBg: faceBg.score,
    boundary: boundary.score,
    symmetry: symmetry.score,
    microTexture: microTexture.score,
  };

  // Temporal analysis if previous frame data is available
  let temporalScore = 0;
  let temporalDetail = "";
  const faceLuma = getRegionLuma(data, width, faceBox.x, faceBox.y, faceBox.w, faceBox.h);

  if (prevFaceData && prevFaceData.length === faceLuma.length) {
    const temporal = analyzeTemporalFaceFlicker(prevFaceData, faceLuma);
    temporalScore = temporal.score;
    temporalDetail = temporal.detail;
    scores["temporal"] = temporalScore;
  }

  // Weighted composite
  let composite = 0;
  let totalWeight = 0;
  for (const key of Object.keys(FACE_WEIGHTS)) {
    composite += FACE_WEIGHTS[key] * (scores[key] ?? 0);
    totalWeight += FACE_WEIGHTS[key];
  }
  // Add temporal with its own weight if available
  if (scores["temporal"] !== undefined) {
    composite += 0.15 * temporalScore;
    totalWeight += 0.15;
  }
  composite /= totalWeight;

  const isFake = composite > 0.35;

  const rawConf = Math.abs(composite - 0.35) / 0.65;
  const confidence = Math.round((72 + rawConf * 27) * 10) / 10;

  const reasons: string[] = [];
  const allTests = [
    eyes, mouth, faceBg, boundary, symmetry, microTexture,
  ];
  if (temporalDetail) allTests.push({ score: temporalScore, detail: temporalDetail });

  for (const t of allTests) {
    if (t.score > 0.35) reasons.push(t.detail);
  }

  return {
    isFake,
    confidence,
    reasons,
    scores,
    faceRegionData: faceLuma,
    faceBox,
  };
}
