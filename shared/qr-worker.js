// Распознавание QR в фоновом потоке, чтобы видео с камеры не подтормаживало.
import { scanQR } from './qr-scan.js';

self.onmessage = (e) => {
  const { id, width, height, data } = e.data || {};
  let text = null;
  try {
    text = scanQR({ data, width, height }, { budgetMs: 300 });
  } catch {}
  self.postMessage({ id, text });
};
