// netlify/functions/criar-pagamento-mp.js
// Cria pagamentos no Mercado Pago usando Payment Brick.
// Versão reforçada com dados antifraude: comprador, CPF, telefone, endereço, itens, external_reference e notification_url.
// Correções aplicadas:
//  - X-Idempotency-Key única por TENTATIVA (não por pedido) → permite retry de cartão.
//  - additional_info.shipments.receiver_address sem campos inválidos.
//  - Detecção robusta de cartão (não depende só de payment_type_id vindo do Brick).
//  - binary_mode dinâmico: true em cartão (aprovar/rejeitar na hora), false em PIX.

const crypto = require('crypto');

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

/**
 * Detecta se a requisição é de cartão de crédito de forma robusta.
 * O Payment Brick nem sempre envia payment_type_id, então também olhamos:
 *  - presença de token (cartão sempre tem; PIX não)
 *  - payment_method_id diferente de 'pix'
 */
function ehCartaoCredito(body) {
  if (body.payment_type_id === 'credit_card') return true;
  if (body.payment_method_id === 'pix') return false;
  if (body.payment_type_id === 'bank_transfer') return false;
  if (body.payment_type_id === 'debit_card') return false;
  // Fallback: tem token e não é pix → é cartão.
  return !!body.token && body.payment_method_id !== 'pix';
}

function normalizarParcelas(body, valor) {
  // Não é cartão → não envia installments (PIX/débito não usam).
  if (!ehCartaoCredito(body)) return undefined;

  // Cartão de crédito SEMPRE precisa de installments >= 1.
  // Se vier ausente, inválido ou 0, força 1 (à vista). Nunca retornar undefined em cartão.
  let parcelas = Number(body.installments);
  if (!Number.isFinite(parcelas) || parcelas < 1) parcelas = 1;

  // Regra da loja: cartão em até 3x.
  // Em valores baixos (< R$ 30), só à vista para reduzir risco e taxa proporcional.
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

  // IMPORTANTE: receiver_address aceita SOMENTE os campos abaixo no MP.
  // Colocar 'apartment', 'city_name', 'state_name' aqui pode causar rejeição em análise antifraude.
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
        street_number: String(shipping.numero || customer.numero || '')
      }
    },
    shipments: {
      receiver_address: {
        zip_code: somenteNumeros(shipping.cep || customer.cep),
        street_name: shipping.endereco || customer.endereco,
        street_number: String(shipping.numero || customer.numero || ''),
        floor: shipping.complemento || customer.complemento,
        apartment: shipping.complemento || customer.complemento
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

    const isCartaoCredito = ehCartaoCredito(body);
    const isPix = body.payment_method_id === 'pix' || body.payment_type_id === 'bank_transfer';

    // Cartão sem token = inválido. Falha cedo, com mensagem clara.
    if (isCartaoCredito && !body.token) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Token do cartão ausente. Recarregue a página e preencha o cartão novamente.'
        })
      };
    }

    // Cartão sem CPF tende a ser rejeitado pelo antifraude do MP.
    if (isCartaoCredito && !somenteNumeros(payerCpf)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'CPF do titular é obrigatório para pagamento com cartão.'
        })
      };
    }

    const installments = normalizarParcelas(body, transaction_amount);
    const additional_info = montarAdditionalInfo(body, transaction_amount, nome, telefone);

    // payment_type_id: garante que vai 'credit_card' mesmo se o Brick não enviar.
    const payment_type_id = body.payment_type_id || (isCartaoCredito ? 'credit_card' : (isPix ? 'bank_transfer' : undefined));

    const payload = limparIndefinidos({
      transaction_amount,
      description: limitarTexto(body.description || 'Pedido Benedictus Camisaria', 255),
      payment_method_id: body.payment_method_id,
      payment_type_id,
      token: isPix ? undefined : body.token,
      installments,
      issuer_id: isPix ? undefined : body.issuer_id,
      capture: true,

      // Cartão: binary_mode true → aprova ou rejeita na hora (sem limbo "in_process").
      // PIX: false (PIX é assíncrono por natureza).
      binary_mode: isCartaoCredito,

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
          street_number: String(shipping.numero || customer.numero || ''),
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

    // ÚLTIMA TRAVA: cartão SEM installments = MP retorna 4033 "Parcelas inválidas".
    // Se por qualquer caminho o campo não ficou no payload, força 1 aqui.
    if (isCartaoCredito && (payload.installments == null)) {
      payload.installments = 1;
      console.warn('installments ausente em cartão — forçado para 1.');
    }

    // CHAVE DE IDEMPOTÊNCIA ÚNICA POR TENTATIVA.
    // Antes era o external_reference (mesmo do pedido) → causava cache da 1ª resposta
    // e travava o cartão em "recusado" para sempre nos retries.
    const idempotencyKey = crypto.randomUUID();

    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey
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
          cause: mpData.cause,
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