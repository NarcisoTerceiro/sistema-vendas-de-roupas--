// netlify/functions/criar-pagamento-mp.js
// Cria pagamentos no Mercado Pago usando Payment Brick.
// Ajustado para cartão em até 3x e payload mais completo para reduzir recusas por dados insuficientes.

const MP_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const SITE_URL = process.env.URL || 'https://benedictuscamisaria.netlify.app';

function limparIndefinidos(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  Object.keys(obj).forEach((key) => {
    const value = obj[key];

    if (value === undefined || value === null || value === '') {
      delete obj[key];
      return;
    }

    if (Array.isArray(value)) {
      obj[key] = value
        .map((item) => limparIndefinidos(item))
        .filter((item) => item && Object.keys(item).length > 0);
      if (!obj[key].length) delete obj[key];
      return;
    }

    if (typeof value === 'object') {
      limparIndefinidos(value);
      if (!Object.keys(value).length) delete obj[key];
    }
  });

  return obj;
}

function somenteNumeros(value) {
  return String(value || '').replace(/\D/g, '');
}

function separarNome(nomeCompleto) {
  const partes = String(nomeCompleto || '').trim().split(/\s+/).filter(Boolean);
  return {
    first_name: partes[0] || 'Cliente',
    last_name: partes.slice(1).join(' ') || 'Benedictus'
  };
}

function normalizarParcelas(body) {
  const paymentType = body.payment_type_id || body.selectedPaymentMethod;
  const isCreditCard = paymentType === 'credit_card';

  if (!isCreditCard) return undefined;

  const parcelas = Number(body.installments || 1);

  if (!Number.isFinite(parcelas) || parcelas < 1) return 1;

  // Limite de segurança: a loja permite no máximo 3x.
  return Math.min(parcelas, 3);
}

function montarAdditionalInfo(body, transactionAmount) {
  const customer = body.customer || {};
  const shipping = body.shipping || {};
  const phone = somenteNumeros(customer.phone);
  const ddd = phone.length >= 10 ? phone.slice(0, 2) : undefined;
  const numero = phone.length >= 10 ? phone.slice(2) : phone || undefined;

  const items = Array.isArray(body.items) && body.items.length
    ? body.items.map((item) => ({
        id: String(item.id || 'produto'),
        title: String(item.title || item.name || 'Produto Benedictus').slice(0, 120),
        description: String(item.description || 'Produto Benedictus Camisaria').slice(0, 250),
        quantity: Number(item.quantity || 1),
        unit_price: Number(item.unit_price || item.amount || transactionAmount),
        category_id: 'fashion'
      }))
    : [{
        id: 'pedido-benedictus',
        title: 'Pedido Benedictus Camisaria',
        description: 'Produto Benedictus Camisaria',
        quantity: 1,
        unit_price: Number(transactionAmount),
        category_id: 'fashion'
      }];

  return limparIndefinidos({
    items,
    payer: {
      first_name: separarNome(customer.name).first_name,
      last_name: separarNome(customer.name).last_name,
      phone: {
        area_code: ddd,
        number: numero
      },
      address: {
        zip_code: somenteNumeros(shipping.cep),
        street_name: shipping.endereco,
        street_number: shipping.numero
      }
    },
    shipments: {
      receiver_address: {
        zip_code: somenteNumeros(shipping.cep),
        street_name: shipping.endereco,
        street_number: shipping.numero,
        floor: shipping.complemento,
        apartment: shipping.bairro
      }
    }
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, error: 'Method not allowed' })
    };
  }

  try {
    if (!MP_ACCESS_TOKEN) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'MERCADOPAGO_ACCESS_TOKEN não configurado na Netlify'
        })
      };
    }

    const body = JSON.parse(event.body || '{}');
    const external_reference = body?.pedido?.id || `bnd-${Date.now()}`;
    const transaction_amount = Number(Number(body.transaction_amount || body.amount || 0).toFixed(2));

    if (!transaction_amount || transaction_amount <= 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'Valor inválido' })
      };
    }

    if (!body.payment_method_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'Método de pagamento inválido' })
      };
    }

    const customer = body.customer || {};
    const nome = separarNome(customer.name);
    const payer = body.payer || {};

    const payerEmail = payer.email || customer.email;
    const payerCpf =
      payer.identification?.number ||
      customer.cpf ||
      body.identificationNumber;

    if (!payerEmail) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'E-mail do pagador obrigatório' })
      };
    }

    const installments = normalizarParcelas(body);

    const payload = limparIndefinidos({
      transaction_amount,
      description: body.description || 'Pedido Benedictus Camisaria',
      payment_method_id: body.payment_method_id,
      payment_type_id: body.payment_type_id,
      token: body.token,
      installments,
      issuer_id: body.issuer_id,

      // binary_mode false permite que o Mercado Pago retorne pending/in_process quando precisar analisar,
      // em vez de rejeitar instantaneamente em alguns cenários.
      binary_mode: false,

      payer: {
        email: payerEmail,
        first_name: payer.first_name || nome.first_name,
        last_name: payer.last_name || nome.last_name,
        identification: {
          type: payer.identification?.type || 'CPF',
          number: somenteNumeros(payerCpf)
        }
      },

      additional_info: montarAdditionalInfo(body, transaction_amount),

      external_reference,
      notification_url: `${SITE_URL}/.netlify/functions/mercadopago-webhook`,
      statement_descriptor: 'BENEDICTUS',
      metadata: {
        pedido_id: external_reference,
        origem: 'benedictus_site',
        parcelas_limite: 3
      }
    });

    console.log('Payload Mercado Pago:', JSON.stringify({
      ...payload,
      token: payload.token ? '[TOKEN_PRESENTE]' : undefined
    }));

    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': external_reference
      },
      body: JSON.stringify(payload)
    });

    const mpText = await mpRes.text();
    let mpData = {};

    try {
      mpData = mpText ? JSON.parse(mpText) : {};
    } catch {
      mpData = { message: mpText };
    }

    if (!mpRes.ok) {
      console.error('Erro Mercado Pago:', JSON.stringify(mpData));
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          success: false,
          error: mpData.message || mpData.error || 'Erro no Mercado Pago',
          status: mpData.status,
          status_detail: mpData.status_detail,
          debug: mpData
        })
      };
    }

    if (mpData.status === 'rejected') {
      console.warn('Pagamento Mercado Pago recusado:', JSON.stringify({
        id: mpData.id,
        status: mpData.status,
        status_detail: mpData.status_detail,
        payment_method_id: mpData.payment_method_id,
        payment_type_id: mpData.payment_type_id
      }));
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
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'Erro interno',
        debug: String(err?.message || err)
      })
    };
  }
};
