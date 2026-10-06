// "Present a photo or document" — the phone's stand-in for screen sharing.
//
// Phone browsers can't capture the screen (no getDisplayMedia), but they can
// stream a <canvas> (canvas.captureStream). So we draw the chosen photo or PDF
// page onto a hidden canvas and hand its stream to the call as if it were a
// screen share: every viewer — phone or laptop — shows it full screen.
//
//   const deck = await loadDeck(files);      // photos, or one PDF
//   const painter = startPainter();          // the canvas + its stream
//   painter.show(await deck.page(0));        // draw a page
//   presentStream(painter.stream);           // goes out like a screen share
//   painter.stop();                          // when done

// Longest side of a page on the canvas. Big enough to read a document on a
// laptop, small enough to encode smoothly from a phone.
const MAX_SIDE = 1600;

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

// Shrink anything drawable to fit MAX_SIDE, onto its own canvas.
function fitToCanvas(src, w, h, background) {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w * scale));
  c.height = Math.max(2, Math.round(h * scale));
  const g = c.getContext('2d');
  if (background) {
    g.fillStyle = background;
    g.fillRect(0, 0, c.width, c.height);
  }
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function decodeImage(file) {
  // createImageBitmap applies the photo's EXIF rotation; older Safari falls
  // back to an <img>.
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      const c = fitToCanvas(bmp, bmp.width, bmp.height);
      bmp.close?.();
      return c;
    } catch {
      // fall through
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    return fitToCanvas(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadPdf(file) {
  // pdf.js is big — only fetched the first time someone presents a PDF.
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;

  // Render pages on demand, keeping a few recent ones so flipping back is instant.
  const cache = new Map();
  async function page(i) {
    if (cache.has(i)) return cache.get(i);
    const p = await doc.getPage(i + 1);
    const base = p.getViewport({ scale: 1 });
    const viewport = p.getViewport({ scale: MAX_SIDE / Math.max(base.width, base.height) });
    const c = document.createElement('canvas');
    c.width = Math.round(viewport.width);
    c.height = Math.round(viewport.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; // PDFs assume white paper
    g.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: g, viewport }).promise;
    cache.set(i, c);
    if (cache.size > 6) cache.delete(cache.keys().next().value);
    return c;
  }
  return { count: doc.numPages, page, close: () => doc.destroy() };
}

/**
 * Turn the picked files into a deck of pages: one PDF, or one or more photos.
 * @returns {Promise<{ count: number, page: (i: number) => Promise<HTMLCanvasElement>, close: Function }>}
 */
export async function loadDeck(files) {
  const list = [...files];
  const pdf = list.find(isPdf);
  if (pdf) return loadPdf(pdf);
  const images = list.filter((f) => f.type.startsWith('image/'));
  if (!images.length) throw new Error('Pick photos or a PDF.');
  const pages = await Promise.all(images.map(decodeImage));
  return { count: pages.length, page: async (i) => pages[i], close: () => {} };
}

/**
 * The hidden canvas everything is drawn onto, and its live video stream.
 * It repaints a few times a second even when the page doesn't change, so
 * someone who joins mid-presentation still gets a picture straight away.
 */
export function startPainter() {
  const canvas = document.createElement('canvas');
  canvas.className = 'present-canvas';
  canvas.width = 1280;
  canvas.height = 720;
  // In the page (invisibly) — some mobile browsers only stream an attached canvas.
  document.body.appendChild(canvas);
  const g = canvas.getContext('2d');
  let current = null;

  function paint() {
    g.fillStyle = '#000';
    g.fillRect(0, 0, canvas.width, canvas.height);
    if (current) g.drawImage(current, 0, 0, canvas.width, canvas.height);
  }

  function show(page) {
    current = page;
    // Match the page's shape so nothing is squashed; even sizes keep video
    // encoders happy.
    const w = page.width - (page.width % 2);
    const h = page.height - (page.height % 2);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    paint();
  }

  paint();
  const timer = setInterval(paint, 150);
  const stream = canvas.captureStream(10);

  function stop() {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    canvas.remove();
  }

  return { stream, show, stop };
}
