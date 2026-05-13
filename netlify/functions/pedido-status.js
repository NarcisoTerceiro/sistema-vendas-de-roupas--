// netlify/functions/pedido-status.js
// Consulta o status de uma cobrança PIX no PicPay.
// Recebe ?id={merchantChargeId} e retorna { status: 'approved' | 'pending' | 'rejected' | 'cancelled' | 'expired' }

const PICPAY_BASE = 'https://checkout-api.picpay.com'; // ⚠️ Confirme essa URL com seu painel PicPay

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',  // ⚠️ Em produção, troque pelo seu domínio
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type':                 'application/json',
    'Cache-Control':                'no-store, no-cache, must-revalidate'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const CLIENT_ID     = process.env.PICPAY_CLIENT_ID;
    const CLIENT_SECRET = process.env.PICPAY_CLIENT_SECRET;

    if (!CLIENT_ID || !CLIENT_SECRET) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Credenciais não configuradas' }) };
    }

    const id = event.queryStringParameters?.id;
    if (!id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Parâmetro id obrigatório' }) };
    }

    // ── 1. Token ────────────────────────────────────────────
    const tokenRes = await fetch(`${PICPAY_BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type:    'client_credentials',
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET
      })
    });

    if (!tokenRes.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Falha auth PicPay' }) };
    }

    const { access_token } = await tokenRes.json();

    // ── 2. Consulta a cobrança ──────────────────────────────
    const chargeRes = await fetch(`${PICPAY_BASE}/charge/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${access_token}` }
    });

    if (!chargeRes.ok) {
      const erro = await chargeRes.text();
      console.warn('Charge não encontrado:', id, erro);
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'pending' }) };
    }

    const data = await chargeRes.json();
    const picpayStatus = (data.chargeStatus || '').toUpperCase();

    // ── 3. Normaliza status para o front ────────────────────
    // Front espera: approved | pending | rejected | cancelled | expired
    let status;
    switch (picpayStatus) {
      case 'PAID':
        status = 'approved'; break;
      case 'DENIED':
        status = 'rejected'; break;
      case 'CANCELED':
      case 'REFUNDED':
      case 'CHARGEBACK':
        status = 'cancelled'; break;
      case 'ERROR':
        status = 'rejected'; break;
      case 'PRE_AUTHORIZED':
      case 'PARTIAL':
      default:
        status = 'pending';
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status,
        picpayStatus,
        merchantChargeId: data.merchantChargeId,
        amount: data.amount
      })
    };

  } catch (err) {
    console.error('Erro pedido-status:', err);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'pending' }) };
  }
};