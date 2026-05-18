const express = require('express');
const { Pool } = require('pg');
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'mr-secret-unimidia-2024';

// ─── Pool PostgreSQL ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const q    = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const qOne = (sql, p = []) => pool.query(sql, p).then(r => r.rows[0] || null);
const qRun = (sql, p = []) => pool.query(sql, p);

// ─── Inicialização do banco ───────────────────────────────────────────────────
async function initDB() {
  // 1. Tabelas de autenticação
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clinicas (
      id                SERIAL PRIMARY KEY,
      nome              TEXT NOT NULL,
      email             TEXT NOT NULL UNIQUE,
      senha_hash        TEXT NOT NULL,
      telefone          TEXT,
      endereco          TEXT,
      emails_adicionais TEXT,
      ativo             INTEGER NOT NULL DEFAULT 1,
      criado_em         TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS admins (
      id         SERIAL PRIMARY KEY,
      nome       TEXT NOT NULL,
      email      TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      ativo      INTEGER NOT NULL DEFAULT 1,
      criado_em  TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // 2. Tabelas de dados
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quartos (
      id                SERIAL PRIMARY KEY,
      nome              TEXT NOT NULL,
      numero            INTEGER NOT NULL,
      tem_hidromassagem INTEGER NOT NULL DEFAULT 0,
      clinica_id        INTEGER REFERENCES clinicas(id),
      criado_em         TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS profissionais (
      id               SERIAL PRIMARY KEY,
      nome             TEXT NOT NULL,
      data_nascimento  TEXT,
      cpf              TEXT,
      email            TEXT,
      telefone         TEXT NOT NULL,
      nome_fantasia    TEXT,
      ativo            INTEGER NOT NULL DEFAULT 1,
      clinica_id       INTEGER REFERENCES clinicas(id),
      criado_em        TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS massagens (
      id         SERIAL PRIMARY KEY,
      nome       TEXT NOT NULL,
      descricao  TEXT,
      duracao    INTEGER NOT NULL,
      preco      NUMERIC(10,2) NOT NULL,
      ativa      INTEGER NOT NULL DEFAULT 1,
      clinica_id INTEGER REFERENCES clinicas(id),
      criado_em  TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reservas (
      id               SERIAL PRIMARY KEY,
      data             TEXT NOT NULL,
      hora_inicio      TEXT NOT NULL,
      hora_fim         TEXT NOT NULL,
      quarto_id        INTEGER NOT NULL REFERENCES quartos(id),
      profissional_id  INTEGER NOT NULL REFERENCES profissionais(id),
      massagem_id      INTEGER NOT NULL REFERENCES massagens(id),
      clinica_id       INTEGER REFERENCES clinicas(id),
      cliente_nome     TEXT NOT NULL,
      cliente_telefone TEXT,
      status           TEXT NOT NULL DEFAULT 'confirmada',
      observacoes      TEXT,
      bebida           TEXT,
      preco_bebida     NUMERIC(10,2) NOT NULL DEFAULT 0,
      criado_em        TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // 3. Migrações seguras
  await pool.query(`
    ALTER TABLE quartos       ADD COLUMN IF NOT EXISTS clinica_id INTEGER REFERENCES clinicas(id);
    ALTER TABLE profissionais ADD COLUMN IF NOT EXISTS clinica_id INTEGER REFERENCES clinicas(id);
    ALTER TABLE massagens     ADD COLUMN IF NOT EXISTS clinica_id INTEGER REFERENCES clinicas(id);
    ALTER TABLE reservas      ADD COLUMN IF NOT EXISTS clinica_id INTEGER REFERENCES clinicas(id);
    ALTER TABLE clinicas      ADD COLUMN IF NOT EXISTS emails_adicionais TEXT;
  `);

  // 3b. Campos de bebida na reserva
  await pool.query(`
    ALTER TABLE reservas ADD COLUMN IF NOT EXISTS bebida TEXT;
    ALTER TABLE reservas ADD COLUMN IF NOT EXISTS preco_bebida NUMERIC(10,2) NOT NULL DEFAULT 0;
  `);

  // 3c. Remove constraint única global de numero em quartos (incompatível com multi-clínica)
  await pool.query(`
    ALTER TABLE quartos DROP CONSTRAINT IF EXISTS quartos_numero_key;
  `);

  // 4. Seed do admin padrão
  const existe = await qOne('SELECT id FROM admins WHERE email=$1', ['rafael@unimidia.tv']);
  if (!existe) {
    const hash = await bcrypt.hash('Admin@2024', 10);
    await qRun('INSERT INTO admins (nome, email, senha_hash) VALUES ($1,$2,$3)',
      ['Rafael', 'rafael@unimidia.tv', hash]);
    console.log('\n🔑 Admin padrão criado:');
    console.log('   Email : rafael@unimidia.tv');
    console.log('   Senha : Admin@2024');
    console.log('   ⚠️  Altere a senha após o primeiro login!\n');
  }
  console.log('✅ Banco de dados pronto');
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());

const publicDir = path.join(__dirname, 'public');
const rootIndex = path.join(__dirname, 'index.html');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
} else {
  app.get('/', (req, res) => {
    if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
    const f = fs.readdirSync(__dirname).find(n => /\.html?$/i.test(n));
    if (f) return res.sendFile(path.join(__dirname, f));
    res.status(404).send('index.html não encontrado');
  });
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ ok: false, error: 'Não autenticado' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'Sessão expirada. Faça login novamente.' });
  }
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin')
      return res.status(403).json({ ok: false, error: 'Acesso restrito a administradores' });
    next();
  });
}

