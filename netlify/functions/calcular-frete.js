// netlify/functions/calcular-frete.js
//
// Calcula o frete via API Frenet (REST/JSON).
//
// REGRA DE PACOTE (FIXA — alinhada com o que é usado no app dos Correios
// na hora do despacho):
//   • Dimensões SEMPRE: 9 (alt) × 18 (larg) × 27 (comp) cm
//   • Peso baseado na quantidade de itens do carrinho:
//       - 1 a 5 itens  → 1 kg
//       - 6+ itens     → 2 kg
//
// Por isso o backend ignora qualquer peso/dimensão que vier do frontend
// e calcula o pacote sozinho. O frontend só precisa mandar a quantidade
// total de itens (campo `quantidade` ou `pacote.quantity`).
//
// Docs Frenet: https://api.frenet.com.br/shipping/quote
// Auth: header `token: <SEU_TOKEN>`

exports.handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "ok" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Método não permitido" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { cepDestino, pacote: pacoteCliente, valorDeclarado, quantidade } = body;

    // ─── Valida CEP ──────────────────────────────────────────
    const cepLimpo = (cepDestino || "").replace(/\D/g, "");
    if (!/^\d{8}$/.test(cepLimpo)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "CEP inválido" }),
      };
    }

    // ─── Configurações via ENV ───────────────────────────────
    const TOKEN      = process.env.FRENET_TOKEN;
    const CEP_ORIGEM = (process.env.CEP_ORIGEM || "58280000").replace(/\D/g, "");
    // ServiceCodes Correios na Frenet: 04014 = SEDEX, 04510 = PAC.
    // Vazio = aceita todos os serviços que a Frenet retornar.
    const SERVICOS  = (process.env.FRENET_SERVICOS || "04014,04510")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!TOKEN) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Token Frenet não configurado" }),
      };
    }

    // ─── Quantidade de itens no carrinho ─────────────────────
    // Aceita: body.quantidade (preferencial) ou pacote.quantity.
    // Se não vier nada, assume 1 item (frete mínimo).
    const qtdItens = (() => {
      const candidatos = [
        quantidade,
        pacoteCliente && pacoteCliente.quantity,
        pacoteCliente && pacoteCliente.quantidade,
      ];
      for (const c of candidatos) {
        const n = parseInt(c, 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
      return 1;
    })();

    // ─── Pacote FIXO ─────────────────────────────────────────
    // Mesma caixa que é usada no app dos Correios pra despachar.
    // Peso: 1 kg até 5 itens; 2 kg de 6 em diante.
    const pacote = {
      height: 9,
      width:  18,
      length: 27,
      weight: qtdItens <= 5 ? 1 : 2,
    };

    console.log(
      `Pacote calculado → ${qtdItens} item(ns) | ` +
      `${pacote.height}x${pacote.width}x${pacote.length}cm | ${pacote.weight}kg`
    );

    // Valor declarado (ShipmentInvoiceValue) — afeta cálculo do seguro
    // dos Correios. Se o frontend não mandar, usa 1 (mínimo válido).
    const num = (v, fallback) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const invoiceValue = num(valorDeclarado, 1);

    // Frenet espera um array de itens. Mandamos o pacote já consolidado
    // como um único item (Quantity = 1), porque o peso/dimensão JÁ é o
    // total da caixa, não o peso unitário do produto.
    const shippingItem = {
      Weight:    pacote.weight,
      Length:    pacote.length,
      Height:    pacote.height,
      Width:     pacote.width,
      Diameter:  0,
      SKU:       "CARRINHO",
      Category:  "",
      isFragile: false,
      Quantity:  1,
    };

    // ShippingServiceCode: só envia se for exatamente 1 serviço.
    // Enviar null faz a Frenet retornar erro/lista vazia em algumas versões da API.
    const payload = {
      SellerCEP:            CEP_ORIGEM,
      RecipientCEP:         cepLimpo,
      ShipmentInvoiceValue: invoiceValue,
      ShippingItemArray:    [shippingItem],
      RecipientCountry:     "BR",
      ...(SERVICOS.length === 1 && { ShippingServiceCode: SERVICOS[0] }),
    };

    console.log("Payload Frenet:", JSON.stringify(payload));

    const resp = await fetch("https://api.frenet.com.br/shipping/quote", {
      method: "POST",
      headers: {
        "Accept":       "application/json",
        "Content-Type": "application/json",
        "token":        TOKEN,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Erro Frenet:", resp.status, errText);
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Erro ao consultar Frenet", detalhe: errText }),
      };
    }

    const data = await resp.json();
    console.log("Resposta Frenet:", JSON.stringify(data));

    // Log detalhado para diagnóstico
    const bruto = data?.ShippingSevicesArray || data?.ShippingServicesArray || [];
    bruto.forEach(s => console.log(
      "Servico:", s.ServiceCode, "|", s.Carrier, "|",
      "Erro:", s.Error, "|", "Msg:", s.Msg, "|", "Preco:", s.ShippingPrice
    ));

    // Frenet devolve ShippingSevicesArray (sic, sem o "r" — é assim mesmo).
    const servicos = Array.isArray(data?.ShippingSevicesArray)
      ? data.ShippingSevicesArray
      : Array.isArray(data?.ShippingServicesArray)
        ? data.ShippingServicesArray
        : [];

    const setServicos = new Set(SERVICOS);

    const opcoes = servicos
      .filter((s) => {
        // Remove serviços com erro
        if (s.Error === true || s.Error === "true") return false;
        // Remove sem preço válido
        const preco = parseFloat(String(s.ShippingPrice).replace(",", "."));
        if (!Number.isFinite(preco) || preco <= 0) return false;
        // Filtra pelos ServiceCodes configurados (PAC/SEDEX por padrão).
        // Se a lista estiver vazia, aceita tudo.
        if (setServicos.size > 0 && !setServicos.has(String(s.ServiceCode))) {
          return false;
        }
        return true;
      })
      .map((s) => {
        const valor = parseFloat(String(s.ShippingPrice).replace(",", "."));
        const prazo = parseInt(s.DeliveryTime, 10);
        return {
          codigo:  String(s.ServiceCode || ""),
          nome:    `${s.Carrier || ""} ${s.ServiceDescription || ""}`.trim(),
          empresa: s.Carrier || "",
          servico: s.ServiceDescription || "",
          valor:   valor || 0,
          prazo:   Number.isFinite(prazo) ? prazo : "—",
        };
      })
      .sort((a, b) => a.valor - b.valor);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ opcoes }),
    };

  } catch (err) {
    console.error("Erro inesperado:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Erro interno", detalhe: String(err) }),
    };
  }
};