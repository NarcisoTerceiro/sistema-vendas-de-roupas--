// netlify/functions/pedido-status.js
// Consulta o status do pedido no Supabase e, se ainda estiver pendente,
// consulta também a API do PicPay. Assim, o cliente recebe confirmação mesmo
// se o webhook atrasar ou não for disparado pelo painel.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PICPAY_ENV = String(process.env.PICPAY_ENV || 'production').toLowerCase();
const IS_SANDBOX = ['sandbox', 'test', 'testing', 'homolog', 'homologacao'].includes(PICPAY_ENV);
const PICPAY_INTEGRATION_MODE = String(process.env.PICPAY_INTEGRATION_MODE || 'payment_link').toLowerCase();
const USE_GATEWAY_CHECKOUT = ['gateway', 'checkout', 'smart_checkout'].includes(PICPAY_INTEGRATION_MODE);

const AUTH_URL = process.env.PICPAY_AUTH_URL || (IS_SANDBOX
  ? 'https://checkout-api-sandbox.picpay.com/oauth2/token'
  : 'https://checkout-api.picpay.com/oauth2/token');

const CHECKOUT_API_BASE = process.env.PICPAY_CHECKOUT_API_BASE || (IS_SANDBOX
  ? 'https://checkout-api-sandbox.picpay.com/api/v1'
  : 'https://checkout-api.picpay.com/api/v1');

const PAYMENT_LINK_AUTH_URL = process.env.PICPAY_LINK_AUTH_URL || (IS_SANDBOX
  ? 'https://api.ms.qa.limbo.work/sandbox/oauth2/token'
  : 'https://api.picpay.com/oauth2/token');

const PAYMENT_LINK_API_BASE = process.env.PICPAY_LINK_API_BASE || (IS_SANDBOX
  ? 'https://api.ms.qa.limbo.work/sandbox/v1'
  : 'https://api.picpay.com/v1');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate'
};

let tokenCache = { scope: null, accessToken: null, expiresAt: 0 };

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizarStatus(statusBanco) {
  const s = String(statusBanco || '').trim().toLowerCase();

  if (['pago', 'paid', 'payed', 'approved', 'aprovado', 'confirmado', 'accredited', 'captured', 'authorized'].includes(s)) return 'approved';
  if (['recusado', 'rejected', 'denied', 'declined', 'failed', 'erro', 'error'].includes(s)) return 'rejected';
  if (['cancelado', 'cancelled', 'canceled', 'expirado', 'expired'].includes(s)) return 'cancelled';
  if (['estornado', 'refunded', 'partrefunded', 'partially_refunded', 'chargeback'].includes(s)) return 'cancelled';
  return 'pending';
}

function mapPicPayStatus(statusRaw) {
  const status = clean(statusRaw).toUpperCase();

  if (['PAID', 'PAYED', 'AUTHORIZED', 'CAPTURED', 'APPROVED', 'CONFIRMED', 'COMPLETED'].includes(status)) return 'pago';
  if (['DENIED', 'ERROR', 'FAILED', 'REJECTED', 'DECLINED', 'REFUSED'].includes(status)) return 'recusado';
  if (['CANCELED', 'CANCELLED', 'EXPIRED', 'INACTIVE'].includes(status)) return 'cancelado';
  if (['REFUNDED', 'PARTREFUNDED', 'PARTIALLY_REFUNDED'].includes(status)) return 'estornado';
  if (['CHARGEBACK'].includes(status)) return 'chargeback';
  return 'aguardando_pagamento';
}

function statusFromPicPayPayload(data) {
  if (!data || typeof data !== 'object') return '';

  // Checkout/Gateway: chargeStatus + transactions[].transactionStatus
  const tx = Array.isArray(data.transactions) ? data.transactions[0] : null;
  const candidates = [
    data.chargeStatus,
    data.status,
    tx?.transactionStatus,
    tx?.status,
    data.data?.transaction?.status,
    data.data?.charge?.status
  ];
  return clean(candidates.find(Boolean));
}