function getClinicaId(req) {
  if (req.user.role === 'admin') {
    const cid = req.query.clinica_id || req.body?.clinica_id;
    if (!cid) throw new Error('Selecione uma clínica no seletor do topo para continuar');
    return parseInt(cid);
  }
  return req.user.clinica_id;
}

async function send(res, fn) {
  try {
    const result = await fn();
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.json({ ok: false, error: 'Email e senha obrigatórios' });
    const em = email.toLowerCase().trim();

    const admin = await qOne('SELECT * FROM admins WHERE email=$1 AND ativo=1', [em]);
    if (admin && await bcrypt.compare(senha, admin.senha_hash)) {
      const token = jwt.sign(
        { id: admin.id, email: admin.email, role: 'admin', nome: admin.nome },
        JWT_SECRET, { expiresIn: '10h' }
      );
      return res.json({ ok: true, data: { token, user: { role: 'admin', nome: admin.nome, email: admin.email } } });
    }

    const clinica = await qOne('SELECT * FROM clinicas WHERE email=$1 AND ativo=1', [em]);
    if (clinica && await bcrypt.compare(senha, clinica.senha_hash)) {
      const token = jwt.sign(
        { id: clinica.id, email: clinica.email, role: 'clinica',
          clinica_id: clinica.id, nome_clinica: clinica.nome },
        JWT_SECRET, { expiresIn: '10h' }
      );
      return res.json({ ok: true, data: { token,
        user: { role: 'clinica', nome_clinica: clinica.nome, email: clinica.email, clinica_id: clinica.id } } });
    }

    res.json({ ok: false, error: 'Email ou senha incorretos' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) =>
  res.json({ ok: true, data: req.user }));

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — Clínicas
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/clinicas', requireAdmin, (req, res) =>
  send(res, () => q('SELECT id,nome,email,telefone,endereco,emails_adicionais,ativo,criado_em FROM clinicas ORDER BY nome')));

app.post('/api/admin/clinicas', requireAdmin, (req, res) =>
  send(res, async () => {
    const { nome, email, senha, telefone, endereco, emails_adicionais } = req.body;
    if (!nome)  throw new Error('Nome é obrigatório');
    if (!email) throw new Error('Email é obrigatório');
    if (!senha) throw new Error('Senha é obrigatória');
    const hash = await bcrypt.hash(senha, 10);
    return qOne(
      'INSERT INTO clinicas (nome,email,senha_hash,telefone,endereco,emails_adicionais) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,nome,email,telefone,endereco,emails_adicionais,ativo,criado_em',
      [nome.trim(), email.toLowerCase().trim(), hash, telefone||null, endereco||null, emails_adicionais||null]
    );
  }));

app.put('/api/admin/clinicas/:id', requireAdmin, (req, res) =>
  send(res, async () => {
    const { nome, email, senha, telefone, endereco, emails_adicionais, ativo } = req.body;
    if (!nome)  throw new Error('Nome é obrigatório');
    if (!email) throw new Error('Email é obrigatório');
    if (senha) {
      const hash = await bcrypt.hash(senha, 10);
      await qRun(
        'UPDATE clinicas SET nome=$1,email=$2,senha_hash=$3,telefone=$4,endereco=$5,emails_adicionais=$6,ativo=$7 WHERE id=$8',
        [nome.trim(), email.toLowerCase().trim(), hash, telefone||null, endereco||null, emails_adicionais||null, ativo??1, req.params.id]
      );
    } else {
      await qRun(
        'UPDATE clinicas SET nome=$1,email=$2,telefone=$3,endereco=$4,emails_adicionais=$5,ativo=$6 WHERE id=$7',
        [nome.trim(), email.toLowerCase().trim(), telefone||null, endereco||null, emails_adicionais||null, ativo??1, req.params.id]
      );
    }
    return qOne('SELECT id,nome,email,telefone,endereco,emails_adicionais,ativo,criado_em FROM clinicas WHERE id=$1', [req.params.id]);
  }));

app.delete('/api/admin/clinicas/:id', requireAdmin, (req, res) =>
  send(res, async () => {
    await qRun('UPDATE clinicas SET ativo=0 WHERE id=$1', [req.params.id]);
    return { id: parseInt(req.params.id) };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — Admins
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/admins', requireAdmin, (req, res) =>
  send(res, () => q('SELECT id,nome,email,ativo,criado_em FROM admins ORDER BY nome')));

app.post('/api/admin/admins', requireAdmin, (req, res) =>
  send(res, async () => {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) throw new Error('Nome, email e senha são obrigatórios');
    const hash = await bcrypt.hash(senha, 10);
    return qOne(
      'INSERT INTO admins (nome,email,senha_hash) VALUES ($1,$2,$3) RETURNING id,nome,email,ativo,criado_em',
      [nome.trim(), email.toLowerCase().trim(), hash]
    );
  }));

app.put('/api/admin/admins/:id', requireAdmin, (req, res) =>
  send(res, async () => {
    const { nome, email, senha, ativo } = req.body;
    if (!nome || !email) throw new Error('Nome e email são obrigatórios');
    if (senha) {
      const hash = await bcrypt.hash(senha, 10);
      await qRun('UPDATE admins SET nome=$1,email=$2,senha_hash=$3,ativo=$4 WHERE id=$5',
        [nome.trim(), email.toLowerCase().trim(), hash, ativo??1, req.params.id]);
    } else {
      await qRun('UPDATE admins SET nome=$1,email=$2,ativo=$3 WHERE id=$4',
        [nome.trim(), email.toLowerCase().trim(), ativo??1, req.params.id]);
    }
    return qOne('SELECT id,nome,email,ativo,criado_em FROM admins WHERE id=$1', [req.params.id]);
  }));

app.delete('/api/admin/admins/:id', requireAdmin, (req, res) =>
  send(res, async () => {
    await qRun('UPDATE admins SET ativo=0 WHERE id=$1', [req.params.id]);
    return { id: parseInt(req.params.id) };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// QUARTOS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/quartos', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    return q('SELECT * FROM quartos WHERE clinica_id=$1 ORDER BY numero', [cid]);
  }));

app.post('/api/quartos', requireAuth, (req, res) =>
  send(res, async () => {
    const { nome, tem_hidromassagem } = req.body;
    const cid = getClinicaId(req);
    if (!nome) throw new Error('Nome é obrigatório');
    const last = await qOne('SELECT COALESCE(MAX(numero),0) AS n FROM quartos WHERE clinica_id=$1', [cid]);
    const numero = (parseInt(last.n)||0) + 1;
    return qOne(
      'INSERT INTO quartos (nome,numero,tem_hidromassagem,clinica_id) VALUES ($1,$2,$3,$4) RETURNING *',
      [nome.trim(), numero, tem_hidromassagem?1:0, cid]
    );
  }));

app.put('/api/quartos/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const { nome, tem_hidromassagem } = req.body;
    const cid = getClinicaId(req);
    if (!nome) throw new Error('Nome é obrigatório');
    return qOne(
      'UPDATE quartos SET nome=$1,tem_hidromassagem=$2 WHERE id=$3 AND clinica_id=$4 RETURNING *',
      [nome.trim(), tem_hidromassagem?1:0, req.params.id, cid]
    );
  }));

