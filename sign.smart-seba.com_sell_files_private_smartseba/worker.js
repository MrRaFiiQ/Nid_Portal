require('dotenv').config();
const { claimAccount, manualOtpSessions, deferred } = require('./claim-account');

let currentSessionId = null;

// Never let a transient error (e.g. MQTT socket failure) crash the worker and
// lose the whole claim. Report it as a failed result instead.
process.on('uncaughtException', (err) => {
  console.log('  -> Uncaught exception: ' + (err && err.message || err));
  if (currentSessionId) {
    process.send({ type: 'result', sessionId: currentSessionId, result: { success: false, error: 'Uncaught: ' + (err && err.message || err) } });
  }
});
process.on('unhandledRejection', (err) => {
  console.log('  -> Unhandled rejection: ' + (err && err.message || err));
  if (currentSessionId) {
    process.send({ type: 'result', sessionId: currentSessionId, result: { success: false, error: 'Unhandled: ' + (err && err.message || err) } });
  }
});

process.on('message', async (msg) => {
  if (msg.type === 'start') {
    if (currentSessionId) return;
    const { nid, sessionId } = msg;
    currentSessionId = sessionId;

    const otpDeferred = deferred();
    const resultDeferred = deferred();
    manualOtpSessions.set(sessionId, { otpDeferred, resultDeferred, createdAt: Date.now(), nid });

    process.send({ type: 'session_created', sessionId });

    try {
      const result = await claimAccount({
        ...msg,
        manualOtpSessionId: sessionId,
        headless: true,
        autoOtp: msg.autoOtp === true || msg.autoOtp === 'true',
        otpTo: msg.otpTo || '',
        onProgress: (step, percent, message) => {
          if (currentSessionId) {
            process.send({ type: 'progress', sessionId: currentSessionId, step, percent, message });
          }
        },
      });
      process.send({ type: 'result', sessionId, result });
    } catch (err) {
      process.send({ type: 'result', sessionId, result: { success: false, error: err.message } });
    } finally {
      manualOtpSessions.delete(sessionId);
      currentSessionId = null;
      setTimeout(() => process.exit(0), 2000);
    }
  } else if (msg.type === 'otp') {
    const session = manualOtpSessions.get(msg.sessionId);
    if (session && session.otpDeferred) {
      console.log('  -> Worker received OTP via IPC');
      session.otpDeferred.resolve(msg.otp);
    }
  } else if (msg.type === 'shutdown') {
    setTimeout(() => process.exit(0), 500);
  }
});
