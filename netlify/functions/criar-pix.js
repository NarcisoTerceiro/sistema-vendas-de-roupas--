// netlify/functions/criar-pix.js
// Cria cobrança PIX via API PicPay e retorna QR Code para o front.

const PICPAY_BASE = 'https://checkout-api.picpay.com';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  try {
    const CLIENT_ID     = process.env.PICPAY_CLIENT_ID;
    const CLIENT_SECRET = process.env.PICPAY_CLIENT_SECRET;

    if (!CLIENT_ID || !CLIENT_SECRET) {
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Credenciais PicPay não configuradas' }) };
    }

    const dados = JSON.parse(event.body || '{}');
    const { amount, customer, pedidoId } = dados;

    if (!amount || amount < 1) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'amount inválido' }) };
    }
    if (!customer?.name || !customer?.email || !customer?.document) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Dados do cliente incompletos' }) };
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
      const erro = await tokenRes.text();
      console.error('Auth PicPay falhou:', erro);
      return { statusCode: 502, headers, body: JSON.stringify({ success: false, error: 'Falha autenticação PicPay' }) };
    }

    const { access_token } = await tokenRes.json();

    // ── 2. Cobrança PIX ────────────────────────────────────
    // merchantChargeId: mínimo 6 chars, máximo 36, só letras/números/hífen
    let merchantChargeId = `bnd-${Date.now()}`;
    if (pedidoId) {
      const sanitized = String(pedidoId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36);
      if (sanitized.length >= 6) merchantChargeId = sanitized;
    }

    // amount vem em centavos do front (ex: 15100 = R$151,00)
    const amountCentavos = Math.round(Number(amount));

    const payload = {
      paymentSource: 'GATEWAY',
      merchantChargeId,
      customer: {
        name:         customer.name,
        email:        customer.email,
        documentType: 'CPF',
        document:     customer.document.replace(/\D/g, '')
      },
      transactions: [{
        amount: amountCentavos, // centavos (ex: 15100)
        pix: { expiration: 900 } // 15 min
      }]
    };

    console.log('Payload enviado ao PicPay:', JSON.stringify(payload));

    const chargeRes = await fetch(`${PICPAY_BASE}/charge/pix`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${access_token}`
      },
      body: JSON.stringify(payload)
    });

    const chargeData = await chargeRes.json();

    if (!chargeRes.ok) {
      console.error('Charge PicPay erro:', JSON.stringify(chargeData));
      return {
        statusCode: 502, headers,
        body: JSON.stringify({ success: false, error: chargeData.message || JSON.stringify(chargeData) })
      };
    }

    const pix = chargeData.transactions?.[0]?.pix || {};

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        success:          true,
        paymentId:        chargeData.id,
        merchantChargeId: chargeData.merchantChargeId,
        qr_code:          pix.qrCode,
        qr_code_base64:   pix.qrCodeBase64
      })
    };

  } catch (err) {
    console.error('Erro inesperado:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Erro interno' }) };
  }
};