app.delete('/api/quartos/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const r = await qOne(
      "SELECT COUNT(*) AS c FROM reservas WHERE quarto_id=$1 AND clinica_id=$2 AND status!='cancelada'",
      [req.params.id, cid]
    );
    if (parseInt(r.c) > 0) throw new Error('Quarto possui reservas ativas. Cancele-as primeiro.');
    await qRun('DELETE FROM quartos WHERE id=$1 AND clinica_id=$2', [req.params.id, cid]);
    return { id: parseInt(req.params.id) };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// PROFISSIONAIS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/profissionais', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const filtro = req.query.todos === '1' ? '' : 'AND ativo=1';
    return q(`SELECT * FROM profissionais WHERE clinica_id=$1 ${filtro} ORDER BY nome`, [cid]);
  }));

app.post('/api/profissionais', requireAuth, (req, res) =>
  send(res, async () => {
    const { nome, data_nascimento, cpf, email, telefone, nome_fantasia } = req.body;
    const cid = getClinicaId(req);
    if (!nome)     throw new Error('Nome é obrigatório');
    if (!telefone) throw new Error('Telefone é obrigatório');
    const cpfLimpo = cpf ? cpf.replace(/\D/g,'') : null;
    return qOne(
      'INSERT INTO profissionais (nome,data_nascimento,cpf,email,telefone,nome_fantasia,clinica_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [nome.trim(), data_nascimento, cpfLimpo, email||null, telefone.trim(), nome_fantasia||null, cid]
    );
  }));

