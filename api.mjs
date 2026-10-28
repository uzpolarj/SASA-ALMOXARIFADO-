// API de sincronização do Almoxarifado Digital (Netlify Functions + Postgres: Supabase, Neon ou Netlify Database)
// Protegida pela variável de ambiente ALMOX_KEY (a mesma chave é digitada nos aparelhos).
import pg from 'pg';

let pool, ready = false;
const q = async (t, p = []) => (await pool.query(t, p)).rows;
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function init() {
  if (ready) return;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || process.env.NETLIFY_DB_URL || process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  await q('CREATE TABLE IF NOT EXISTS docs(k text PRIMARY KEY, v text, ts double precision)');
  await q('CREATE TABLE IF NOT EXISTS lots(k text PRIMARY KEY, qtd double precision, prod text, lote text, val text, ts double precision)');
  await q('ALTER TABLE docs ENABLE ROW LEVEL SECURITY'); await q('ALTER TABLE lots ENABLE ROW LEVEL SECURITY'); // bloqueia acesso público pela API do Supabase
  ready = true;
}
const upDoc = (k, v, ts) => q('INSERT INTO docs(k,v,ts) VALUES($1,$2,$3) ON CONFLICT(k) DO UPDATE SET v=excluded.v, ts=excluded.ts', [k, v, ts]);

export default async (req) => {
  const key = process.env.ALMOX_KEY;
  if (!key || req.headers.get('x-key') !== key) return J({ error: 'unauthorized' }, 401);
  if (req.method !== 'POST') return J({ error: 'method' }, 405);
  let b; try { b = await req.json(); } catch (e) { return J({ error: 'json' }, 400); }
  try {
    await init();
    const now = Date.now();
    if (b.catalog) { // novo estoque do MV: substitui as quantidades (feito pelo gestor)
      await q('DELETE FROM lots');
      const L = b.catalog.lots || [];
      for (let i = 0; i < L.length; i += 150) {
        const c = L.slice(i, i + 150), p = [];
        const vs = c.map((x, j) => { p.push(x[0], x[1], x[2], x[3], x[4], now); const o = j * 6; return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`; });
        await q('INSERT INTO lots(k,qtd,prod,lote,val,ts) VALUES ' + vs.join(',') + ' ON CONFLICT(k) DO UPDATE SET qtd=excluded.qtd, prod=excluded.prod, lote=excluded.lote, val=excluded.val, ts=excluded.ts', p);
      }
      await upDoc('catv', String(b.catalog.catV || ''), now);
    }
    for (const [k, v] of b.docs || []) await upDoc(k, v, now);               // pedidos, conferências, usuários...: último gravado vence
    for (const [k, d, prod, lote, val] of b.lots || [])                       // saldo de lote: soma atômica da variação
      await q('INSERT INTO lots(k,qtd,prod,lote,val,ts) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(k) DO UPDATE SET qtd=lots.qtd+excluded.qtd, ts=excluded.ts', [k, d, prod, lote, val, now]);
    const since = +b.since || 0;
    const docs = (await q('SELECT k,v,ts FROM docs WHERE ts>$1', [since])).map(r => [r.k, r.v, +r.ts]);
    const lots = (await q('SELECT k,qtd,prod,lote,val,ts FROM lots WHERE ts>$1', [since])).map(r => [r.k, +r.qtd, r.prod, r.lote, r.val, +r.ts]);
    const cv = (await q("SELECT v FROM docs WHERE k='catv'"))[0];
    return J({ now, docs, lots, catV: cv ? cv.v : null });
  } catch (e) { return J({ error: String(e.message || e) }, 500); }
};
export const config = { path: '/api/sync' };
