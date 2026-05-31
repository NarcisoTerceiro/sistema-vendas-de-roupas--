// ════════════════════════════════════════════════════════════════════
//  netlify/functions/enviar-notificacoes.js
//  Benedictus Camisaria — Notificações / promoções por e-mail via GMAIL
//
//  Duas ações (campo "action" no corpo da requisição):
//    • "listar"  → devolve TODOS os e-mails cadastrados (deduplicados),
//                  lendo profiles + clientes + pedidos com a SERVICE ROLE
//                  (ignora o RLS, então pega a base inteira).
//    • "enviar"  → dispara o e-mail (assunto + html) para os destinatários,
//                  pelo SMTP do Gmail (Nodemailer).
//
//  ── DEPENDÊNCIA ──
//  Esta função usa o pacote "nodemailer". Garanta que ele esteja instalado.
//  Crie/edite o arquivo  netlify/functions/package.json  com:
//      { "dependencies": { "nodemailer": "^6.9.14" } }
//  (a Netlify instala automaticamente no deploy).
//
//  ── VARIÁVEIS DE AMBIENTE (Netlify → Site settings → Environment variables) ──
//    SUPABASE_URL               = https://lhjnphahbbrsqkcgqdta.supabase.co
//    SUPABASE_SERVICE_ROLE_KEY  = (chave "service_role" do Supabase — SECRETA)
//    GMAIL_USER                 = seuemail@gmail.com
//    GMAIL_APP_PASSWORD         = (Senha de App de 16 letras — veja abaixo)
//    EMAIL_NOME_REMETENTE       = Benedictus Camisaria   (opcional, nome exibido)
//
//  ── COMO GERAR A SENHA DE APP DO GMAIL ──
//    1) A conta precisa ter a Verificacao em 2 etapas ATIVADA.
//    2) Acesse:  https://myaccount.google.com/apppasswords
//    3) Crie uma senha de app (ex.: nome "Benedictus") e copie os 16 caracteres.
//    4) Cole em GMAIL_APP_PASSWORD (pode tirar os espacos). NAO e a sua senha normal.
//
//  ! Limite do Gmail: ~500 e-mails/dia (conta comum) / ~2.000 (Workspace).
//    Para listas grandes, envie em partes ou use um servico de e-mail dedicado.
// ════════════════════════════════════════════════════════════════════

const nodemailer = require('nodemailer');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lhjnphahbbrsqkcgqdta.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GMAIL_USER   = process.env.GMAIL_USER;
const GMAIL_PASS   = process.env.GMAIL_APP_PASSWORD;
const NOME_REMET   = process.env.EMAIL_NOME_REMETENTE || 'Benedictus Camisaria';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

const ok  = (obj)       => ({ statusCode: 200, headers: CORS, body: JSON.stringify(obj) });
const err = (code, msg) => ({ statusCode: code, headers: CORS, body: JSON.stringify({ erro: msg }) });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── le uma tabela do Supabase via REST usando a service role ────────────
async function lerTabela(tabela, colunas) {
  const url = `${SUPABASE_URL}/rest/v1/${tabela}?select=${colunas}`;
  const r = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
  if (!r.ok) { console.warn(`[listar] ${tabela} respondeu ${r.status}`); return []; }
  try { return await r.json(); } catch { return []; }
}