app.put('/api/profissionais/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const { nome, data_nascimento, cpf, email, telefone, nome_fantasia, ativo } = req.body;
    const cid = getClinicaId(req);
    if (!nome || !telefone) throw new Error('Preencha os campos obrigatórios');
    const cpfLimpo = cpf ? cpf.replace(/\D/g,'') : null;
    return qOne(
      'UPDATE profissionais SET nome=$1,data_nascimento=$2,cpf=$3,email=$4,telefone=$5,nome_fantasia=$6,ativo=$7 WHERE id=$8 AND clinica_id=$9 RETURNING *',
      [nome.trim(), data_nascimento, cpfLimpo, email||null, telefone.trim(), nome_fantasia||null, ativo??1, req.params.id, cid]
    );
  }));

app.delete('/api/profissionais/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    await qRun('UPDATE profissionais SET ativo=0 WHERE id=$1 AND clinica_id=$2', [req.params.id, cid]);
    return { id: parseInt(req.params.id) };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// MASSAGENS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/massagens', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const filtro = req.query.todas === '1' ? '' : 'AND ativa=1';
    return q(`SELECT * FROM massagens WHERE clinica_id=$1 ${filtro} ORDER BY nome`, [cid]);
  }));

app.post('/api/massagens', requireAuth, (req, res) =>
  send(res, async () => {
    const { nome, descricao, duracao, preco } = req.body;
    const cid = getClinicaId(req);
    if (!nome || !duracao || preco===undefined) throw new Error('Preencha os campos obrigatórios');
    return qOne(
      'INSERT INTO massagens (nome,descricao,duracao,preco,clinica_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [nome.trim(), descricao||null, parseInt(duracao), parseFloat(preco), cid]
    );
  }));

