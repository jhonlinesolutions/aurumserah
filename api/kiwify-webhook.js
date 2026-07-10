import crypto from 'crypto';
import { Redis } from '@upstash/redis';
import { Resend } from 'resend';

// A integração Redis da Vercel (via Marketplace/Upstash) injeta as credenciais como
// KV_REST_API_URL / KV_REST_API_TOKEN (nome legado do antigo "Vercel KV"). Se no seu
// projeto os nomes vierem diferentes (ex: UPSTASH_REDIS_REST_URL), ajuste as duas
// linhas abaixo pra bater com o que aparece em Settings -> Environments -> Production.
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const resend = new Resend(process.env.RESEND_API_KEY);

// ============================================================
// CONFIGURAÇÃO — Product IDs reais da Kiwify.
// Cada produto aponta para uma LISTA de livros — a maioria tem só um item,
// a Trilogia aponta pros 3.
// ============================================================
const PRODUCT_MAP = {
  '4a3c4b2f-d06c-40c6-9754-f4ba11a5143f': ['travessia-de-saray'], // TEMPORÁRIO - remover depois do teste
  '5ee20530-7963-11f1-9e23-ff1f234c7630': ['travessia-de-saray'],
  '51e4c6d0-799d-11f1-943e-2b460b88104a': ['o-perdao-e-um-fogo-sagrado'],
  '016b0d70-799f-11f1-9e25-9f8bec3d92fc': ['21-chaves-do-despertar'],
  '46d15c10-79a0-11f1-aa00-4b04cb54474b': [
    'travessia-de-saray',
    'o-perdao-e-um-fogo-sagrado',
    '21-chaves-do-despertar',
  ], // Trilogia Despertada 777
};

const BOOK_TITLES = {
  'travessia-de-saray': 'Travessia de Saray',
  'o-perdao-e-um-fogo-sagrado': 'O Perdão é um Fogo Sagrado',
  '21-chaves-do-despertar': '21 Chaves do Despertar',
};

// Validade do acesso (1 ano). Depois disso o link para de funcionar.
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;

// ============================================================
// Extração de campos do payload da Kiwify.
// ATENÇÃO: os nomes de campo abaixo são a melhor estimativa com base
// na documentação pública — a Kiwify não publica um schema fixo e
// completo. Na primeira venda de teste (botão "Testar Webhook" no
// painel da Kiwify), confira os logs desta function na Vercel e
// ajuste as funções abaixo se os campos não baterem.
// ============================================================
function extractEmail(body) {
  return (
    body?.Customer?.email ||
    body?.customer?.email ||
    body?.customer_email ||
    body?.email ||
    null
  );
}

function extractProductId(body) {
  return (
    body?.Product?.product_id ||
    body?.product?.product_id ||
    body?.product_id ||
    body?.Product?.id ||
    null
  );
}

function extractOrderStatus(body) {
  return (
    body?.order_status ||
    body?.Order?.order_status ||
    body?.status ||
    null
  );
}

async function revokeAccess(book, email) {
  const indexKey = `access-by-email:${book}:${email.toLowerCase()}`;
  const token = await redis.get(indexKey);
  if (!token) {
    console.log('Revogação: nenhum token encontrado para', book, email);
    return false;
  }
  await redis.del(`access:${book}:${token}`);
  await redis.del(indexKey);
  console.log('Acesso revogado:', book, email);
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verificação de segurança: o segredo precisa estar na URL do webhook
  // cadastrada na Kiwify, ex:
  // https://www.aurumserah.online/api/kiwify-webhook?secret=SEU_SEGREDO_AQUI
  if (req.query.secret !== process.env.KIWIFY_WEBHOOK_SECRET) {
    console.warn('Kiwify webhook: secret inválido ou ausente');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body;

  // Log bruto — confira nos logs da Vercel (Deployments -> Functions) na
  // primeira venda de teste, pra validar se extractEmail/extractProductId
  // estão pegando os campos certos.
  console.log('Kiwify webhook payload recebido:', JSON.stringify(body));

  const status = String(extractOrderStatus(body) || '').toLowerCase();
  const email = extractEmail(body);
  const productId = extractProductId(body);

  if (!email || !productId) {
    console.error('Não foi possível extrair email/productId do payload. Veja o log acima e ajuste extractEmail/extractProductId neste arquivo.');
    return res.status(400).json({ error: 'Missing email or product id in payload' });
  }

  const books = PRODUCT_MAP[productId];
  if (!books || !books.length) {
    console.error('Product ID não mapeado em PRODUCT_MAP:', productId);
    return res.status(400).json({ error: 'Unknown product id', productId });
  }

  // Estimativa dos nomes de status — confira no log ao testar os eventos
  // "Compra reembolsada" e "Chargeback" no painel da Kiwify e ajuste se necessário.
  const REFUND_STATUSES = ['refunded', 'compra_reembolsada', 'refund', 'chargeback', 'chargedback'];
  const APPROVED_STATUSES = ['paid', 'approved', 'compra_aprovada'];

  if (REFUND_STATUSES.includes(status)) {
    const results = await Promise.all(books.map((book) => revokeAccess(book, email)));
    return res.status(200).json({ revoked: results });
  }

  if (status && !APPROVED_STATUSES.includes(status)) {
    console.log('Webhook ignorado — status não tratado:', status);
    return res.status(200).json({ ignored: true, reason: 'status not handled' });
  }

  // Gera um token independente para cada livro do produto (1 para livro avulso, 3 para a Trilogia)
  const grants = await Promise.all(books.map(async (book) => {
    const token = crypto.randomBytes(24).toString('hex');

    await redis.set(
      `access:${book}:${token}`,
      JSON.stringify({ email, book, createdAt: new Date().toISOString(), views: 0 }),
      { ex: TOKEN_TTL_SECONDS }
    );
    // Índice reverso email -> token, usado pra revogar o acesso em caso de reembolso/chargeback.
    await redis.set(
      `access-by-email:${book}:${email.toLowerCase()}`,
      token,
      { ex: TOKEN_TTL_SECONDS }
    );

    return {
      book,
      title: BOOK_TITLES[book],
      url: `https://www.aurumserah.online/livros/${book}/${token}`,
    };
  }));

  const isBundle = grants.length > 1;
  const subject = isBundle
    ? 'Seus acessos: Trilogia Despertada 777'
    : `Seu acesso: ${grants[0].title}`;

  const bodyText = isBundle
    ? `Olá,

Sua compra da Trilogia Despertada 777 foi confirmada! Aqui estão seus acessos pessoais e exclusivos, um link por livro:

${grants.map((g) => `${g.title}:\n${g.url}`).join('\n\n')}

Guarde esses links com carinho — cada um é único, pessoal, e não deve ser compartilhado.

Boa leitura,
Aurum Serah`
    : `Olá,

Sua compra foi confirmada! Aqui está o seu acesso pessoal e exclusivo a "${grants[0].title}":

${grants[0].url}

Guarde este link com carinho — ele é único, pessoal, e não deve ser compartilhado.

Boa leitura,
Aurum Serah`;

  try {
    await resend.emails.send({
      from: 'Aurum Serah <info@aurumserah.online>',
      to: email,
      subject,
      text: bodyText,
    });
  } catch (err) {
    console.error('Falha ao enviar e-mail via Resend:', err);
    // Não retorna erro pra Kiwify por causa disso — os tokens já foram gerados
    // e os links podem ser reenviados manualmente se precisar (ficam salvos no Redis).
  }

  return res.status(200).json({ success: true, books });
}
