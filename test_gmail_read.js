const { ImapFlow } = require('imapflow');

const IMAP_USER = 'smartseba500@gmail.com';
const IMAP_PASS = 'hxrl nooc mzfh ';
const IMAP_FROM = 'nidw.gov.bd';

function extractOtpFromText(text) {
  if (!text) return null;
  const m6 = text.match(/\b(\d{6})\b/);
  if (m6) return m6[1];
  const m48 = text.match(/\b(\d{4,8})\b/);
  return m48 ? m48[1] : null;
}

(async () => {
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const search = { since, seen: false };
    if (IMAP_FROM) search.from = IMAP_FROM;
    const uids = await client.search(search);
    console.log('Unseen matches in last 6h: ' + uids.length + ' (uids: ' + uids.slice(-8) + ')');
    const recent = uids.slice(-5).reverse();
    for (const uid of recent) {
      const msg = await client.fetchOne(uid, { bodyParts: ['text'] });
      const text = msg && msg.bodyParts ? msg.bodyParts.get('text') || '' : '';
      const fromAddr = (msg.envelope.from && msg.envelope.from[0] && msg.envelope.from[0].address) || '';
      const subject = (msg.envelope && msg.envelope.subject) || '';
      console.log('--- uid ' + uid + ' from=' + fromAddr + ' subject=' + subject.substring(0, 80));
      console.log('    text: ' + text.replace(/\s+/g, ' ').substring(0, 300));
      console.log('    OTP extracted: ' + extractOtpFromText(text));
    }
  } finally {
    lock.release();
  }
  await client.logout();
})().catch(e => { console.log('ERR: ' + e.message); process.exit(1); });