app.put('/api/massagens/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const { nome, descricao, duracao, preco, ativa } = req.body;
    const cid = getClinicaId(req);
    if (!nome || !duracao || preco===undefined) throw new Error('Preencha os campos obrigatórios');
    return qOne(
      'UPDATE massagens SET nome=$1,descricao=$2,duracao=$3,preco=$4,ativa=$5 WHERE id=$6 AND clinica_id=$7 RETURNING *',
      [nome.trim(), descricao||null, parseInt(duracao), parseFloat(preco), ativa??1, req.params.id, cid]
    );
  }));

app.delete('/api/massagens/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    await qRun('UPDATE massagens SET ativa=0 WHERE id=$1 AND clinica_id=$2', [req.params.id, cid]);
    return { id: parseInt(req.params.id) };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// RESERVAS
// ═══════════════════════════════════════════════════════════════════════════════
const RJ = `
  SELECT r.*,
    q.nome AS quarto_nome, q.numero AS quarto_numero, q.tem_hidromassagem,
    p.nome AS profissional_nome, p.nome_fantasia,
    m.nome AS massagem_nome, m.duracao AS massagem_duracao, m.preco AS massagem_preco,
    r.bebida, r.preco_bebida
  FROM reservas r
  JOIN quartos q ON r.quarto_id=q.id
  JOIN profissionais p ON r.profissional_id=p.id
  JOIN massagens m ON r.massagem_id=m.id
`;

app.get('/api/reservas/resumo-mensal', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { mes, ano } = req.query;
    if (!mes || !ano) throw new Error('Mês e ano são obrigatórios');
    const prefixo = `${ano}-${mes.padStart(2,'0')}`;
    return q(`
      SELECT data,
        COUNT(*) AS total,
        SUM(CASE WHEN status='confirmada' THEN 1 ELSE 0 END) AS confirmadas,
        SUM(CASE WHEN status='concluida'  THEN 1 ELSE 0 END) AS concluidas,
        SUM(CASE WHEN status='cancelada'  THEN 1 ELSE 0 END) AS canceladas
      FROM reservas WHERE clinica_id=$1 AND data LIKE $2 GROUP BY data ORDER BY data
    `, [cid, `${prefixo}%`]);
  }));

app.get('/api/reservas', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    if (req.query.data)
      return q(`${RJ} WHERE r.clinica_id=$1 AND r.data=$2 ORDER BY r.hora_inicio,q.numero`, [cid, req.query.data]);
    if (req.query.mes && req.query.ano) {
      const pref = `${req.query.ano}-${req.query.mes.padStart(2,'0')}`;
      return q(`${RJ} WHERE r.clinica_id=$1 AND r.data LIKE $2 ORDER BY r.data,r.hora_inicio`, [cid, `${pref}%`]);
    }
    return q(`${RJ} WHERE r.clinica_id=$1 ORDER BY r.data DESC,r.hora_inicio`, [cid]);
  }));

app.post('/api/reservas', requireAuth, (req, res) =>
  send(res, async () => {
    const { data, hora_inicio, hora_fim, quarto_id, profissional_id,
            massagem_id, cliente_nome, cliente_telefone, observacoes,
            bebida, preco_bebida } = req.body;
    const cid = getClinicaId(req);
    if (!data||!hora_inicio||!hora_fim||!quarto_id||!profissional_id||!massagem_id||!cliente_nome)
      throw new Error('Preencha todos os campos obrigatórios');
    // Verificar conflito de sala
    const cQ = await qOne(
      `SELECT id FROM reservas WHERE clinica_id=$1 AND quarto_id=$2 AND data=$3 AND status!='cancelada' AND hora_inicio<$4 AND hora_fim>$5`,
      [cid, quarto_id, data, hora_fim, hora_inicio]);
    if (cQ) throw new Error('Sala já reservada neste horário');
    // Verificar conflito de profissional
    const cP = await qOne(
      `SELECT id FROM reservas WHERE clinica_id=$1 AND profissional_id=$2 AND data=$3 AND status!='cancelada' AND hora_inicio<$4 AND hora_fim>$5`,
      [cid, profissional_id, data, hora_fim, hora_inicio]);
    if (cP) throw new Error('Massagista já tem atendimento neste horário');
    const nova = await qOne(
      'INSERT INTO reservas (data,hora_inicio,hora_fim,quarto_id,profissional_id,massagem_id,clinica_id,cliente_nome,cliente_telefone,observacoes,bebida,preco_bebida) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',
      [data, hora_inicio, hora_fim, quarto_id, profissional_id, massagem_id, cid, cliente_nome.trim(), cliente_telefone||null, observacoes||null, bebida||null, parseFloat(preco_bebida)||0]);
    return qOne(`${RJ} WHERE r.id=$1`, [nova.id]);
  }));

