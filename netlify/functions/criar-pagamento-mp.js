// netlify/functions/criar-pagamento-mp.js
// Cria pagamentos no Mercado Pago usando Payment Brick.

const MP_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;

function limparIndefinidos(obj) {
  Object.keys(obj).forEach((key) => {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') delete obj[key];
    else if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) limparIndefinidos(obj[key]);
  });
  return obj;
}

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
    if (!MP_ACCESS_TOKEN) {
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'MERCADOPAGO_ACCESS_TOKEN não configurado na Netlify' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const external_reference = body?.pedido?.id || `bnd-${Date.now()}`;
    const transaction_amount = Number(body.transaction_amount || body.amount || 0);

    if (!transaction_amount || transaction_amount <= 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Valor inválido' }) };
    }

    if (!body.payment_method_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Método de pagamento inválido' }) };
    }

    const payer = body.payer || {};
    const payload = limparIndefinidos({
      transaction_amount,
      description: body.description || 'Pedido Benedictus Camisaria',
      payment_method_id: body.payment_method_id,
      token: body.token,
      installments: body.installments ? Number(body.installments) : undefined,
      issuer_id: body.issuer_id,
      payer: {
        email: payer.email || body.customer?.email,
        first_name: payer.first_name || body.customer?.name?.split(' ')?.[0],
        last_name: payer.last_name || body.customer?.name?.split(' ')?.slice(1).join(' '),
        identification: payer.identification || {
          type: 'CPF',
          number: String(body.customer?.cpf || '').replace(/\D/g, '')
        }
      },
      external_reference,
      notification_url: 'https://benedictuscamisaria.netlify.app/.netlify/functions/mercadopago-webhook',
      statement_descriptor: 'BENEDICTUS'
    });

    console.log('Payload Mercado Pago:', JSON.stringify(payload));

    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `${external_reference}-${Date.now()}`
      },
      body: JSON.stringify(payload)
    });

    const mpText = await mpRes.text();
    let mpData = {};

    try { mpData = mpText ? JSON.parse(mpText) : {}; }
    catch { mpData = { message: mpText }; }

    if (!mpRes.ok) {
      console.error('Erro Mercado Pago:', JSON.stringify(mpData));
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          success: false,
          error: mpData.message || mpData.error || 'Erro no Mercado Pago',
          debug: mpData
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        payment: mpData,
        paymentId: mpData.id,
        status: mpData.status,
        status_detail: mpData.status_detail,
        external_reference: mpData.external_reference,
        qr_code: mpData.point_of_interaction?.transaction_data?.qr_code,
        qr_code_base64: mpData.point_of_interaction?.transaction_data?.qr_code_base64,
        ticket_url: mpData.point_of_interaction?.transaction_data?.ticket_url
      })
    };
  } catch (err) {
    console.error('Erro inesperado Mercado Pago:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Erro interno', debug: String(err?.message || err) }) };
  }
};
