import { config } from './config.mjs';
import { toNexusEnvelope } from './normalizer.mjs';

async function callNexusGateway(event) {
  if (!config.nexusGatewayUrl) return null;

  const response = await fetch(config.nexusGatewayUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.nexusGatewayKey
        ? { authorization: `Bearer ${config.nexusGatewayKey}` }
        : {})
    },
    body: JSON.stringify(toNexusEnvelope(event)),
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) throw new Error(`Nexus gateway HTTP ${response.status}`);
  return response.json();
}

export async function routeInbound(event) {
  if (!['message', 'postback'].includes(event.type)) return { handled: false };
  if (event.isEcho) return { handled: true, silent: true };

  const gatewayResult = await callNexusGateway(event);
  if (gatewayResult) {
    return {
      handled: true,
      text: typeof gatewayResult.text === 'string' ? gatewayResult.text : null,
      raw: gatewayResult
    };
  }

  const text = String(event.text || '').trim();

  if (/^\/?ping$/i.test(text)) {
    return { handled: true, text: 'NexMeta online.' };
  }

  if (/^\/?(?:start|help)$/i.test(text)) {
    return {
      handled: true,
      text: 'NexMeta est connecté. Le routage vers les services Nexus sera activé depuis NexControl.'
    };
  }

  return {
    handled: true,
    text: 'NexMeta a reçu ton message. Le bridge Nexus commun est en cours d’activation.'
  };
}