app.put('/api/reservas/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const id  = parseInt(req.params.id);
    const cid = getClinicaId(req);
    const { data, hora_inicio, hora_fim, quarto_id, profissional_id,
            massagem_id, cliente_nome, cliente_telefone, status, observacoes,
            bebida, preco_bebida } = req.body;
    if (!data||!hora_inicio||!hora_fim||!cliente_nome) throw new Error('Preencha os campos obrigatórios');
    if (status !== 'cancelada') {
      const cQ = await qOne(
        `SELECT id FROM reservas WHERE clinica_id=$1 AND quarto_id=$2 AND data=$3 AND id!=$4 AND status!='cancelada' AND hora_inicio<$5 AND hora_fim>$6`,
        [cid, quarto_id, data, id, hora_fim, hora_inicio]);
      if (cQ) throw new Error('Sala já reservada neste horário');
      const cP = await qOne(
        `SELECT id FROM reservas WHERE clinica_id=$1 AND profissional_id=$2 AND data=$3 AND id!=$4 AND status!='cancelada' AND hora_inicio<$5 AND hora_fim>$6`,
        [cid, profissional_id, data, id, hora_fim, hora_inicio]);
      if (cP) throw new Error('Massagista já tem atendimento neste horário');
    }
    await qRun(
      'UPDATE reservas SET data=$1,hora_inicio=$2,hora_fim=$3,quarto_id=$4,profissional_id=$5,massagem_id=$6,cliente_nome=$7,cliente_telefone=$8,status=$9,observacoes=$10,bebida=$11,preco_bebida=$12 WHERE id=$13 AND clinica_id=$14',
      [data, hora_inicio, hora_fim, quarto_id, profissional_id, massagem_id,
       cliente_nome.trim(), cliente_telefone||null, status||'confirmada', observacoes||null,
       bebida||null, parseFloat(preco_bebida)||0, id, cid]);
    return qOne(`${RJ} WHERE r.id=$1`, [id]);
  }));

app.delete('/api/reservas/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    await qRun("UPDATE reservas SET status='cancelada' WHERE id=$1 AND clinica_id=$2", [req.params.id, cid]);
    return { id: parseInt(req.params.id) };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD FINANCEIRO
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/dashboard/massagista-mensal', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { mes, ano } = req.query;
    if (!mes || !ano) throw new Error('Mês e ano são obrigatórios');
    const pref = `${ano}-${String(mes).padStart(2,'0')}%`;
    return q(`
      SELECT
        p.id,
        COALESCE(p.nome_fantasia, p.nome) AS nome_display,
        p.nome                            AS nome_completo,
        COUNT(CASE WHEN r.status != 'cancelada' THEN 1 END)                              AS atendimentos,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN m.preco + COALESCE(r.preco_bebida,0) ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(r.preco_bebida,0) ELSE 0 END), 0) AS total_bebidas,
        COUNT(CASE WHEN r.status = 'confirmada' THEN 1 END)                             AS confirmadas,
        COUNT(CASE WHEN r.status = 'concluida'  THEN 1 END)                             AS concluidas,
        COUNT(CASE WHEN r.status = 'cancelada'  THEN 1 END)                             AS canceladas
      FROM profissionais p
      LEFT JOIN reservas  r ON r.profissional_id = p.id AND r.clinica_id = $1 AND r.data LIKE $2
      LEFT JOIN massagens m ON m.id = r.massagem_id
      WHERE p.clinica_id = $1 AND p.ativo = 1
      GROUP BY p.id, p.nome, p.nome_fantasia
      ORDER BY total DESC NULLS LAST, p.nome
    `, [cid, pref]);
  }));

