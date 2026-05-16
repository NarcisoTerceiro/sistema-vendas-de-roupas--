// netlify/functions/criar-pagamento-mp.js
// Cria pagamentos no Mercado Pago usando Payment Brick.
// Versão reforçada com dados antifraude: comprador, CPF, telefone, endereço, itens, external_reference e notification_url.

const MP_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const SITE_URL = (process.env.SITE_URL || process.env.URL || 'https://benedictuscamisaria.netlify.app').replace(/\/$/, '');

function somenteNumeros(value) {
  return String(value || '').replace(/\D/g, '');
}

function limitarTexto(value, limite, fallback = '') {
  const texto = String(value || fallback || '').trim();
  return texto.length > limite ? texto.slice(0, limite) : texto;
}

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

function separarNome(nomeCompleto) {
  const partes = String(nomeCompleto || '').trim().split(/\s+/).filter(Boolean);
  return {
    first_name: limitarTexto(partes[0] || 'Cliente', 40),
    last_name: limitarTexto(partes.slice(1).join(' ') || 'Benedictus', 80)
  };
}

function formatarTelefone(phoneRaw) {
  const phone = somenteNumeros(phoneRaw);

  if (!phone) {
    return { area_code: undefined, number: undefined };
  }

  // Brasil: DDD + número. Ex.: 83999999999.
  if (phone.length >= 10) {
    return {
      area_code: phone.slice(0, 2),
      number: phone.slice(2, 11)
    };
  }

  return {
    area_code: undefined,
    number: phone
  };
}

function normalizarParcelas(body, valor) {
  const paymentType = body.payment_type_id || body.selectedPaymentMethod;
  const isCreditCard = paymentType === 'credit_card';

  if (!isCreditCard) return undefined;

  const parcelas = Number(body.installments || 1);

  if (!Number.isFinite(parcelas) || parcelas < 1) return 1;

  // Regra da loja: cartão em até 3x.
  // Para reduzir risco em valores muito baixos, evita parcela menor que cerca de R$ 10.
  const maxPorValor = valor < 30 ? 1 : 3;

  return Math.min(parcelas, maxPorValor, 3);
}

function normalizarItens(body, transactionAmount) {
  const itemsOrigem = Array.isArray(body.items) && body.items.length ? body.items : [];

  if (!itemsOrigem.length) {
    return [{
      id: 'pedido-benedictus',
      title: 'Pedido Benedictus Camisaria',
      description: 'Produto Benedictus Camisaria',
      category_id: 'fashion',
      quantity: 1,
      unit_price: Number(transactionAmount)
    }];
  }

  return itemsOrigem.map((item, index) => {
    const quantidade = Number(item.quantity || item.qty || 1) || 1;
    const preco = Number(item.unit_price || item.preco || item.price || item.amount || 0) || 0;

    const detalhes = [
      item.description,
      item.tamanho ? `Tamanho: ${item.tamanho}` : '',
      item.cor ? `Cor: ${item.cor}` : '',
      item.tecido ? `Tecido: ${item.tecido}` : '',
      item.tipo_tecido ? `Tecido: ${item.tipo_tecido}` : ''
    ].filter(Boolean).join(' | ');

    return {
      id: limitarTexto(item.id || item.sku || `produto-${index + 1}`, 256),
      title: limitarTexto(item.title || item.nome || item.name || 'Produto Benedictus', 120),
      description: limitarTexto(detalhes || 'Camiseta cristã Benedictus Camisaria', 250),
      category_id: limitarTexto(item.category_id || item.categoria_mp || 'fashion', 100),
      quantity: quantidade,
      unit_price: Number(preco.toFixed(2))
    };
  });
}

