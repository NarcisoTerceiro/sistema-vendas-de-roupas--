// netlify/functions/picpay-webhook.js
// Webhook PicPay Empresas: recebe notificações do PicPay e atualiza o pedido no Supabase.
// URL para cadastrar no PicPay:
// https://benedictuscamisaria.com.br/.netlify/functions/picpay-webhook

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PICPAY_WEBHOOK_TOKEN = process.env.PICPAY_WEBHOOK_TOKEN || process.env.PICPAY_NOTIFICATION_TOKEN || '';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, authorization, event-type, Event-Type, event_type, x-seller-token, x-picpay-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function uniq(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function lowerHeaders(event) {
  const out = {};
  for (const [k, v] of Object.entries(event.headers || {})) out[String(k).toLowerCase()] = v;
  return out;
}

function tokenCandidatesFromRequest(event) {
  const h = lowerHeaders(event);
  return uniq([
    h.authorization,
    h['x-seller-token'],
    h['x-picpay-token'],
    h['picpay-token'],
    h['api-key']
  ].flatMap((v) => {
    const raw = clean(v);
    if (!raw) return [];
    return [raw, raw.replace(/^bearer\s+/i, '').trim()];
  }));
}

function isAuthorized(event) {
  // Se a variável não estiver configurada, aceita para não perder venda,
  // mas isso deve ser ajustado antes de alto volume.
  if (!PICPAY_WEBHOOK_TOKEN) {
    console.warn('PICPAY_WEBHOOK_TOKEN não configurado. Webhook aceito sem validação de token. Configure essa variável no lançamento.');
    return true;
  }

  const expected = clean(PICPAY_WEBHOOK_TOKEN);
  return tokenCandidatesFromRequest(event).some((token) => token === expected);
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn('Webhook PicPay recebido sem JSON válido:', raw.slice(0, 500));
    return {};
  }
}

function extractEventType(body, event) {
  const h = lowerHeaders(event);
  return clean(h['event-type'] || h.event_type || body?.eventType || body?.event_type || body?.type);
}

function extractStatus(body, eventType) {
  const d = body?.data || {};
  const tx0 = Array.isArray(d.transactions) ? d.transactions[0] : null;

  // Prioridade: status de transação/charge. O campo body.type costuma vir como PAYMENT/REFUND,
  // que não é exatamente o status.
  const candidates = [
    d?.transaction?.status,
    d?.transaction?.transactionStatus,
    tx0?.transactionStatus,
    tx0?.status,
    d?.chargeStatus,
    d?.status,
    d?.charge?.status,
    d?.charge?.chargeStatus,
    d?.payment?.status,
    d?.payment?.paymentStatus,
    body?.chargeStatus,
    body?.status,
    body?.type,
    body?.event,
    eventType
  ];

  return clean(candidates.find(Boolean)).toUpperCase();
}

function mapStatus(statusRaw, eventTypeRaw, body) {
  const status = clean(statusRaw).toUpperCase();
  const eventType = clean(eventTypeRaw).toUpperCase();
  const bodyType = clean(body?.type).toUpperCase();
  const combined = `${eventType} ${bodyType} ${status}`;

  if (/CHARGEBACK/.test(combined)) return 'chargeback';
  if (/PARTREFUNDED|PARTIALLY_REFUNDED/.test(combined)) return 'estornado_parcial';
  if (/REFUND|REFUNDED|REFUNDED|ESTORN/.test(combined)) return 'estornado';

  const approved = ['PAID', 'PAYED', 'APPROVED', 'APPROVE', 'ACCEPTED', 'AUTHORIZED', 'CAPTURED', 'CONFIRMED', 'SUCCESS', 'COMPLETED'];
  const rejected = ['DENIED', 'REJECTED', 'DECLINED', 'REFUSED', 'FAILED', 'ERROR'];
  const cancelled = ['CANCELED', 'CANCELLED', 'CANCELADO', 'EXPIRED', 'EXPIROU', 'INACTIVE'];
  const pending = ['CREATED', 'PENDING', 'PROCESSING', 'PRE_AUTHORIZED', 'PREAUTHORIZED', 'WAITING', 'ANALYSIS', 'IN_PROCESS'];

  if (approved.includes(status)) return 'pago';
  if (rejected.includes(status)) return 'recusado';
  if (cancelled.includes(status)) return 'cancelado';
  if (pending.includes(status)) return 'aguardando_pagamento';

  // Link de Pagamento pode mandar body.type PAYMENT e data.transaction.status PAYED.
  // Se só veio PAYMENT e não veio um status negativo, consideramos pago.
  if (/PAYMENT|CAPTURE|AUTHORIZATION/.test(combined) && !/DENIED|REJECTED|FAILED|CANCEL|REFUND|CHARGEBACK/.test(combined)) return 'pago';

  return 'aguardando_pagamento';
}

