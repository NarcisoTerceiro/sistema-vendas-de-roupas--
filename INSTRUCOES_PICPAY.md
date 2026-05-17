# Configuração PicPay Empresas — Benedictus Camisaria

Este projeto foi ajustado para deixar o Mercado Pago em standby e usar o PicPay Empresas como fluxo principal de pagamento.

## 1. Variáveis na Netlify

Configure em **Site configuration > Environment variables**:

```env
PICPAY_CLIENT_ID=cole_aqui_o_client_id_do_picpay
PICPAY_CLIENT_SECRET=cole_aqui_o_client_secret_do_picpay
PICPAY_WEBHOOK_TOKEN=cole_aqui_o_token_gerado_no_painel_do_webhook_picpay
PICPAY_ENV=production
PICPAY_INTEGRATION_MODE=payment_link
SITE_URL=https://benedictuscamisaria.com.br
SUPABASE_URL=sua_url_do_supabase
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key_do_supabase
```

Observações:

- `PICPAY_CLIENT_ID` e `PICPAY_CLIENT_SECRET` são usados somente no backend, dentro das Netlify Functions.
- `PICPAY_WEBHOOK_TOKEN` precisa ser igual ao token gerado pelo PicPay no cadastro do webhook.
- `SUPABASE_SERVICE_ROLE_KEY` não deve ir para o frontend. Ela fica apenas na Netlify.
- O Mercado Pago continua no projeto em standby, mas o checkout principal agora é PicPay.

## 2. URL do webhook no painel PicPay

Cadastrar no painel PicPay:

```txt
https://benedictuscamisaria.com.br/.netlify/functions/picpay-webhook
```

Use HTTPS, sem parâmetro de consulta na URL.

## 3. Como o fluxo ficou

1. Cliente fecha o pedido no site.
2. O frontend chama `/.netlify/functions/criar-picpay-checkout`.
3. A função cria o checkout no PicPay e devolve a URL de pagamento.
4. O pedido é salvo no Supabase como `aguardando_pagamento`.
5. O cliente paga no PicPay.
6. O PicPay chama `/.netlify/functions/picpay-webhook`.
7. O webhook valida o token, localiza o pedido e atualiza o status no Supabase.
8. A tela do cliente consulta `/.netlify/functions/pedido-status` e mostra a confirmação quando o pedido virar `pago`.

## 4. Teste recomendado

Depois do deploy:

1. Faça uma compra de baixo valor.
2. Abra os logs da Netlify.
3. Verifique se `criar-picpay-checkout` retornou `success: true`.
4. Após pagar, confirme se `picpay-webhook` recebeu o evento.
5. Confira se o pedido no Supabase mudou para `pago`.

## 5. Arquivos alterados/adicionados

- `index.html`
- `netlify/functions/criar-picpay-checkout.js`
- `netlify/functions/picpay-webhook.js`
- `netlify/functions/pedido-status.js`
- `INSTRUCOES_PICPAY.md`


## Correção adicional: fallback caso o webhook não dispare

Nesta versão, a confirmação não depende somente do webhook. A função `pedido-status.js` agora também consulta a API do PicPay quando o pedido ainda estiver pendente. Assim:

1. O webhook continua sendo o caminho principal.
2. Se o webhook não chegar, a tela do cliente chama `/.netlify/functions/pedido-status?id=...` a cada alguns segundos.
3. Essa função consulta o Supabase e também consulta o PicPay pelo `merchantChargeId` ou `paymentLinkId`.
4. Se o PicPay retornar pago, a função atualiza o pedido no Supabase e a tela mostra a confirmação.

### Conferências obrigatórias no PicPay

Cadastre exatamente esta URL no Painel Lojista:

```txt
https://benedictuscamisaria.com.br/.netlify/functions/picpay-webhook
```

A URL precisa ser HTTPS, sem parâmetros e sem barra extra no final.

### Conferências obrigatórias na Netlify

Confirme estas variáveis:

```env
PICPAY_CLIENT_ID=...
PICPAY_CLIENT_SECRET=...
PICPAY_WEBHOOK_TOKEN=token_gerado_ao_salvar_a_url_no_picpay
PICPAY_ENV=production
PICPAY_INTEGRATION_MODE=payment_link
SITE_URL=https://benedictuscamisaria.com.br
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Se o `PICPAY_WEBHOOK_TOKEN` estiver incorreto, o webhook será recusado com HTTP 401. O token correto é a chave/API Key gerada pelo PicPay no momento em que a URL de notificação é salva no painel.


## Correção aplicada nesta versão

Os logs anteriores mostravam dois problemas distintos:

1. `Missing required scope` no Gateway Checkout do PicPay: a conta/credencial usada não possui o escopo necessário para criar checkout via endpoint de Gateway. Por isso, o fluxo principal foi alterado para **Link de Pagamento**. O Gateway só será usado se você definir `PICPAY_INTEGRATION_MODE=gateway` na Netlify.

2. Erro HTTP 422 no Payment Link: o payload antigo usava campos como `paymentMethods` e `maxInstallmentNumber`, mas o endpoint `/paymentlink/create` espera os dados dentro de `charge.payment`, `charge.amounts` e `options`. Agora o payload enviado segue o formato:

```json
{
  "charge": {
    "name": "Pedido Benedictus Camisaria",
    "description": "Pedido Benedictus Camisaria",
    "payment": {
      "methods": ["BRCODE", "CREDIT_CARD"],
      "brcode_arrangements": ["PICPAY", "PIX"]
    },
    "amounts": {
      "product": 1999,
      "delivery": 100
    }
  },
  "options": {
    "allow_create_pix_key": true,
    "card_max_installment_number": 3
  }
}
```

Com isso, o PicPay deve criar o link de pagamento com Pix, cartão e carteira PicPay, conforme habilitação da sua conta.