// ── monta a lista unica de destinatarios ────────────────────────────────
async function listarEmails() {
  const [profiles, clientes, pedidos] = await Promise.all([
    lerTabela('profiles', 'email,nome'),
    lerTabela('clientes', 'email,nome'),
    lerTabela('pedidos',  'cliente_email,user_email,cliente_nome')
  ]);

  const mapa = new Map(); // email(min) -> { email, nome, origem }

  const add = (email, nome, origem) => {
    email = (email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return;
    nome = (nome || '').trim();
    if (mapa.has(email)) {
      if (nome && !mapa.get(email).nome) mapa.get(email).nome = nome;
    } else {
      mapa.set(email, { email, nome, origem });
    }
  };

  profiles.forEach(l => add(l.email, l.nome, 'cadastro'));
  clientes.forEach(l => add(l.email, l.nome, 'cliente'));
  pedidos .forEach(l => {
    add(l.cliente_email, l.cliente_nome, 'pedido');
    add(l.user_email,    l.cliente_nome, 'pedido');
  });

  return Array.from(mapa.values()).sort((a, b) => a.email.localeCompare(b.email));
}

// ── transporter do Gmail (pool p/ enviar varios sem reabrir conexao) ──
function criarTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')   return err(405, 'Metodo nao permitido.');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'JSON invalido.'); }

  const action = body.action;

  // ───────────────────────── LISTAR ─────────────────────────
  if (action === 'listar') {
    if (!SERVICE_KEY) return err(500, 'Falta a variavel SUPABASE_SERVICE_ROLE_KEY na Netlify.');
    try {
      const lista = await listarEmails();
      return ok({ total: lista.length, destinatarios: lista });
    } catch (e) {
      console.error(e);
      return err(500, 'Erro ao buscar e-mails: ' + e.message);
    }
  }

  // ───────────────────────── ENVIAR ─────────────────────────
  if (action === 'enviar') {
    if (!GMAIL_USER || !GMAIL_PASS)
      return err(500, 'Falta GMAIL_USER e/ou GMAIL_APP_PASSWORD nas variaveis da Netlify.');

    const assunto = (body.assunto || '').trim();
    const html    = body.html || '';
    let   destinatarios = Array.isArray(body.destinatarios) ? body.destinatarios : null;

    if (!assunto) return err(400, 'Informe o assunto do e-mail.');
    if (!html)    return err(400, 'O conteudo do e-mail esta vazio.');

    if (!destinatarios || !destinatarios.length) {
      if (!SERVICE_KEY) return err(500, 'Falta SUPABASE_SERVICE_ROLE_KEY para buscar a base.');
      destinatarios = await listarEmails();
    }

    const vistos = new Set();
    const fila = [];
    for (const d of destinatarios) {
      const email = (typeof d === 'string' ? d : d?.email || '').trim().toLowerCase();
      const nome  = typeof d === 'object' ? (d?.nome || '') : '';
      if (!EMAIL_RE.test(email) || vistos.has(email)) continue;
      vistos.add(email);
      fila.push({ email, nome });
    }
    if (!fila.length) return err(400, 'Nenhum e-mail valido na lista.');

    const montarHtml = (d) =>
      html.replace(/\{\{\s*nome\s*\}\}/gi, d.nome ? d.nome.split(' ')[0] : 'Cliente');

    const transporter = criarTransporter();
    try { await transporter.verify(); }
    catch (e) {
      return err(500, 'Nao foi possivel conectar ao Gmail. Confira GMAIL_USER e a Senha de App. (' + e.message + ')');
    }

    const from = `"${NOME_REMET}" <${GMAIL_USER}>`;
    let enviados = 0;
    const falhas = [];

    const LOTE = 3; // concorrencia limitada p/ caber no tempo da funcao
    for (let i = 0; i < fila.length; i += LOTE) {
      const grupo = fila.slice(i, i + LOTE);
      const res = await Promise.allSettled(grupo.map(d =>
        transporter.sendMail({ from, to: d.email, subject: assunto, html: montarHtml(d) })
      ));
      res.forEach((r, idx) => {
        if (r.status === 'fulfilled') enviados++;
        else falhas.push({ email: grupo[idx].email, erro: r.reason?.message || 'erro' });
      });
    }

    transporter.close();

    return ok({
      enviados,
      total: fila.length,
      falhas: falhas.slice(0, 50),
      sucesso: falhas.length === 0,
      provedor: 'gmail'
    });
  }

  return err(400, 'Acao desconhecida. Use "listar" ou "enviar".');
};