async function obterToken(scope = 'checkout') {
  const now = Date.now();
  if (tokenCache.scope === scope && tokenCache.accessToken && tokenCache.expiresAt > now + 15000) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.PICPAY_CLIENT_ID;
  const clientSecret = process.env.PICPAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('PICPAY_CLIENT_ID/PICPAY_CLIENT_SECRET ausentes.');

  const url = scope === 'payment_link' ? PAYMENT_LINK_AUTH_URL : AUTH_URL;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }

  if (!res.ok || !data.access_token) {
    console.error('Erro auth PicPay em pedido-status:', JSON.stringify({ scope, status: res.status, data }));
    throw new Error(data.message || data.error || 'Falha ao autenticar no PicPay.');
  }

  const expiresIn = Number(data.expires_in || 300);
  tokenCache = {
    scope,
    accessToken: data.access_token,
    expiresAt: now + Math.max(60, expiresIn - 20) * 1000
  };
  return data.access_token;
}

async function buscarPedido(coluna, valor) {
  const url = `${SUPABASE_URL}/rest/v1/pedidos?${coluna}=eq.${encodeURIComponent(valor)}&select=id,status,external_reference,pix_charge_id,total,pagamento&limit=1`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Erro ao consultar pedido por ${coluna}:`, res.status, text);
    return null;
  }

  const data = await res.json().catch(() => []);
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function atualizarPedido(pedido, novoStatus, origem, picpayData = {}) {
  if (!pedido?.id || !novoStatus) return null;

  const now = new Date().toISOString();
  const chargeId = clean(picpayData.id || picpayData.paymentLinkId || picpayData.data?.charge?.paymentLinkId || pedido.pix_charge_id);
  const update = {
    status: novoStatus,
    observacao: `PicPay ${origem}: ${statusFromPicPayPayload(picpayData) || novoStatus} em ${now}.`,
    updated_at: now
  };

  if (chargeId) update.pix_charge_id = chargeId;
  if (novoStatus === 'pago') update.pago_em = now;

  const url = `${SUPABASE_URL}/rest/v1/pedidos?id=eq.${encodeURIComponent(pedido.id)}`;
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
  if (!res.ok) {
    console.error('Erro ao atualizar pedido após consulta PicPay:', res.status, text);
    return null;
  }

  const rows = JSON.parse(text || '[]');
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function consultarChargeCheckout(merchantChargeId) {
  if (!merchantChargeId) return null;
  const token = await obterToken('checkout');
  const url = `${CHECKOUT_API_BASE}/charge/${encodeURIComponent(merchantChargeId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }

  if (!res.ok) {
    console.warn('Consulta PicPay Checkout sem sucesso:', JSON.stringify({ merchantChargeId, status: res.status, data }));
    return null;
  }
  return data;
}

async function consultarPaymentLink(paymentLinkId) {
  if (!paymentLinkId) return null;
  const token = await obterToken('payment_link');

  // Consulta primeiro as transações do link, pois é onde aparece o status PAYED/REFUNDED.
  for (const path of [`/paymentlink/${encodeURIComponent(paymentLinkId)}/transactions`, `/paymentlink/${encodeURIComponent(paymentLinkId)}`]) {
    const url = `${PAYMENT_LINK_API_BASE}${path}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });

    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }

    if (res.ok) return data;
    console.warn('Consulta PicPay Payment Link sem sucesso:', JSON.stringify({ paymentLinkId, path, status: res.status, data }));
  }

  return null;
}

function statusFromPaymentLinkPayload(data) {
  if (!data || typeof data !== 'object') return '';

  const root = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data;
  const arrays = [
    Array.isArray(data) ? data : null,
    Array.isArray(data.transactions) ? data.transactions : null,
    Array.isArray(root.transactions) ? root.transactions : null,
    Array.isArray(root.data) ? root.data : null,
  ].filter(Boolean);

  for (const arr of arrays) {
    const tx = arr[0];
    const found = clean(tx?.status || tx?.transactionStatus || tx?.paymentStatus || tx?.type);
    if (found) return found;
  }

  const tx = root.transaction || data.transaction || root.payment || data.payment || root.charge || data.charge;
  return clean(
    tx?.status ||
    tx?.transactionStatus ||
    tx?.paymentStatus ||
    root.status ||
    root.chargeStatus ||
    data.status ||
    data.chargeStatus ||
    data.type
  );
}

async function consultarPicPayEAtualizar(pedido) {
  const ids = [pedido.external_reference, pedido.pix_charge_id].map(clean).filter(Boolean);
  let picpayData = null;
  let rawStatus = '';
  let origem = '';

  // A integração atual usa Link de Pagamento como principal. Evita consultar o
  // Gateway Checkout quando a conta não possui o escopo liberado, porque isso
  // gera 403 "Missing required scope" nos logs sem ajudar a confirmar o pedido.
  if (!USE_GATEWAY_CHECKOUT && pedido.pix_charge_id) {
    picpayData = await consultarPaymentLink(pedido.pix_charge_id).catch((err) => {
      console.warn('Falha ao consultar payment link PicPay:', err.message);
      return null;
    });
    rawStatus = statusFromPaymentLinkPayload(picpayData);
    if (rawStatus) origem = 'consulta_payment_link';
  }

  // Só tenta Gateway Checkout quando expressamente habilitado por variável de ambiente.
  if (!rawStatus && USE_GATEWAY_CHECKOUT) {
    for (const id of ids) {
      picpayData = await consultarChargeCheckout(id).catch((err) => {
        console.warn('Falha ao consultar charge checkout PicPay:', err.message);
        return null;
      });
      rawStatus = statusFromPicPayPayload(picpayData);
      if (rawStatus) { origem = 'consulta_checkout'; break; }
    }
  }

  // Fallback final: consulta Payment Link pelo pix_charge_id.
  if (!rawStatus && pedido.pix_charge_id) {
    picpayData = await consultarPaymentLink(pedido.pix_charge_id).catch((err) => {
      console.warn('Falha ao consultar payment link PicPay:', err.message);
      return null;
    });
    rawStatus = statusFromPaymentLinkPayload(picpayData);
    if (rawStatus) origem = 'consulta_payment_link';
  }

  if (!rawStatus) return { pedido, checked: true, changed: false, picpayStatus: null };

  const novoStatus = mapPicPayStatus(rawStatus);
  if (novoStatus === 'aguardando_pagamento') {
    return { pedido, checked: true, changed: false, picpayStatus: rawStatus };
  }

  const atualizado = await atualizarPedido(pedido, novoStatus, origem, picpayData);
  return { pedido: atualizado || pedido, checked: true, changed: !!atualizado, picpayStatus: rawStatus };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  try {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: 'Parâmetro id obrigatório' });

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.warn('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente em pedido-status.');
      return json(200, { status: 'pending', reason: 'supabase_not_configured' });
    }

    let pedido = await buscarPedido('external_reference', id);
    if (!pedido) pedido = await buscarPedido('pix_charge_id', id);

    if (!pedido) return json(200, { status: 'pending', found: false });

    let normalized = normalizarStatus(pedido.status);
    let consultaPicPay = null;

    // Se ainda está pendente, usa a API do PicPay como fallback do webhook.
    if (normalized === 'pending' && process.env.PICPAY_CLIENT_ID && process.env.PICPAY_CLIENT_SECRET) {
      consultaPicPay = await consultarPicPayEAtualizar(pedido);
      pedido = consultaPicPay.pedido || pedido;
      normalized = normalizarStatus(pedido.status);
    }

    return json(200, {
      status: normalized,
      pedidoStatus: pedido.status,
      pedido_id: pedido.id,
      external_reference: pedido.external_reference,
      paymentId: pedido.pix_charge_id,
      total: pedido.total,
      pagamento: pedido.pagamento,
      found: true,
      picpay_checked: !!consultaPicPay,
      picpay_status: consultaPicPay?.picpayStatus || null,
      integrationMode: USE_GATEWAY_CHECKOUT ? 'gateway_checkout' : 'payment_link'
    });
  } catch (err) {
    console.error('Erro pedido-status PicPay:', err);
    return json(200, { status: 'pending', error: 'status_check_failed', details: err.message });
  }
};
