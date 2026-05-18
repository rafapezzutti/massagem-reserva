const express = require('express');
const { Pool }  = require('pg');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Banco de Dados (PostgreSQL — Neon ou qualquer Postgres) ─────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Helpers assíncronos
const q    = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const qOne = (sql, p = []) => pool.query(sql, p).then(r => r.rows[0] || null);
const qRun = (sql, p = []) => pool.query(sql, p);

// Criação das tabelas (roda uma vez na inicialização)
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quartos (
      id                SERIAL PRIMARY KEY,
      nome              TEXT NOT NULL,
      numero            INTEGER NOT NULL UNIQUE,
      tem_hidromassagem INTEGER NOT NULL DEFAULT 0,
      criado_em         TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS profissionais (
      id               SERIAL PRIMARY KEY,
      nome             TEXT NOT NULL,
      data_nascimento  TEXT NOT NULL,
      cpf              TEXT NOT NULL UNIQUE,
      email            TEXT,
      telefone         TEXT NOT NULL,
      nome_fantasia    TEXT,
      ativo            INTEGER NOT NULL DEFAULT 1,
      criado_em        TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS massagens (
      id        SERIAL PRIMARY KEY,
      nome      TEXT NOT NULL,
      descricao TEXT,
      duracao   INTEGER NOT NULL,
      preco     NUMERIC(10,2) NOT NULL,
      ativa     INTEGER NOT NULL DEFAULT 1,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reservas (
      id               SERIAL PRIMARY KEY,
      data             TEXT NOT NULL,
      hora_inicio      TEXT NOT NULL,
      hora_fim         TEXT NOT NULL,
      quarto_id        INTEGER NOT NULL REFERENCES quartos(id),
      profissional_id  INTEGER NOT NULL REFERENCES profissionais(id),
      massagem_id      INTEGER NOT NULL REFERENCES massagens(id),
      cliente_nome     TEXT NOT NULL,
      cliente_telefone TEXT,
      status           TEXT NOT NULL DEFAULT 'confirmada',
      observacoes      TEXT,
      criado_em        TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  console.log('✅ Banco de dados pronto');
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helper de rota ───────────────────────────────────────────────────────────
async function send(res, fn) {
  try {
    const result = await fn();
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: err.message });
  }
}

// ─── QUARTOS ──────────────────────────────────────────────────────────────────
app.get('/api/quartos', (req, res) =>
  send(res, () => q('SELECT * FROM quartos ORDER BY numero')));

app.post('/api/quartos', (req, res) =>
  send(res, async () => {
    const { nome, tem_hidromassagem } = req.body;
    if (!nome) throw new Error('Nome é obrigatório');
    const last   = await qOne('SELECT COALESCE(MAX(numero), 0) AS n FROM quartos');
    const numero = (parseInt(last.n) || 0) + 1;
    return qOne(
      'INSERT INTO quartos (nome, numero, tem_hidromassagem) VALUES ($1,$2,$3) RETURNING *',
      [nome.trim(), numero, tem_hidromassagem ? 1 : 0]
    );
  }));

app.put('/api/quartos/:id', (req, res) =>
  send(res, async () => {
    const { nome, tem_hidromassagem } = req.body;
    if (!nome) throw new Error('Nome é obrigatório');
    return qOne(
      'UPDATE quartos SET nome=$1, tem_hidromassagem=$2 WHERE id=$3 RETURNING *',
      [nome.trim(), tem_hidromassagem ? 1 : 0, req.params.id]
    );
  }));

app.delete('/api/quartos/:id', (req, res) =>
  send(res, async () => {
    const r = await qOne(
      "SELECT COUNT(*) AS c FROM reservas WHERE quarto_id=$1 AND status!='cancelada'",
      [req.params.id]
    );
    if (parseInt(r.c) > 0) throw new Error('Quarto possui reservas ativas. Cancele-as primeiro.');
    await qRun('DELETE FROM quartos WHERE id=$1', [req.params.id]);
    return { id: parseInt(req.params.id) };
  }));

// ─── PROFISSIONAIS ────────────────────────────────────────────────────────────
app.get('/api/profissionais', (req, res) =>
  send(res, () => {
    const filtro = req.query.todos === '1' ? '' : 'WHERE ativo = 1';
    return q(`SELECT * FROM profissionais ${filtro} ORDER BY nome`);
  }));

app.post('/api/profissionais', (req, res) =>
  send(res, async () => {
    const { nome, data_nascimento, cpf, email, telefone, nome_fantasia } = req.body;
    if (!nome)            throw new Error('Nome é obrigatório');
    if (!data_nascimento) throw new Error('Data de nascimento é obrigatória');
    if (!cpf)             throw new Error('CPF é obrigatório');
    if (!telefone)        throw new Error('Telefone é obrigatório');
    const cpfLimpo = cpf.replace(/\D/g, '');
    return qOne(
      `INSERT INTO profissionais (nome, data_nascimento, cpf, email, telefone, nome_fantasia)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nome.trim(), data_nascimento, cpfLimpo, email||null, telefone.trim(), nome_fantasia||null]
    );
  }));

app.put('/api/profissionais/:id', (req, res) =>
  send(res, async () => {
    const { nome, data_nascimento, cpf, email, telefone, nome_fantasia, ativo } = req.body;
    if (!nome)            throw new Error('Nome é obrigatório');
    if (!data_nascimento) throw new Error('Data de nascimento é obrigatória');
    if (!cpf)             throw new Error('CPF é obrigatório');
    if (!telefone)        throw new Error('Telefone é obrigatório');
    const cpfLimpo = cpf.replace(/\D/g, '');
    return qOne(
      `UPDATE profissionais SET nome=$1, data_nascimento=$2, cpf=$3, email=$4,
       telefone=$5, nome_fantasia=$6, ativo=$7 WHERE id=$8 RETURNING *`,
      [nome.trim(), data_nascimento, cpfLimpo, email||null, telefone.trim(),
       nome_fantasia||null, ativo !== undefined ? (ativo ? 1 : 0) : 1, req.params.id]
    );
  }));

app.delete('/api/profissionais/:id', (req, res) =>
  send(res, async () => {
    await qRun('UPDATE profissionais SET ativo=0 WHERE id=$1', [req.params.id]);
    return { id: parseInt(req.params.id) };
  }));

// ─── MASSAGENS ────────────────────────────────────────────────────────────────
app.get('/api/massagens', (req, res) =>
  send(res, () => {
    const filtro = req.query.todas === '1' ? '' : 'WHERE ativa = 1';
    return q(`SELECT * FROM massagens ${filtro} ORDER BY nome`);
  }));

app.post('/api/massagens', (req, res) =>
  send(res, async () => {
    const { nome, descricao, duracao, preco } = req.body;
    if (!nome)                     throw new Error('Nome é obrigatório');
    if (!duracao || duracao <= 0)  throw new Error('Duração inválida');
    if (preco === undefined || preco < 0) throw new Error('Preço inválido');
    return qOne(
      'INSERT INTO massagens (nome, descricao, duracao, preco) VALUES ($1,$2,$3,$4) RETURNING *',
      [nome.trim(), descricao||null, parseInt(duracao), parseFloat(preco)]
    );
  }));

app.put('/api/massagens/:id', (req, res) =>
  send(res, async () => {
    const { nome, descricao, duracao, preco, ativa } = req.body;
    if (!nome)                     throw new Error('Nome é obrigatório');
    if (!duracao || duracao <= 0)  throw new Error('Duração inválida');
    if (preco === undefined || preco < 0) throw new Error('Preço inválido');
    return qOne(
      'UPDATE massagens SET nome=$1, descricao=$2, duracao=$3, preco=$4, ativa=$5 WHERE id=$6 RETURNING *',
      [nome.trim(), descricao||null, parseInt(duracao), parseFloat(preco),
       ativa !== undefined ? (ativa ? 1 : 0) : 1, req.params.id]
    );
  }));

app.delete('/api/massagens/:id', (req, res) =>
  send(res, async () => {
    await qRun('UPDATE massagens SET ativa=0 WHERE id=$1', [req.params.id]);
    return { id: parseInt(req.params.id) };
  }));

// ─── RESERVAS ─────────────────────────────────────────────────────────────────
const RESERVA_JOIN = `
  SELECT r.*,
    q.nome  AS quarto_nome,  q.numero AS quarto_numero, q.tem_hidromassagem,
    p.nome  AS profissional_nome, p.nome_fantasia,
    m.nome  AS massagem_nome, m.duracao AS massagem_duracao, m.preco AS massagem_preco
  FROM reservas r
  JOIN quartos      q ON r.quarto_id       = q.id
  JOIN profissionais p ON r.profissional_id = p.id
  JOIN massagens    m ON r.massagem_id     = m.id
`;

// IMPORTANTE: rota específica ANTES das rotas com :id
app.get('/api/reservas/resumo-mensal', (req, res) =>
  send(res, async () => {
    const { mes, ano } = req.query;
    if (!mes || !ano) throw new Error('Mês e ano são obrigatórios');
    const prefixo = `${ano}-${mes.padStart(2, '0')}`;
    return q(`
      SELECT data,
        COUNT(*)                                              AS total,
        SUM(CASE WHEN status='confirmada' THEN 1 ELSE 0 END) AS confirmadas,
        SUM(CASE WHEN status='concluida'  THEN 1 ELSE 0 END) AS concluidas,
        SUM(CASE WHEN status='cancelada'  THEN 1 ELSE 0 END) AS canceladas
      FROM reservas WHERE data LIKE $1 GROUP BY data ORDER BY data
    `, [`${prefixo}%`]);
  }));

app.get('/api/reservas', (req, res) =>
  send(res, async () => {
    if (req.query.data) {
      return q(`${RESERVA_JOIN} WHERE r.data=$1 ORDER BY r.hora_inicio, q.numero`,
               [req.query.data]);
    }
    if (req.query.mes && req.query.ano) {
      const prefixo = `${req.query.ano}-${req.query.mes.padStart(2, '0')}`;
      return q(`${RESERVA_JOIN} WHERE r.data LIKE $1 ORDER BY r.data, r.hora_inicio`,
               [`${prefixo}%`]);
    }
    return q(`${RESERVA_JOIN} ORDER BY r.data DESC, r.hora_inicio`);
  }));

app.post('/api/reservas', (req, res) =>
  send(res, async () => {
    const { data, hora_inicio, hora_fim, quarto_id, profissional_id,
            massagem_id, cliente_nome, cliente_telefone, observacoes } = req.body;
    if (!data)          throw new Error('Data é obrigatória');
    if (!hora_inicio || !hora_fim) throw new Error('Horário é obrigatório');
    if (!quarto_id)     throw new Error('Quarto é obrigatório');
    if (!profissional_id) throw new Error('Profissional é obrigatório');
    if (!massagem_id)   throw new Error('Massagem é obrigatória');
    if (!cliente_nome)  throw new Error('Nome do cliente é obrigatório');

    const cQ = await qOne(
      `SELECT id FROM reservas WHERE quarto_id=$1 AND data=$2 AND status!='cancelada'
       AND hora_inicio < $3 AND hora_fim > $4`,
      [quarto_id, data, hora_fim, hora_inicio]
    );
    if (cQ) throw new Error('Quarto já reservado neste horário');

    const cP = await qOne(
      `SELECT id FROM reservas WHERE profissional_id=$1 AND data=$2 AND status!='cancelada'
       AND hora_inicio < $3 AND hora_fim > $4`,
      [profissional_id, data, hora_fim, hora_inicio]
    );
    if (cP) throw new Error('Profissional já tem reserva neste horário');

    const nova = await qOne(
      `INSERT INTO reservas (data, hora_inicio, hora_fim, quarto_id, profissional_id,
         massagem_id, cliente_nome, cliente_telefone, observacoes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [data, hora_inicio, hora_fim, quarto_id, profissional_id, massagem_id,
       cliente_nome.trim(), cliente_telefone||null, observacoes||null]
    );
    return qOne(`${RESERVA_JOIN} WHERE r.id=$1`, [nova.id]);
  }));

app.put('/api/reservas/:id', (req, res) =>
  send(res, async () => {
    const id = parseInt(req.params.id);
    const { data, hora_inicio, hora_fim, quarto_id, profissional_id,
            massagem_id, cliente_nome, cliente_telefone, status, observacoes } = req.body;
    if (!data)         throw new Error('Data é obrigatória');
    if (!hora_inicio || !hora_fim) throw new Error('Horário é obrigatório');
    if (!cliente_nome) throw new Error('Nome do cliente é obrigatório');

    if (status !== 'cancelada') {
      const cQ = await qOne(
        `SELECT id FROM reservas WHERE quarto_id=$1 AND data=$2 AND id!=$3
         AND status!='cancelada' AND hora_inicio < $4 AND hora_fim > $5`,
        [quarto_id, data, id, hora_fim, hora_inicio]
      );
      if (cQ) throw new Error('Quarto já reservado neste horário');

      const cP = await qOne(
        `SELECT id FROM reservas WHERE profissional_id=$1 AND data=$2 AND id!=$3
         AND status!='cancelada' AND hora_inicio < $4 AND hora_fim > $5`,
        [profissional_id, data, id, hora_fim, hora_inicio]
      );
      if (cP) throw new Error('Profissional já tem reserva neste horário');
    }

    await qRun(
      `UPDATE reservas SET data=$1, hora_inicio=$2, hora_fim=$3, quarto_id=$4,
       profissional_id=$5, massagem_id=$6, cliente_nome=$7, cliente_telefone=$8,
       status=$9, observacoes=$10 WHERE id=$11`,
      [data, hora_inicio, hora_fim, quarto_id, profissional_id, massagem_id,
       cliente_nome.trim(), cliente_telefone||null, status||'confirmada',
       observacoes||null, id]
    );
    return qOne(`${RESERVA_JOIN} WHERE r.id=$1`, [id]);
  }));

app.delete('/api/reservas/:id', (req, res) =>
  send(res, async () => {
    await qRun("UPDATE reservas SET status='cancelada' WHERE id=$1", [req.params.id]);
    return { id: parseInt(req.params.id) };
  }));

// ─── Start ────────────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`\n💆 Massagem Reserva rodando em http://localhost:${PORT}\n`));
  })
  .catch(err => {
    console.error('Erro ao conectar ao banco:', err.message);
    process.exit(1);
  });
