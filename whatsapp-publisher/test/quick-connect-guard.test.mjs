import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, phoneFromWhatsAppCredentials, isSameOriginPairingRequest, isAuthorizedWhatsAppPhone } from '../quick-connect-guard.mjs';

test('the owner WhatsApp number must be anchored to previous paired credentials',()=>{
  assert.equal(phoneFromWhatsAppCredentials({me:{id:'22997000123:3@s.whatsapp.net'}}),'22997000123');
  assert.equal(phoneFromWhatsAppCredentials({me:{id:'123'}}),'');
  assert.equal(phoneFromWhatsAppCredentials({}), '');
  assert.equal(normalizePhone('+229 97 00 01 23'),'22997000123');
});

test('only a previously authorized phone can request a new pair code',()=>{
  assert.equal(isAuthorizedWhatsAppPhone('+229 97 00 01 23','22997000123'),true);
  assert.equal(isAuthorizedWhatsAppPhone('22997000124','22997000123'),false);
  assert.equal(isAuthorizedWhatsAppPhone('22997000123',''),false);
  assert.equal(isAuthorizedWhatsAppPhone('123','123'),false);
});

test('cross-origin requests to the public pairing endpoint are rejected',()=>{
  assert.equal(isSameOriginPairingRequest('https://example.trycloudflare.com','example.trycloudflare.com'),true);
  assert.equal(isSameOriginPairingRequest('https://evil.example','example.trycloudflare.com'),false);
  assert.equal(isSameOriginPairingRequest('http://example.trycloudflare.com','example.trycloudflare.com'),false);
  assert.equal(isSameOriginPairingRequest('', 'example.trycloudflare.com'),false);
  assert.equal(isSameOriginPairingRequest('https://example.trycloudflare.com','another.trycloudflare.com'),false);
});
