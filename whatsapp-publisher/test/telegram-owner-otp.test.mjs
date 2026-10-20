import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramOwnerOtp } from '../telegram-owner-otp.mjs';

const defaults = {
  telegramBotToken: 'test-bot-token',
  ownerChatId: '123456789',
  sessionSecret: 'a-long-random-test-session-secret',
  generateCode: () => '12345678',
};

test('passwordless authentication is disabled when the trusted owner is missing', async () => {
  const auth = createTelegramOwnerOtp({ ...defaults, ownerChatId: '', deliver: async () => {} });
  assert.equal(auth.enabled, false);
  assert.equal((await auth.requestCode()).status, 503);
  assert.equal(auth.verifyCode('12345678'), false);
});

test('OTP is delivered only to the owner and may be redeemed once', async () => {
  const delivered = [];
  const auth = createTelegramOwnerOtp({
    ...defaults,
    deliver: async ({ ownerChatId, code }) => delivered.push({ ownerChatId, code }),
  });
  assert.equal((await auth.requestCode()).ok, true);
  assert.deepEqual(delivered, [{ ownerChatId: defaults.ownerChatId, code: '12345678' }]);
  assert.equal(auth.verifyCode('99999999'), false);
  assert.equal(auth.verifyCode('12345678'), true);
  assert.equal(auth.verifyCode('12345678'), false);
});

test('requesting new codes is rate limited and codes expire after five minutes', async () => {
  let clock = 1000;
  const auth = createTelegramOwnerOtp({ ...defaults, now: () => clock, deliver: async () => {} });
  assert.equal((await auth.requestCode()).ok, true);
  assert.equal((await auth.requestCode()).status, 429);
  clock += 300_001;
  assert.equal(auth.verifyCode('12345678'), false);
  assert.equal((await auth.requestCode()).ok, true);
  assert.equal(auth.verifyCode('12345678'), true);
});

test('challenge is discarded after five incorrect guesses', async () => {
  const auth = createTelegramOwnerOtp({ ...defaults, deliver: async () => {} });
  assert.equal((await auth.requestCode()).ok, true);
  for (let i = 0; i < 5; i++) assert.equal(auth.verifyCode('00000000'), false);
  assert.equal(auth.verifyCode('12345678'), false);
});

test('failed Telegram delivery cannot create a usable login code', async () => {
  const auth = createTelegramOwnerOtp({
    ...defaults,
    deliver: async () => { throw new Error('network unavailable'); },
  });
  assert.equal((await auth.requestCode()).status, 503);
  assert.equal(auth.verifyCode('12345678'), false);
});