function extractIdentifiers(body) {
  const d = body?.data || {};
  const tx0 = Array.isArray(d.transactions) ? d.transactions[0] : null;
  return uniq([
    // Checkout/Gateway
    body?.merchantChargeId,
    body?.externalReference,
    body?.external_reference,
    body?.referenceId,
    body?.reference_id,
    d?.merchantChargeId,
    d?.externalReference,
    d?.external_reference,
    d?.referenceId,
    d?.reference_id,
    d?.charge?.merchantChargeId,

    // Identificadores internos PicPay
    body?.id,
    d?.id,
    d?.smartCheckoutId,
    d?.checkoutId,
    d?.chargeId,
    d?.charge?.chargeId,
    d?.charge?.id,
    d?.payment?.id,

    // Link de pagamento
    d?.paymentLinkId,
    d?.payment_link_id,
    d?.charge?.paymentLinkId,
    d?.charge?.payment_link_id,

    // Transações
    d?.transaction?.id,
    d?.transaction?.transactionId,
    d?.transaction?.originalTransactionId,
    tx0?.transactionId,
    tx0?.id,
    tx0?.originalTransactionId,
    d?.payment?.transactionId,
  ]);
}

function buildUpdate(novoStatus, statusOriginal, body, identifiers) {
  const now = new Date().toISOString();
  const chargeId = clean(body?.data?.charge?.paymentLinkId || body?.data?.merchantChargeId || body?.data?.chargeId || body?.id || identifiers[0]);
  const obs = `PicPay webhook: ${statusOriginal || 'status não informado'} em ${now}.`;

  const update = {
    status: novoStatus,
    observacao: obs,
    updated_at: now,
  };

  if (chargeId) update.pix_charge_id = chargeId;
  if (novoStatus === 'pago') update.pago_em = now;
  return update;
}

async function patchSupabaseByFilter(filterColumn, filterValue, update) {
  const url = `${SUPABASE_URL}/rest/v1/pedidos?${filterColumn}=eq.${encodeURIComponent(filterValue)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(update)
  });

  const text = await res.text();
  let data = [];
  try { data = text ? JSON.parse(text) : []; } catch { data = []; }

  if (!res.ok) {
    console.error(`Erro ao atualizar pedido por ${filterColumn}:`, res.status, text);
    return { ok: false, rows: [] };
  }

  return { ok: true, rows: Array.isArray(data) ? data : [] };
}

async function updatePedido(identifiers, update) {
  const columns = ['external_reference', 'pix_charge_id'];
  for (const id of identifiers) {
    for (const col of columns) {
      const r = await patchSupabaseByFilter(col, id, update);
      if (r.ok && r.rows.length) return { matched: true, by: col, id, rows: r.rows.length };
    }
  }
  return { matched: false };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const body = parseBody(event);
  const eventType = extractEventType(body, event);
  const statusOriginal = extractStatus(body, eventType);
  const novoStatus = mapStatus(statusOriginal, eventType, body);
  const identifiers = extractIdentifiers(body);

  console.log('Webhook PicPay recebido:', JSON.stringify({ eventType, statusOriginal, novoStatus, identifiers, headers: Object.keys(event.headers || {}) }));

  if (!isAuthorized(event)) {
    console.warn('Webhook PicPay recusado: token inválido/ausente. Tokens recebidos:', tokenCandidatesFromRequest(event).map(() => '[RECEBIDO]'));
    return json(401, { ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Supabase não configurado para webhook PicPay. Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.');
    return json(200, { ok: false, stored: false, reason: 'supabase_not_configured', status: novoStatus, identifiers });
  }

  if (!identifiers.length) {
    console.warn('Webhook PicPay sem identificador reconhecido:', JSON.stringify(body).slice(0, 1500));
    return json(200, { ok: true, matched: false, reason: 'no_identifier', status: novoStatus });
  }

  const update = buildUpdate(novoStatus, statusOriginal || eventType, body, identifiers);
  const result = await updatePedido(identifiers, update);

  if (!result.matched) {
    console.warn('Webhook PicPay recebido, mas nenhum pedido foi encontrado:', JSON.stringify({ identifiers, statusOriginal, novoStatus }));
  }

  return json(200, { ok: true, status: novoStatus, matched: result.matched, by: result.by || null, id: result.id || null });
};
