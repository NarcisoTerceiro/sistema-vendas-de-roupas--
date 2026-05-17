// netlify/functions/criar-picpay-checkout.js
// Cria um checkout hospedado no PicPay Empresas e retorna a URL para o cliente pagar.
// Mercado Pago permanece em standby; este arquivo é o fluxo principal de pagamento.

const crypto = require('crypto');

const SITE_URL = (process.env.SITE_URL || process.env.URL || 'https://benedictuscamisaria.com.br').replace(/\/$/, '');
const PICPAY_ENV = String(process.env.PICPAY_ENV || 'production').toLowerCase();
const IS_SANDBOX = ['sandbox', 'test', 'testing', 'homolog', 'homologacao'].includes(PICPAY_ENV);

// A conta atual retornou 403 no Gateway Checkout: "Missing required scope".
// Por isso o fluxo principal passa a ser Payment Link. Se o PicPay liberar o
// escopo de Gateway no futuro, defina PICPAY_INTEGRATION_MODE=gateway na Netlify.
const PICPAY_INTEGRATION_MODE = String(process.env.PICPAY_INTEGRATION_MODE || 'payment_link').toLowerCase();
const USE_GATEWAY_CHECKOUT = ['gateway', 'checkout', 'smart_checkout'].includes(PICPAY_INTEGRATION_MODE);

// Gateway Checkout API. Mantém variáveis sobrescritíveis para adaptar rapidamente caso
// o PicPay informe outro endpoint no painel/contrato da conta.
const AUTH_URL = process.env.PICPAY_AUTH_URL || (IS_SANDBOX
  ? 'https://checkout-api-sandbox.picpay.com/oauth2/token'
  : 'https://checkout-api.picpay.com/oauth2/token');

const CHECKOUT_URL = process.env.PICPAY_CHECKOUT_URL || (IS_SANDBOX
  ? 'https://checkout-api-sandbox.picpay.com/api/v1/checkout'
  : 'https://checkout-api.picpay.com/api/v1/checkout');

// Fallback opcional para a API de Link de Pagamento, caso a conta esteja habilitada
// somente para payment link. Só é usado se o Gateway Checkout falhar.
const PAYMENT_LINK_AUTH_URL = process.env.PICPAY_LINK_AUTH_URL || (IS_SANDBOX
  ? 'https://api.ms.qa.limbo.work/sandbox/oauth2/token'
  : 'https://api.picpay.com/oauth2/token');

const PAYMENT_LINK_URL = process.env.PICPAY_LINK_CREATE_URL || (IS_SANDBOX
  ? 'https://api.ms.qa.limbo.work/sandbox/v1/paymentlink/create'
  : 'https://api.picpay.com/v1/paymentlink/create');

let tokenCache = {
  scope: null,
  accessToken: null,
  expiresAt: 0
};

function jsonHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    ...extra
  };
}

function somenteNumeros(value) {
  return String(value || '').replace(/\D/g, '');
}

function limitarTexto(value, limite, fallback = '') {
  const texto = String(value || fallback || '').trim();
  return texto.length > limite ? texto.slice(0, limite) : texto;
}

function limparNomePicPay(value) {
  // A API do checkout aceita letras, espaços, &, e números. Evita caracteres especiais problemáticos.
  return limitarTexto(String(value || 'Cliente Benedictus').replace(/[^\p{L}\d &]/gu, ' ').replace(/\s+/g, ' ').trim(), 255, 'Cliente Benedictus');
}

function normalizarUUID(value) {
  const v = String(value || '').trim();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(v) ? v : crypto.randomUUID();
}

function separarTelefone(raw) {
  let digits = somenteNumeros(raw);
  if (digits.startsWith('55') && digits.length > 11) digits = digits.slice(2);
  if (digits.length >= 10) {
    return {
      countryCode: '55',
      areaCode: digits.slice(0, 2),
      number: digits.slice(2),
      type: 'MOBILE'
    };
  }
  return {
    countryCode: '55',
    areaCode: '83',
    number: digits || '999999999',
    type: 'MOBILE'
  };
}

