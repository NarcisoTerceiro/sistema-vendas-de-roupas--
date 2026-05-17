// netlify/functions/mercadopago-webhook.js
// Recebe notificações de pagamento do Mercado Pago e atualiza pedidos no Supabase.

const MP_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  try {
    console.log('Webhook Mercado Pago recebido. Body:', event.body);
    console.log('Query:', JSON.stringify(event.queryStringParameters || {}));

    const body = JSON.parse(event.body || '{}');
    const query = event.queryStringParameters || {};

    const paymentId =
      body?.data?.id ||
      body?.id ||
      query['data.id'] ||
      query.id ||
      (typeof body?.resource === 'string' ? body.resource.split('/').pop() : null);

    const eventType = body?.type || body?.topic || query.type || query.topic;

    if (!paymentId) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, ignored: true, reason: 'Sem paymentId' }) };
    }

    if (eventType && !String(eventType).includes('payment')) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, ignored: true, reason: 'Evento não é payment' }) };
    }

    if (!MP_ACCESS_TOKEN) {
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'MERCADOPAGO_ACCESS_TOKEN não configurado' }) };
    }

    const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
    });

    const paymentText = await paymentRes.text();
    let payment = {};

    try { payment = paymentText ? JSON.parse(paymentText) : {}; }
    catch { payment = { message: paymentText }; }

    if (!paymentRes.ok) {
      console.error('Erro ao consultar pagamento MP:', paymentText);
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Erro ao consultar pagamento', debug: payment }) };
    }

    const externalReference = payment.external_reference;
    const mpStatus = payment.status;

    let novoStatus = 'aguardando_pagamento';
    if (mpStatus === 'approved') novoStatus = 'pago';
    if (mpStatus === 'rejected') novoStatus = 'recusado';
    if (mpStatus === 'cancelled') novoStatus = 'cancelado';
    if (mpStatus === 'refunded') novoStatus = 'estornado';
    if (mpStatus === 'charged_back') novoStatus = 'chargeback';
    if (mpStatus === 'in_process') novoStatus = 'em_analise';
    if (mpStatus === 'pending') novoStatus = 'aguardando_pagamento';

    console.log('Pagamento Mercado Pago consultado:', JSON.stringify({ paymentId, externalReference, mpStatus, novoStatus }));

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.warn('Supabase não configurado. Pagamento consultado, mas pedido não atualizado.');
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, warning: 'Supabase não configurado', paymentId, externalReference, status: novoStatus }) };
    }

    if (!externalReference) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, ignored: true, reason: 'Pagamento sem external_reference' }) };
    }

    const updateBody = {
      status: novoStatus,
      mercado_pago_payment_id: String(payment.id),
      mercado_pago_status: payment.status,
      mercado_pago_status_detail: payment.status_detail,
      mercado_pago_payment_method_id: payment.payment_method_id,
      mercado_pago_payment_type_id: payment.payment_type_id,
      mercado_pago_payload: payment,
      updated_at: new Date().toISOString()
    };

    if (novoStatus === 'pago') updateBody.pago_em = new Date().toISOString();

    const supabaseRes = await fetch(
      `${SUPABASE_URL}/rest/v1/pedidos?external_reference=eq.${encodeURIComponent(externalReference)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify(updateBody)
      }
    );

    const supabaseText = await supabaseRes.text();

    if (!supabaseRes.ok) {
      console.error('Erro ao atualizar pedido no Supabase:', supabaseText);
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Erro ao atualizar pedido', debug: supabaseText }) };
    }

    console.log('Pedido atualizado via Mercado Pago:', supabaseText);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, paymentId, externalReference, status: novoStatus }) };
  } catch (err) {
    console.error('Erro webhook Mercado Pago:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Erro interno', debug: String(err?.message || err) }) };
  }
};
