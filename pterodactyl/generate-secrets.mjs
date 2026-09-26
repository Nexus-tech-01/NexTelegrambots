import crypto from 'node:crypto';

function secret(bytes = 32) {
  return crypto
    .randomBytes(bytes)
    .toString('base64url');
}

console.log([
  '# Generate these once and store them only in Pterodactyl/NexControl secrets.',
  `NEXMETA_VERIFY_TOKEN=${secret(32)}`,
  `NEXMETA_TOKEN_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`,
  `NEXMETA_CONNECT_KEY=${secret(36)}`,
  `NEXMETA_CONTROL_KEY=${secret(36)}`,
  `NEXUS_COMMAND_GATEWAY_KEY=${secret(36)}`
].join('\n'));