function limparTextoEndereco(value, fallback = 'Nao informado') {
  return limitarTexto(String(value || fallback).replace(/[^\p{L}\d .'-]/gu, ' ').replace(/\s+/g, ' ').trim(), 120, fallback);
}

function validarPayload(body) {
  const amount = Math.round(Number(body.amount || 0));
  const customer = body.customer || {};
  const shipping = body.shipping || {};

  if (!amount || amount < 1) throw new Error('Valor inválido para o PicPay.');
  if (!customer.name) throw new Error('Nome do cliente é obrigatório.');
  if (!customer.email) throw new Error('E-mail do cliente é obrigatório.');
  if (!somenteNumeros(customer.document)) throw new Error('CPF/CNPJ do cliente é obrigatório.');
  if (!somenteNumeros(customer.phone)) throw new Error('Telefone do cliente é obrigatório.');
  if (!somenteNumeros(shipping.cep)) throw new Error('CEP de entrega é obrigatório.');
  if (!shipping.endereco || !shipping.numero || !shipping.bairro || !shipping.cidade || !shipping.uf) {
    throw new Error('Endereço completo é obrigatório para criar o checkout PicPay.');
  }
}

async function obterToken(scope = 'checkout') {
  const now = Date.now();
  if (tokenCache.scope === scope && tokenCache.accessToken && tokenCache.expiresAt > now + 15000) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.PICPAY_CLIENT_ID;
  const clientSecret = process.env.PICPAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('PICPAY_CLIENT_ID e PICPAY_CLIENT_SECRET não configurados na Netlify.');
  }

  const url = scope === 'payment_link' ? PAYMENT_LINK_AUTH_URL : AUTH_URL;
  const authRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });

  const authText = await authRes.text();
  let authData = {};
  try { authData = authText ? JSON.parse(authText) : {}; }
  catch { authData = { message: authText }; }

  if (!authRes.ok || !authData.access_token) {
    console.error('Erro auth PicPay:', JSON.stringify({ scope, status: authRes.status, data: authData }));
    throw new Error(authData.message || authData.error || 'Falha ao autenticar no PicPay.');
  }

  const expiresIn = Number(authData.expires_in || 300);
  tokenCache = {
    scope,
    accessToken: authData.access_token,
    expiresAt: now + Math.max(60, expiresIn - 20) * 1000
  };

  return authData.access_token;
}

function montarCheckoutPayload(body, merchantChargeId) {
  const customer = body.customer || {};
  const shipping = body.shipping || {};
  const phone = separarTelefone(customer.phone);
  const amount = Math.round(Number(body.amount));
  const shippingAmount = Math.max(0, Math.round(Number(shipping.amount || 0)));
  const document = somenteNumeros(customer.document);

  const payload = {
    merchantChargeId,
    amount,
    description: limitarTexto(body.description || 'Pedido Benedictus Camisaria', 255),
    maxInstallmentNumber: Math.min(Math.max(Number(body.maxInstallmentNumber || 3), 1), 3),
    customer: {
      name: limparNomePicPay(customer.name),
      email: limitarTexto(customer.email, 120),
      documentType: document.length > 11 ? 'CNPJ' : 'CPF',
      document,
      phone
    },
    shippingAddress: {
      street: limparTextoEndereco(shipping.endereco || 'Endereco'),
      number: limparTextoEndereco(shipping.numero || 'S/N'),
      neighborhood: limparTextoEndereco(shipping.bairro || 'Centro'),
      city: limparTextoEndereco(shipping.cidade || 'Mamanguape'),
      state: limitarTexto(String(shipping.uf || 'PB').replace(/[^A-Za-z]/g, '').toUpperCase(), 2, 'PB'),
      country: 'Brasil',
      zipCode: somenteNumeros(shipping.cep),
      complement: shipping.complemento ? limparTextoEndereco(shipping.complemento) : undefined
    },
    threeDomainSecurePolicy: 'ACTIVE',
    lateCapture: false
  };

  if (shippingAmount > 0) payload.shippingAmount = shippingAmount;
  if (!payload.shippingAddress.complement) delete payload.shippingAddress.complement;

  return payload;
}

function montarPaymentLinkPayload(body) {
  const total = Math.round(Number(body.amount || 0));
  const shippingAmount = Math.max(0, Math.round(Number(body?.shipping?.amount || 0)));
  const delivery = Math.min(shippingAmount, Math.max(0, total - 1));
  const product = Math.max(1, total - delivery);
  const installments = Math.min(Math.max(Number(body.maxInstallmentNumber || 3), 1), 3);

  // Formato oficial do PicPay Link de Pagamento:
  // - charge.payment.methods usa BRCODE e CREDIT_CARD
  // - charge.payment.brcode_arrangements habilita PICPAY e PIX dentro do BRCODE
  // - charge.amounts separa produto e entrega em centavos
  // - options é obrigatório para Pix/cartão/parcelamento
  return {
    charge: {
      name: limitarTexto(body.description || 'Pedido Benedictus Camisaria', 80, 'Pedido Benedictus Camisaria'),
      description: limitarTexto(body.description || 'Pedido Benedictus Camisaria', 255, 'Pedido Benedictus Camisaria'),
      payment: {
        methods: ['BRCODE', 'CREDIT_CARD'],
        brcode_arrangements: ['PICPAY', 'PIX']
      },
      amounts: {
        product,
        delivery
      }
    },
    options: {
      allow_create_pix_key: true,
      card_max_installment_number: installments
    }
  };
}

