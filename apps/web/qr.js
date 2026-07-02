// QR helpers: generation (vendored qrcode-generator) and scanning
// (BarcodeDetector where available, vendored jsQR fallback).
import qrcode from './vendor/qrcode.js';
import jsQR from './vendor/jsqr.js';

// Render `text` as a QR code and return a PNG data URL. ECC level M per the
// UI spec (§5 "QR specifics"); type 0 auto-sizes to the payload.
export function qrDataUrl(text, size = 320) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4; // modules of quiet zone
  const scale = Math.max(2, Math.floor(size / (n + quiet * 2)));
  const px = (n + quiet * 2) * scale;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
  }
  return canvas.toDataURL('image/png');
}

// Decode a QR from raw ImageData. Returns the decoded string or null.
export function decodeImageData(imageData) {
  const res = jsQR(imageData.data, imageData.width, imageData.height);
  return res ? res.data : null;
}

// Start the camera and scan continuously. Calls onResult(text) once on the
// first successful decode, then stops. Returns an async stop() function.
// Prefers the native BarcodeDetector (fast, Android/Chrome); falls back to
// jsQR over canvas frames (works everywhere getUserMedia does, incl. iOS).
export async function startScanner(videoEl, onResult) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false,
  });
  videoEl.srcObject = stream;
  videoEl.setAttribute('playsinline', 'true'); // iOS: no fullscreen takeover
  await videoEl.play();

  let stopped = false;
  const stop = () => {
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
  };

  let detector = null;
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      }
    } catch { /* fall through to jsQR */ }
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  async function tick() {
    if (stopped) return;
    if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
      try {
        let text = null;
        if (detector) {
          const codes = await detector.detect(videoEl);
          if (codes.length > 0) text = codes[0].rawValue;
        } else {
          // Downscale for decode speed; jsQR handles ~640px well.
          const w = Math.min(640, videoEl.videoWidth);
          const h = Math.round(videoEl.videoHeight * (w / videoEl.videoWidth));
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(videoEl, 0, 0, w, h);
          text = decodeImageData(ctx.getImageData(0, 0, w, h));
        }
        if (text) {
          stop();
          onResult(text);
          return;
        }
      } catch { /* keep scanning */ }
    }
    setTimeout(tick, detector ? 120 : 220);
  }
  tick();
  return stop;
}
