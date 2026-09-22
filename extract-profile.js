const fs = require('fs');
const path = require('path');

function extractProfile(html, nid) {
  function extract(label) {
    const re = new RegExp(
      '<label[^>]*>' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</label>\\s*<span[^>]*>\\s*([\\s\\S]*?)\\s*</span>',
      'i'
    );
    const m = html.match(re);
    const val = m ? m[1].trim().replace(/<br\s*\/?>/gi, '\n') : '';
    return val === '--' ? '' : val;
  }

  function extractAll(labels) {
    const result = {};
    for (const [key, label] of Object.entries(labels)) {
      result[key] = extract(label);
    }
    return result;
  }

  function extractSecond(label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      '<label[^>]*>' + escaped + '</label>\\s*<span[^>]*>\\s*([\\s\\S]*?)\\s*</span>',
      'gi'
    );
    let match;
    let idx = 0;
    while ((match = re.exec(html)) !== null) {
      idx++;
      if (idx === 2) {
        const val = match[1].trim().replace(/<br\s*\/?>/gi, '\n');
        return val === '--' ? '' : val;
      }
    }
    return '';
  }

  const data = {
    personal: extractAll({
      nameBn: 'নাম (বাংলা)',
      nameEn: 'নাম (ইংরেজি)',
      gender: 'লিঙ্গ',
      bloodGroup: 'রক্তের গ্রুপ',
      birthRegNo: 'জন্ম নিবন্ধন নম্বর',
      dob: 'জন্ম তারিখ',
      placeOfBirth: 'জন্মস্থান',
    }),
    father: extractAll({
      nameBn: 'পিতার নাম (বাংলা)',
      nid: 'পিতার এনআইডি',
      deathYear: 'মৃত্যুর সন (প্রযোজ্য ক্ষেত্রে)',
    }),
    mother: extractAll({
      nameBn: 'মাতার নাম (বাংলা)',
      nid: 'মাতার এনআইডি',
      deathYear: 'মৃত্যুর সন (প্রযোজ্য ক্ষেত্রে)',
    }),
    spouse: extractAll({
      maritalStatus: 'বৈবাহিক অবস্থা',
      nameBn: 'স্বামী/স্ত্রীর নাম (বাংলা)',
      nid: 'স্বামী/স্ত্রীর এনআইডি',
      deathYear: 'মৃত্যুর সন (প্রযোজ্য ক্ষেত্রে)',
    }),
    other: extractAll({
      education: 'শিক্ষাগত যোগ্যতা (বাংলা)',
      occupation: 'পেশা',
      disability: 'অসমর্থতা',
      identificationMark: 'সনাক্তকরন চিহ্ন (বাংলা)',
      tin: 'টিন নম্বর',
      drivingLicense: 'ড্রাইভিং লাইসেন্স নম্বর',
      passport: 'পাসপোর্ট নম্বর',
      religion: 'ধর্ম',
      mobile: 'মোবাইল নম্বর',
    }),
    presentAddress: extractAll({
      division: 'বিভাগ',
      district: 'জেলা',
      upozila: 'উপজেলা',
      rmo: 'আর.এম.ও',
      cityCorp: 'সিটি কর্পোরেশন অথবা পৌরসভা',
      union: 'ইউনিয়ন',
      mouza: 'মৌজা/মহল্লা',
      wardNo: 'ইউনিয়নের ওয়ার্ড নম্বর',
      village: 'গ্রাম/রাস্তা',
      house: 'বাসা/হোল্ডিং নম্বর (বাংলা)',
      postOffice: 'পোস্ট অফিস (বাংলা)',
      postCode: 'পোস্ট কোড',
    }),
    permanentAddress: {},
    voterArea: '',
  };

  const permLabels = {
    division: 'বিভাগ',
    district: 'জেলা',
    upozila: 'উপজেলা',
    rmo: 'আর.এম.ও',
    cityCorp: 'সিটি কর্পোরেশন অথবা পৌরসভা',
    union: 'ইউনিয়ন',
    mouza: 'মৌজা/মহল্লা',
    wardNo: 'ইউনিয়নের ওয়ার্ড নম্বর',
    village: 'গ্রাম/রাস্তা',
    house: 'বাসা/হোল্ডিং নম্বর (বাংলা)',
    postOffice: 'পোস্ট অফিস (বাংলা)',
    postCode: 'পোস্ট কোড',
  };
  for (const [key, label] of Object.entries(permLabels)) {
    data.permanentAddress[key] = extractSecond(label);
  }

  const voterMatch = html.match(/<label>ভোটার এরিয়া<\/label>\s*<span[^>]*>\s*([\s\S]*?)\s*<\/span>/i);
  data.voterArea = voterMatch ? voterMatch[1].trim().replace(/<br\s*\/?>/gi, '\n') : '';
  if (data.voterArea === '--') data.voterArea = '';

  const photoMatch = html.match(/<img[^>]+src="([^"]+)"[^>]*>\s*<\/div>\s*<\/div>\s*<\/div>\s*<div class="twelve wide column">/);
  data.photoUrl = photoMatch ? photoMatch[1] : '';

  const userMatch = html.match(/<span class="fixed-font-family-english18">([^<]+)<\/span>/);
  data.username = userMatch ? userMatch[1].trim() : '';

  data.nid = nid;
  return data;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const nid = args[0] || '6913896509';
  const htmlFile = path.join(__dirname, 'downloads', nid + '-profile.html');
  if (!fs.existsSync(htmlFile)) {
    console.error('File not found: ' + htmlFile);
    console.error('Usage: node extract-profile.js [nid]');
    process.exit(1);
  }
  const html = fs.readFileSync(htmlFile, 'utf8');
  const data = extractProfile(html, nid);
  const outputPath = path.join(__dirname, 'downloads', nid + '-profile.json');
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf8');
  console.log('Profile JSON saved: ' + outputPath);
  console.log(JSON.stringify(data, null, 2));
}

module.exports = { extractProfile };
