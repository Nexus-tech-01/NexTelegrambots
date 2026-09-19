import crypto from 'node:crypto';

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));

  return left.length === right.length &&
    crypto.timingSafeEqual(left, right);
}

export function validateNexusEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('invalid_envelope');
  }

  if (envelope.version !== 2) {
    throw new Error('unsupported_envelope_version');
  }

  if (!envelope.source || envelope.source.platform !== 'facebook') {
    throw new Error('unsupported_source');
  }

  if (!envelope.event || typeof envelope.event.type !== 'string') {
    throw new Error('invalid_event');
  }

  const surface = String(envelope.source.surface || '');

  if (surface === 'system') {
    if (envelope.event.type !== 'system_probe') {
      throw new Error('unsupported_system_event');
    }
    return envelope;
  }

  if (!['messenger', 'page'].includes(surface)) {
    throw new Error('unsupported_surface');
  }

  return envelope;
}

export function verifyNexusBridgeSignature({
  rawBody,
  headers,
  sharedKey,
  nowMs = Date.now(),
  maxSkewSeconds = 120
}) {
  const key = String(sharedKey || '');
  if (!key) {
    return {
      ok: false,
      error: 'bridge_key_missing'
    };
  }

  const authorization = String(
    headers?.authorization ||
    headers?.Authorization ||
    ''
  );

  const suppliedBearer = authorization.replace(/^Bearer\s+/i, '').trim();

  if (!suppliedBearer || !safeEqual(suppliedBearer, key)) {
    return {
      ok: false,
      error: 'invalid_bearer'
    };
  }

  const timestamp = String(
    headers?.['x-nexus-timestamp'] ||
    headers?.['X-Nexus-Timestamp'] ||
    ''
  ).trim();

  const parsedTimestamp = Number(timestamp);
  if (!Number.isFinite(parsedTimestamp)) {
    return {
      ok: false,
      error: 'invalid_timestamp'
    };
  }

  const skewSeconds = Math.abs(
    Math.floor(nowMs / 1000) - parsedTimestamp
  );

  if (skewSeconds > maxSkewSeconds) {
    return {
      ok: false,
      error: 'expired_request'
    };
  }

  const signatureHeader = String(
    headers?.['x-nexus-signature'] ||
    headers?.['X-Nexus-Signature'] ||
    ''
  );

  const [algorithm, suppliedSignature] = signatureHeader.split('=', 2);

  if (algorithm !== 'sha256' || !suppliedSignature) {
    return {
      ok: false,
      error: 'invalid_signature_header'
    };
  }

  const body = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(String(rawBody || ''));

  const expected = crypto
    .createHmac('sha256', key)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');

  if (!safeEqual(suppliedSignature.toLowerCase(), expected.toLowerCase())) {
    return {
      ok: false,
      error: 'invalid_signature'
    };
  }

  return {
    ok: true,
    timestamp: parsedTimestamp
  };
}

function serviceName(envelope) {
  const preferred = String(
    envelope?.routing?.preferredService ||
    'auto'
  ).trim().toLowerCase();

  return preferred || 'auto';
}

export async function dispatchNexusEnvelope(
  envelope,
  {
    services = {},
    resolveAuto,
    claimEvent,
    releaseEvent
  } = {}
) {
  validateNexusEnvelope(envelope);

  if (
    envelope.source.surface === 'system' &&
    envelope.event.type === 'system_probe'
  ) {
    return {
      handledBy: 'nexus-bridge',
      duplicate: false,
      probe: true,
      reply: null
    };
  }

  const eventId = envelope.event?.id
    ? String(envelope.event.id)
    : null;

  let claim = null;

  if (eventId && typeof claimEvent === 'function') {
    claim = await claimEvent({
      eventId,
      source: envelope.source,
      envelope
    });

    if (claim === false) {
      return {
        handledBy: null,
        duplicate: true,
        reply: null
      };
    }
  }

  try {
    let target = serviceName(envelope);

    if (target === 'auto' && typeof resolveAuto === 'function') {
      target = String(
        await resolveAuto(envelope) ||
        'auto'
      ).toLowerCase();
    }

    let handler = services[target];

    if (!handler && target !== 'auto') {
      handler = services.auto;
    }

    if (typeof handler !== 'function') {
      const error = new Error('nexus_service_unavailable');
      error.service = target;
      error.retryable = true;
      throw error;
    }

    const result = await handler(envelope);

    return {
      handledBy: target,
      duplicate: false,
      reply: result?.reply !== undefined
        ? result.reply
        : result || null
    };
  } catch (error) {
    if (
      claim &&
      typeof releaseEvent === 'function' &&
      error?.retryable === true
    ) {
      await releaseEvent(claim).catch(() => {});
    }

    throw error;
  }
}

async function readRawBody(req, maxBytes) {
  if (Buffer.isBuffer(req.rawBody)) {
    return req.rawBody;
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > maxBytes) {
      const error = new Error('payload_too_large');
      error.status = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function writeJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

export function createNexusBridgeHandler({
  sharedKey,
  services,
  resolveAuto,
  claimEvent,
  releaseEvent,
  maxSkewSeconds = 120,
  maxBodyBytes = 1024 * 1024
}) {
  return async function nexusBridgeHandler(req, res) {
    try {
      if (req.method !== 'POST') {
        return writeJson(res, 405, {
          error: 'method_not_allowed'
        });
      }

      const rawBody = await readRawBody(req, maxBodyBytes);

      const verified = verifyNexusBridgeSignature({
        rawBody,
        headers: req.headers,
        sharedKey,
        maxSkewSeconds
      });

      if (!verified.ok) {
        return writeJson(res, 401, {
          error: verified.error
        });
      }

      let envelope;

      try {
        envelope = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return writeJson(res, 400, {
          error: 'invalid_json'
        });
      }

      validateNexusEnvelope(envelope);

      const result = await dispatchNexusEnvelope(
        envelope,
        {
          services,
          resolveAuto,
          claimEvent,
          releaseEvent
        }
      );

      return writeJson(res, 200, {
        ok: true,
        ...result
      });
    } catch (error) {
      const status = Number(error?.status);
      const httpStatus =
        status >= 400 && status <= 599
          ? status
          : error?.message === 'nexus_service_unavailable'
            ? 503
            : 500;

      return writeJson(res, httpStatus, {
        error: String(
          error?.message ||
          'bridge_error'
        ).slice(0, 200),
        service: error?.service || null,
        retryable: error?.retryable === true
      });
    }
  };
}
