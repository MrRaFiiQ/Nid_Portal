const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Jimp } = require('jimp');
const { readBarcodesFromImageData, prepareZXingModule } = require('zxing-wasm');

async function extractBarcodeFromPdf(pdfPath) {
  // Read and parse PDF to extract the Form XObject containing the barcode
  const pdfBuf = fs.readFileSync(pdfPath);
  const txt = pdfBuf.toString('latin1');

  // Find Fm1 Form XObject (object 8)
  function getObject(num) {
    const start = txt.indexOf('\n' + num + ' 0 obj');
    if (start < 0) return null;
    const streamStart = txt.indexOf('stream\n', start);
    const streamEnd = txt.indexOf('endstream', streamStart);
    if (streamStart < 0 || streamEnd < 0) return null;
    const rawStart = streamStart + 7;
    const rawEnd = streamEnd - 1;
    const raw = pdfBuf.slice(rawStart, rawEnd);
    const filterMatch = txt.substring(start, streamStart).match(/\/Filter\s*\/FlateDecode/);
    if (filterMatch) {
      try { return zlib.inflateSync(raw).toString('latin1'); }
      catch(e) { return null; }
    }
    return raw.toString('latin1');
  }

  const fm1 = getObject(8);
  if (!fm1) throw new Error('Fm1 Form XObject not found in PDF');

  // Parse rectangle commands to reconstruct binary bitmap
  const rectRe = /(\d+)\s+(\d+)\s+1\s+1\s+re/g;
  const pixelSet = new Set();
  let maxX = 0, maxY = 0;
  let match;
  while ((match = rectRe.exec(fm1)) !== null) {
    const x = parseInt(match[1]);
    const y = parseInt(match[2]);
    pixelSet.add(x + ',' + y);
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  const w = maxX + 1;
  const h = maxY + 1;
  console.log('Reconstructed barcode bitmap: ' + w + 'x' + h + ' pixels');

  // Render as 1x PNG
  const img = new Jimp({ width: w, height: h, color: 0xffffffff });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pixelSet.has(x + ',' + y)) {
        img.setPixelColor(0x000000ff, x, y);
      }
    }
  }
  const pngPath = path.join(path.dirname(pdfPath), 'barcode.png');
  await img.write(pngPath);

  // Decode PDF417 barcode
  await prepareZXingModule();
  const rgba = new Uint8Array(img.bitmap.data);
  const results = await readBarcodesFromImageData(
    { data: rgba, width: img.bitmap.width, height: img.bitmap.height },
    { tryHarder: true, formats: ['PDF417'] }
  );

  await img.decoder?.();

  if (results.length === 0 || !results[0].isValid) {
    throw new Error('PDF417 barcode could not be decoded');
  }

  const decodedText = results[0].text;

  // Save to TXT file
  const txtPath = path.join(path.dirname(pdfPath), path.basename(pdfPath, '.pdf') + '-barcode.txt');
  fs.writeFileSync(txtPath, decodedText + '\n');
  console.log('Decoded text saved to: ' + txtPath);

  return { text: decodedText, image: pngPath, textFile: txtPath };
}

if (require.main === module) {
  const pdfPath = process.argv[2];
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    console.error('Usage: node extract-barcode.js <pdf-file>');
    process.exit(1);
  }

  extractBarcodeFromPdf(pdfPath).then(result => {
    console.log('\nDecoded barcode text:');
    console.log(result.text);
    console.log('\nDone.');
    process.exit(0);
  }).catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

module.exports = { extractBarcodeFromPdf };
