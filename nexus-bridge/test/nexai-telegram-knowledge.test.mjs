import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NEXAI_TELEGRAM_PROFILE,
  isNexAiTelegramIntent,
  telegramNexAiAnswer,
  telegramNexAiSystemContext
} from '../adapters/nexai-telegram-knowledge.mjs';

test('recognizes NexAI Telegram intent', () => {
  assert.equal(isNexAiTelegramIntent('Comment fonctionne NexAI sur Telegram ?'), true);
  assert.equal(isNexAiTelegramIntent('Quelle météo demain ?'), false);
});

test('returns canonical pairing flow', () => {
  const answer = telegramNexAiAnswer('Comment utiliser /pair sur NexAI Telegram ?', 'fr');
  assert.match(answer, /@NexAi01_bot/);
  assert.match(answer, /Mini App/);
  assert.match(answer, /QR/);
});

test('returns canonical command overview', () => {
  const answer = telegramNexAiAnswer('Quelles commandes possède NexAI Telegram ?', 'fr');
  assert.match(answer, /500 tokens/);
  assert.match(answer, /\/Code/);
  assert.match(answer, /\/Hidetag/);
  assert.match(answer, /anime/i);
});

test('keeps Facebook and Telegram execution surfaces distinct', () => {
  const answer = telegramNexAiAnswer('Quelle différence entre NexAI Facebook et Telegram ?', 'fr');
  assert.match(answer, /surfaces différentes/);
  assert.match(answer, /sans prétendre/);
});

test('system knowledge includes safety boundaries and current semantics', () => {
  const context = telegramNexAiSystemContext('fr');
  assert.match(context, /\/Hidetag/);
  assert.match(context, /ne doit pas être présentée comme exigeant que l’utilisateur soit administrateur/);
  assert.match(context, /\/Code/);
  assert.match(context, /StringSession/);
  assert.equal(NEXAI_TELEGRAM_PROFILE.username, '@NexAi01_bot');
  assert.equal(NEXAI_TELEGRAM_PROFILE.styles, 31);
});