function montarAdditionalInfo(body, transactionAmount, nome, telefone) {
  const customer = body.customer || {};
  const shipping = body.shipping || {};
  const items = normalizarItens(body, transactionAmount);

  return limparIndefinidos({
    items,
    payer: {
      first_name: nome.first_name,
      last_name: nome.last_name,
      phone: {
        area_code: telefone.area_code,
        number: telefone.number
      },
      address: {
        zip_code: somenteNumeros(shipping.cep || customer.cep),
        street_name: shipping.endereco || customer.endereco,
        street_number: shipping.numero || customer.numero
      }
    },
    shipments: {
      receiver_address: {
        zip_code: somenteNumeros(shipping.cep || customer.cep),
        street_name: shipping.endereco || customer.endereco,
        street_number: shipping.numero || customer.numero,
        floor: shipping.complemento || customer.complemento,
        apartment: shipping.bairro || customer.bairro,
        city_name: shipping.cidade || customer.cidade,
        state_name: shipping.uf || customer.uf
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
    const external_reference = limitarTexto(body?.pedido?.id || body.external_reference || `bnd-${Date.now()}`, 256);
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
    const payer = body.payer || {};
    const shipping = body.shipping || {};
    const nome = separarNome(customer.name || `${payer.first_name || ''} ${payer.last_name || ''}`);
    const telefone = formatarTelefone(customer.phone || payer.phone?.number || body.phone);

    const payerEmail = payer.email || customer.email;
    const payerCpf = payer.identification?.number || customer.cpf || body.identificationNumber;

    if (!payerEmail) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'E-mail do pagador obrigatório' })
      };
    }

    const isPix = body.payment_method_id === 'pix' || body.payment_type_id === 'bank_transfer';
    const installments = normalizarParcelas(body, transaction_amount);
    const additional_info = montarAdditionalInfo(body, transaction_amount, nome, telefone);

    const payload = limparIndefinidos({
      transaction_amount,
      description: limitarTexto(body.description || 'Pedido Benedictus Camisaria', 255),
      payment_method_id: body.payment_method_id,
      payment_type_id: body.payment_type_id,
      token: isPix ? undefined : body.token,
      installments,
      issuer_id: isPix ? undefined : body.issuer_id,
      capture: true,

      // Permite pending/in_process quando o Mercado Pago precisar analisar.
      binary_mode: false,

      payer: {
        email: payerEmail,
        first_name: payer.first_name || nome.first_name,
        last_name: payer.last_name || nome.last_name,
        identification: {
          type: payer.identification?.type || 'CPF',
          number: somenteNumeros(payerCpf)
        },
        phone: {
          area_code: telefone.area_code,
          number: telefone.number
        },
        address: {
          zip_code: somenteNumeros(shipping.cep || customer.cep),
          street_name: shipping.endereco || customer.endereco,
          street_number: shipping.numero || customer.numero,
          neighborhood: shipping.bairro || customer.bairro,
          city: shipping.cidade || customer.cidade,
          federal_unit: shipping.uf || customer.uf
        }
      },

      additional_info,
      external_reference,
      notification_url: `${SITE_URL}/.netlify/functions/mercadopago-webhook`,
      statement_descriptor: 'BENEDICTUS',
      metadata: {
        pedido_id: external_reference,
        origem: 'benedictus_site',
        parcelas_limite: 3,
        cep: somenteNumeros(shipping.cep || customer.cep),
        cidade: shipping.cidade || customer.cidade,
        uf: shipping.uf || customer.uf
      }
    });

    console.log('Payload Mercado Pago:', JSON.stringify({
      ...payload,
      token: payload.token ? '[TOKEN_PRESENTE]' : undefined,
      payer: {
        ...payload.payer,
        identification: payload.payer?.identification ? { type: payload.payer.identification.type, number: '[CPF_PRESENTE]' } : undefined
      }
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

    if (mpData.status === 'rejected' || mpData.status === 'in_process') {
      console.warn('Pagamento Mercado Pago retornou status especial:', JSON.stringify({
        id: mpData.id,
        status: mpData.status,
        status_detail: mpData.status_detail,
        payment_method_id: mpData.payment_method_id,
        payment_type_id: mpData.payment_type_id,
        external_reference: mpData.external_reference
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
