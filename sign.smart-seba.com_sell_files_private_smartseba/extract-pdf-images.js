const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

async function extractPdfImages(pdfPath, outputDir) {
  const pdfBuf = fs.readFileSync(pdfPath);
  const parser = new PDFParse({ data: pdfBuf });
  const results = [];

  try {
    // 1. Render each page as PNG at 2x scale
    console.log('Rendering pages to PNG...');
    const screenshots = await parser.getScreenshot({ scale: 2.0, imageBuffer: true, imageDataUrl: false });
    for (const page of screenshots.pages) {
      const pNum = page.pageNumber;
      const name = `page-${pNum}.png`;
      const outPath = path.join(outputDir, name);
      fs.writeFileSync(outPath, page.data);
      console.log(`  Page ${pNum}: ${page.width}x${page.height} -> ${name} (${page.data.length} bytes)`);
      results.push({ type: 'page', page: pNum, path: outPath, width: page.width, height: page.height, bytes: page.data.length });
    }

    // 2. Extract embedded images
    console.log('Extracting embedded images...');
    const images = await parser.getImage({ imageThreshold: 0, imageBuffer: true, imageDataUrl: false });
    for (const page of images.pages) {
      if (!page.images || page.images.length === 0) continue;
      for (let i = 0; i < page.images.length; i++) {
        const img = page.images[i];
        const pNum = page.pageNumber;
        const name = `page-${pNum}-img-${i + 1}.png`;
        const outPath = path.join(outputDir, name);
        fs.writeFileSync(outPath, img.data);
        console.log(`  Page ${pNum}: embedded image ${i + 1} (${img.width}x${img.height}) -> ${name} (${img.data.length} bytes)`);
        results.push({ type: 'image', page: pNum, index: i + 1, path: outPath, width: img.width, height: img.height, bytes: img.data.length });
      }
    }
  } finally {
    await parser.destroy();
  }

  return results;
}

if (require.main === module) {
  const pdfPath = process.argv[2];
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    console.error('Usage: node extract-pdf-images.js <pdf-file>');
    process.exit(1);
  }
  const outDir = path.join(path.dirname(pdfPath), path.basename(pdfPath, '.pdf') + '_images');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  extractPdfImages(pdfPath, outDir).then(results => {
    console.log(`\nDone. Extracted ${results.length} items.`);
    const manifestPath = path.join(outDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(results, null, 2));
    console.log('Manifest: ' + manifestPath);
  }).catch(e => { console.error('Error:', e.message); process.exit(1); });
}

module.exports = { extractPdfImages };