async function criarCheckoutGateway(body, merchantChargeId) {
  const accessToken = await obterToken('checkout');
  const payload = montarCheckoutPayload(body, merchantChargeId);

  console.log('Payload PicPay Checkout:', JSON.stringify({
    ...payload,
    customer: { ...payload.customer, document: '[DOCUMENTO_PRESENTE]' }
  }));

  const res = await fetch(CHECKOUT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { message: text }; }

  if (!res.ok || !data.checkoutUrl) {
    const msg = data.message || data.error || `PicPay Checkout HTTP ${res.status}`;
    const err = new Error(msg);
    err.picpayData = data;
    err.statusCode = res.status;
    throw err;
  }

  return {
    provider: 'picpay_checkout',
    checkoutId: data.id,
    paymentId: data.id,
    paymentUrl: data.checkoutUrl,
    checkoutUrl: data.checkoutUrl,
    merchantChargeId,
    raw: data
  };
}

async function criarPaymentLink(body, merchantChargeId) {
  const accessToken = await obterToken('payment_link');
  const payload = montarPaymentLinkPayload(body);

  console.log('Payload PicPay Payment Link:', JSON.stringify(payload));

  const res = await fetch(PAYMENT_LINK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-Idempotency-Key': merchantChargeId
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { message: text }; }

  const paymentUrl =
    data.checkoutLink ||
    data.paymentUrl ||
    data.checkoutUrl ||
    data.url ||
    data.link ||
    data.data?.checkoutLink ||
    data.data?.paymentUrl ||
    data.data?.url ||
    data.data?.link ||
    data.charge?.checkoutLink ||
    data.charge?.paymentUrl ||
    data.charge?.url ||
    data.charge?.link;

  const paymentLinkId =
    data.paymentLinkId ||
    data.payment_link_id ||
    data.id ||
    data.data?.paymentLinkId ||
    data.data?.payment_link_id ||
    data.data?.id ||
    data.charge?.paymentLinkId ||
    data.charge?.payment_link_id ||
    data.charge?.id;

  if (!res.ok || !paymentUrl) {
    const msg = data.message || data.error || `PicPay Payment Link HTTP ${res.status}`;
    const err = new Error(msg);
    err.picpayData = data;
    err.statusCode = res.status;
    throw err;
  }

  return {
    provider: 'picpay_payment_link',
    paymentLinkId,
    paymentId: paymentLinkId,
    paymentUrl,
    checkoutUrl: paymentUrl,
    merchantChargeId,
    raw: data
  };
}

exports.handler = async (event) => {
  const headers = jsonHeaders();

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    validarPayload(body);

    const merchantChargeId = normalizarUUID(body.merchantChargeId || body.external_reference);

    let result;
    let gatewayError = null;

    if (USE_GATEWAY_CHECKOUT) {
      try {
        result = await criarCheckoutGateway(body, merchantChargeId);
      } catch (err) {
        gatewayError = err;
        console.warn('Falha no Gateway Checkout PicPay. Tentando Payment Link:', JSON.stringify({
          message: err.message,
          statusCode: err.statusCode,
          data: err.picpayData
        }));
        result = await criarPaymentLink(body, merchantChargeId);
      }
    } else {
      result = await criarPaymentLink(body, merchantChargeId);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        ...result,
        webhookUrl: `${SITE_URL}/.netlify/functions/picpay-webhook`,
        environment: IS_SANDBOX ? 'sandbox' : 'production',
        integrationMode: USE_GATEWAY_CHECKOUT ? 'gateway_checkout' : 'payment_link',
        gatewayFallbackReason: gatewayError ? gatewayError.message : null
      })
    };
  } catch (err) {
    console.error('Erro criar checkout PicPay:', err);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        success: false,
        error: err.message || 'Erro ao criar checkout PicPay',
        debug: err.picpayData || undefined,
        environment: IS_SANDBOX ? 'sandbox' : 'production'
      })
    };
  }
};