app.get('/api/dashboard/massagista-diario', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { data } = req.query;
    if (!data) throw new Error('Data é obrigatória');
    return q(`
      SELECT
        p.id,
        COALESCE(p.nome_fantasia, p.nome) AS nome_display,
        p.nome                            AS nome_completo,
        COUNT(CASE WHEN r.status != 'cancelada' THEN 1 END)                              AS atendimentos,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN m.preco + COALESCE(r.preco_bebida,0) ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(r.preco_bebida,0) ELSE 0 END), 0) AS total_bebidas,
        COUNT(CASE WHEN r.status = 'confirmada' THEN 1 END)                             AS confirmadas,
        COUNT(CASE WHEN r.status = 'concluida'  THEN 1 END)                             AS concluidas,
        COUNT(CASE WHEN r.status = 'cancelada'  THEN 1 END)                             AS canceladas
      FROM profissionais p
      LEFT JOIN reservas  r ON r.profissional_id = p.id AND r.clinica_id = $1 AND r.data = $2
      LEFT JOIN massagens m ON m.id = r.massagem_id
      WHERE p.clinica_id = $1 AND p.ativo = 1
      GROUP BY p.id, p.nome, p.nome_fantasia
      ORDER BY total DESC NULLS LAST, p.nome
    `, [cid, data]);
  }));

app.get('/api/dashboard/massagem-mensal', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { mes, ano } = req.query;
    if (!mes || !ano) throw new Error('Mês e ano são obrigatórios');
    const pref = `${ano}-${String(mes).padStart(2,'0')}%`;
    return q(`
      SELECT
        m.id,
        m.nome,
        m.duracao,
        m.preco                                                                          AS preco_unitario,
        COUNT(CASE WHEN r.status != 'cancelada' THEN 1 END)                             AS atendimentos,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN m.preco + COALESCE(r.preco_bebida,0) ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(r.preco_bebida,0) ELSE 0 END), 0) AS total_bebidas,
        COUNT(CASE WHEN r.status = 'confirmada' THEN 1 END)                            AS confirmadas,
        COUNT(CASE WHEN r.status = 'concluida'  THEN 1 END)                            AS concluidas,
        COUNT(CASE WHEN r.status = 'cancelada'  THEN 1 END)                            AS canceladas
      FROM massagens m
      LEFT JOIN reservas r ON r.massagem_id = m.id AND r.clinica_id = $1 AND r.data LIKE $2
      WHERE m.clinica_id = $1
      GROUP BY m.id, m.nome, m.duracao, m.preco
      ORDER BY total DESC NULLS LAST, m.nome
    `, [cid, pref]);
  }));

app.get('/api/dashboard/massagem-diario', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { data } = req.query;
    if (!data) throw new Error('Data é obrigatória');
    return q(`
      SELECT
        m.id,
        m.nome,
        m.duracao,
        m.preco                                                                          AS preco_unitario,
        COUNT(CASE WHEN r.status != 'cancelada' THEN 1 END)                             AS atendimentos,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN m.preco + COALESCE(r.preco_bebida,0) ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(r.preco_bebida,0) ELSE 0 END), 0) AS total_bebidas,
        COUNT(CASE WHEN r.status = 'confirmada' THEN 1 END)                            AS confirmadas,
        COUNT(CASE WHEN r.status = 'concluida'  THEN 1 END)                            AS concluidas,
        COUNT(CASE WHEN r.status = 'cancelada'  THEN 1 END)                            AS canceladas
      FROM massagens m
      LEFT JOIN reservas r ON r.massagem_id = m.id AND r.clinica_id = $1 AND r.data = $2
      WHERE m.clinica_id = $1
      GROUP BY m.id, m.nome, m.duracao, m.preco
      ORDER BY total DESC NULLS LAST, m.nome
    `, [cid, data]);
  }));

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () =>
    console.log(`\n💆 Massagem Reserva rodando em http://localhost:${PORT}\n`));
}).catch(err => {
  console.error('Erro ao conectar ao banco:', err.message);
  process.exit(1);
});
