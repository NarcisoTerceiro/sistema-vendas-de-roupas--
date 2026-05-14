// netlify/functions/criar-pix.js
// Cria um Link de Pagamento PicPay para cartão, Pix e Carteira PicPay.

const PICPAY_AUTH_BASE = 'https://checkout-api.picpay.com';
const PICPAY_PAYMENT_LINK_BASE = 'https://api.picpay.com/v1';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers,
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'Method not allowed'
      })
    };
  }

  try {
    const CLIENT_ID = process.env.PICPAY_CLIENT_ID;
    const CLIENT_SECRET = process.env.PICPAY_CLIENT_SECRET;

    if (!CLIENT_ID || !CLIENT_SECRET) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Credenciais PicPay não configuradas'
        })
      };
    }

    const dados = JSON.parse(event.body || '{}');
    const { amount, customer, pedidoId, items } = dados;

    if (!amount || Number(amount) < 1) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'amount inválido'
        })
      };
    }

    if (!customer?.name || !customer?.email || !customer?.document) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Dados do cliente incompletos'
        })
      };
    }

    // 1. Gerar token PicPay
    const tokenRes = await fetch(`${PICPAY_AUTH_BASE}/oauth2/token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      })
    });

    const tokenText = await tokenRes.text();

    if (!tokenRes.ok) {
      console.error('Auth PicPay falhou:', tokenText);

      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Falha autenticação PicPay',
          debug: tokenText
        })
      };
    }

    const tokenData = JSON.parse(tokenText);
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error('Token PicPay não retornou access_token:', tokenText);

      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Token PicPay inválido',
          debug: tokenData
        })
      };
    }

    // 2. Preparar dados do pedido
    const amountCentavos = Math.round(Number(amount));

    const merchantChargeId = String(pedidoId || `bnd-${Date.now()}`)
      .replace(/[^a-zA-Z0-9-]/g, '')
      .slice(0, 36);

    const nomeCompleto = String(customer.name || '').trim();
    const partesNome = nomeCompleto.split(/\s+/);

    const firstName = partesNome[0] || 'Cliente';
    const lastName = partesNome.slice(1).join(' ') || firstName;

    const itensRecebidos = Array.isArray(items) ? items : [];

    const produtosTotal = itensRecebidos.length > 0
      ? itensRecebidos
          .filter((item) => String(item.name || '').toLowerCase() !== 'frete')
          .reduce((total, item) => {
            const valor = Math.round(Number(item.amount || 0));
            const qtd = Number(item.quantity || 1);
            return total + valor * qtd;
          }, 0)
      : amountCentavos;

    const freteTotal = itensRecebidos.length > 0
      ? itensRecebidos
          .filter((item) => String(item.name || '').toLowerCase() === 'frete')
          .reduce((total, item) => {
            const valor = Math.round(Number(item.amount || 0));
            const qtd = Number(item.quantity || 1);
            return total + valor * qtd;
          }, 0)
      : 0;

    const produtoFinal = produtosTotal > 0 ? produtosTotal : amountCentavos - freteTotal;
    const deliveryFinal = freteTotal > 0 ? freteTotal : 0;

    // 3. Payload correto para Link de Pagamento PicPay
    const payload = {
      seller: {
        merchantChargeId
      },

      buyer: {
        firstName,
        lastName,
        document: String(customer.document).replace(/\D/g, ''),
        email: customer.email
      },

      charge: {
        payment: {
          methods: ['BRCODE', 'CREDIT_CARD'],
          brcode_arrangements: ['PICPAY', 'PIX']
        },

        amounts: {
          product: produtoFinal,
          delivery: deliveryFinal
        }
      },

      options: {
        allow_create_pix_key: true
      }
    };

    console.log('Payload Link de Pagamento PicPay:', JSON.stringify(payload));

    // 4. Criar Link de Pagamento
    const paymentRes = await fetch(`${PICPAY_PAYMENT_LINK_BASE}/paymentlink/create`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify(payload)
    });

    const paymentText = await paymentRes.text();

    let paymentData = {};
    try {
      paymentData = paymentText ? JSON.parse(paymentText) : {};
    } catch {
      paymentData = {
        message: paymentText
      };
    }

    if (!paymentRes.ok) {
      console.error('Erro ao criar Link de Pagamento PicPay:', JSON.stringify(paymentData));

      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          success: false,
          error:
            paymentData.message ||
            paymentData.error ||
            paymentData.errors ||
            JSON.stringify(paymentData),
          debug: paymentData
        })
      };
    }

    console.log('Resposta Link de Pagamento PicPay:', JSON.stringify(paymentData));

    // 5. Tentar localizar a URL do checkout na resposta
    const paymentUrl =
      paymentData.url ||
      paymentData.paymentUrl ||
      paymentData.payment_url ||
      paymentData.checkoutUrl ||
      paymentData.checkout_url ||
      paymentData.link ||
      paymentData.payment_link ||
      paymentData.paymentLink ||
      paymentData.links?.payment ||
      paymentData.links?.checkout ||
      paymentData.links?.self ||
      paymentData.data?.url ||
      paymentData.data?.paymentUrl ||
      paymentData.data?.checkoutUrl ||
      paymentData.data?.link;

    if (!paymentUrl) {
      console.error('PicPay não retornou paymentUrl:', JSON.stringify(paymentData));

      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'PicPay não retornou o link de pagamento',
          debug: paymentData
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        paymentLinkId:
          paymentData.id ||
          paymentData.paymentLinkId ||
          paymentData.payment_link_id ||
          paymentData.data?.id,
        paymentUrl,
        raw: paymentData
      })
    };

  } catch (err) {
    console.error('Erro inesperado:', err);

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