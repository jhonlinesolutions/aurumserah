import fs from 'fs';
import path from 'path';
import { Redis } from '@upstash/redis';

// Mesma observação do api/kiwify-webhook.js: usando os nomes reais injetados pela
// integração (KV_REST_API_URL / KV_REST_API_TOKEN), não UPSTASH_REDIS_REST_*.
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const VALID_BOOKS = [
  'travessia-de-saray',
  'o-perdao-e-um-fogo-sagrado',
  '21-chaves-do-despertar',
];

function renderDenied() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Acesso não encontrado | Aurum Serah</title>
<meta name="robots" content="noindex, nofollow">
<style>
  body{ background:#0D0906; color:#F3E8D2; font-family: Georgia, serif; min-height:100vh;
        display:flex; align-items:center; justify-content:center; text-align:center; padding:24px; margin:0; }
  .box{ max-width:480px; }
  h1{ color:#E7BE64; font-size:1.6rem; margin-bottom:16px; }
  p{ line-height:1.6; color:#C7B294; }
  a{ color:#E7BE64; }
</style>
</head>
<body>
  <div class="box">
    <h1>Este link não é válido</h1>
    <p>Não encontramos um acesso ativo para este link. Se você comprou recentemente, confira seu e-mail (inclusive a caixa de spam) para o link correto, ou entre em contato pelo suporte da compra.</p>
    <p><a href="https://www.aurumserah.online">Voltar para Aurum Serah</a></p>
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  const { book, token } = req.query;

  if (!VALID_BOOKS.includes(book) || !token) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(404).send(renderDenied());
  }

  const key = `access:${book}:${token}`;
  const raw = await redis.get(key);

  if (!raw) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(404).send(renderDenied());
  }

  // Contabiliza o acesso (opcional, mas útil pra perceber uso anormal de um link)
  try {
    const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
    record.views = (record.views || 0) + 1;
    record.lastAccessAt = new Date().toISOString();
    const ttl = await redis.ttl(key);
    await redis.set(key, JSON.stringify(record), ttl > 0 ? { ex: ttl } : undefined);
  } catch (e) {
    console.warn('Falha ao atualizar contagem de acesso:', e);
  }

  const contentPath = path.join(process.cwd(), 'api', '_content', `${book}.html`);
  let html;
  try {
    html = fs.readFileSync(contentPath, 'utf-8');
  } catch (e) {
    console.error('Arquivo de conteúdo não encontrado:', contentPath, e);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send('Erro ao carregar o conteúdo. Contate o suporte.');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).send(html);
}
