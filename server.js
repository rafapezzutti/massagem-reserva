const express = require('express');
const https   = require('https');
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

  // 3b. Campos de bebida + recepcionista na reserva
  await pool.query(`
    ALTER TABLE reservas ADD COLUMN IF NOT EXISTS bebida TEXT;
    ALTER TABLE reservas ADD COLUMN IF NOT EXISTS preco_bebida NUMERIC(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE reservas ADD COLUMN IF NOT EXISTS recepcionista_id INTEGER;
  `);

  // 3c. Remove constraint única global de numero em quartos (incompatível com multi-clínica)
  await pool.query(`
    ALTER TABLE quartos DROP CONSTRAINT IF EXISTS quartos_numero_key;
  `);

  // 3d. Novas tabelas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recepcionistas (
      id              SERIAL PRIMARY KEY,
      nome            TEXT NOT NULL,
      cpf             TEXT,
      data_nascimento TEXT,
      telefone        TEXT,
      email           TEXT,
      ativo           INTEGER NOT NULL DEFAULT 1,
      clinica_id      INTEGER REFERENCES clinicas(id),
      criado_em       TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS repasse_config (
      id         SERIAL PRIMARY KEY,
      clinica_id INTEGER NOT NULL UNIQUE REFERENCES clinicas(id),
      percentual NUMERIC(5,2) NOT NULL DEFAULT 0
    );
  `);

  // 3e-b. Horário de funcionamento por clinica
  await pool.query(`
    ALTER TABLE clinicas ADD COLUMN IF NOT EXISTS horario_funcionamento TEXT;
  `);

  // 3e-c. Seed horario Bali Spa (10h-24h seg-sab, fechado dom)
  await pool.query(`
    UPDATE clinicas SET horario_funcionamento = $1
    WHERE nome ILIKE '%bali%' AND horario_funcionamento IS NULL
  `, [JSON.stringify({
    seg:{aberto:true,abertura:'10:00',fechamento:'24:00'},
    ter:{aberto:true,abertura:'10:00',fechamento:'24:00'},
    qua:{aberto:true,abertura:'10:00',fechamento:'24:00'},
    qui:{aberto:true,abertura:'10:00',fechamento:'24:00'},
    sex:{aberto:true,abertura:'10:00',fechamento:'24:00'},
    sab:{aberto:true,abertura:'10:00',fechamento:'24:00'},
    dom:{aberto:false,abertura:'',fechamento:''}
  })]);

  // 3e. Tabela de gerentes (perfil operacional, sem dashboard/repasse)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gerentes (
      id          SERIAL PRIMARY KEY,
      nome        TEXT NOT NULL,
      email       TEXT NOT NULL UNIQUE,
      senha_hash  TEXT NOT NULL,
      clinica_id  INTEGER REFERENCES clinicas(id),
      ativo       INTEGER NOT NULL DEFAULT 1,
      criado_em   TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // 3f-b. Horário de atendimento por profissional
  await pool.query(`
    ALTER TABLE profissionais ADD COLUMN IF NOT EXISTS horario TEXT;
  `);

  // 3f. Coluna de método de pagamento nas reservas
  await pool.query(`
    ALTER TABLE reservas ADD COLUMN IF NOT EXISTS pagamento TEXT;
  `);

  // 3g. Tabela de alugueis (valor cobrado da massagista)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alugueis (
      id         SERIAL PRIMARY KEY,
      nome       TEXT NOT NULL,
      descricao  TEXT,
      valor      NUMERIC(10,2) NOT NULL DEFAULT 0,
      ativo      INTEGER NOT NULL DEFAULT 1,
      clinica_id INTEGER REFERENCES clinicas(id),
      criado_em  TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // 3h. Coluna aluguel_id na reserva + massagem_id nullable
  await pool.query(`
    ALTER TABLE reservas ADD COLUMN IF NOT EXISTS aluguel_id INTEGER REFERENCES alugueis(id);
  `);
  await pool.query('ALTER TABLE reservas ALTER COLUMN massagem_id DROP NOT NULL').catch(() => {});

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
// Bloqueia gerentes do dashboard
function requireDashboard(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role === 'gerente')
      return res.status(403).json({ ok: false, error: 'Gerentes não têm acesso ao dashboard' });
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

    const gerente = await qOne('SELECT * FROM gerentes WHERE email=$1 AND ativo=1', [em]);
    if (gerente && await bcrypt.compare(senha, gerente.senha_hash)) {
      const token = jwt.sign(
        { id: gerente.id, email: gerente.email, role: 'gerente',
          clinica_id: gerente.clinica_id, nome: gerente.nome },
        JWT_SECRET, { expiresIn: '10h' }
      );
      return res.json({ ok: true, data: { token,
        user: { role: 'gerente', nome: gerente.nome, email: gerente.email, clinica_id: gerente.clinica_id } } });
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
  send(res, () => q('SELECT id,nome,email,telefone,endereco,emails_adicionais,ativo,horario_funcionamento,criado_em FROM clinicas ORDER BY nome')));

app.post('/api/admin/clinicas', requireAdmin, (req, res) =>
  send(res, async () => {
    const { nome, email, senha, telefone, endereco, emails_adicionais, horario_funcionamento } = req.body;
    if (!nome)  throw new Error('Nome é obrigatório');
    if (!email) throw new Error('Email é obrigatório');
    if (!senha) throw new Error('Senha é obrigatória');
    const hash = await bcrypt.hash(senha, 10);
    return qOne(
      'INSERT INTO clinicas (nome,email,senha_hash,telefone,endereco,emails_adicionais,horario_funcionamento) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,nome,email,telefone,endereco,emails_adicionais,horario_funcionamento,ativo,criado_em',
      [nome.trim(), email.toLowerCase().trim(), hash, telefone||null, endereco||null, emails_adicionais||null, horario_funcionamento||null]
    );
  }));

app.put('/api/admin/clinicas/:id', requireAdmin, (req, res) =>
  send(res, async () => {
    const { nome, email, senha, telefone, endereco, emails_adicionais, horario_funcionamento, ativo } = req.body;
    if (!nome)  throw new Error('Nome é obrigatório');
    if (!email) throw new Error('Email é obrigatório');
    if (senha) {
      const hash = await bcrypt.hash(senha, 10);
      await qRun(
        'UPDATE clinicas SET nome=$1,email=$2,senha_hash=$3,telefone=$4,endereco=$5,emails_adicionais=$6,ativo=$7,horario_funcionamento=$8 WHERE id=$9',
        [nome.trim(), email.toLowerCase().trim(), hash, telefone||null, endereco||null, emails_adicionais||null, ativo??1, horario_funcionamento||null, req.params.id]
      );
    } else {
      await qRun(
        'UPDATE clinicas SET nome=$1,email=$2,telefone=$3,endereco=$4,emails_adicionais=$5,ativo=$6,horario_funcionamento=$7 WHERE id=$8',
        [nome.trim(), email.toLowerCase().trim(), telefone||null, endereco||null, emails_adicionais||null, ativo??1, horario_funcionamento||null, req.params.id]
      );
    }
    return qOne('SELECT id,nome,email,telefone,endereco,emails_adicionais,horario_funcionamento,ativo,criado_em FROM clinicas WHERE id=$1', [req.params.id]);
  }));

app.delete('/api/admin/clinicas/:id', requireAdmin, (req, res) =>
  send(res, async () => {
    await qRun('DELETE FROM clinicas WHERE id=$1', [req.params.id]);
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
    await qRun('DELETE FROM admins WHERE id=$1', [req.params.id]);
    return { id: parseInt(req.params.id) };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// CLINICA INFO
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/clinica/info', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    return qOne('SELECT id,nome,horario_funcionamento FROM clinicas WHERE id=$1', [cid]);
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — Gerentes
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/gerentes', requireAdmin, (req, res) =>
  send(res, () => q(`
    SELECT g.id, g.nome, g.email, g.ativo, g.criado_em, g.clinica_id, c.nome AS clinica_nome
    FROM gerentes g LEFT JOIN clinicas c ON g.clinica_id=c.id
    ORDER BY g.nome
  `)));

app.post('/api/admin/gerentes', requireAdmin, (req, res) =>
  send(res, async () => {
    const { nome, email, senha, clinica_id } = req.body;
    if (!nome || !email || !senha) throw new Error('Nome, email e senha sao obrigatorios');
    if (!clinica_id) throw new Error('Selecione a clinica do gerente');
    const hash = await bcrypt.hash(senha, 10);
    return qOne(
      'INSERT INTO gerentes (nome,email,senha_hash,clinica_id) VALUES ($1,$2,$3,$4) RETURNING id,nome,email,ativo,clinica_id,criado_em',
      [nome.trim(), email.toLowerCase().trim(), hash, clinica_id]
    );
  }));

app.put('/api/admin/gerentes/:id', requireAdmin, (req, res) =>
  send(res, async () => {
    const { nome, email, senha, clinica_id, ativo } = req.body;
    if (!nome || !email) throw new Error('Nome e email sao obrigatorios');
    if (senha) {
      const hash = await bcrypt.hash(senha, 10);
      await qRun(
        'UPDATE gerentes SET nome=$1,email=$2,senha_hash=$3,clinica_id=$4,ativo=$5 WHERE id=$6',
        [nome.trim(), email.toLowerCase().trim(), hash, clinica_id, ativo??1, req.params.id]
      );
    } else {
      await qRun(
        'UPDATE gerentes SET nome=$1,email=$2,clinica_id=$3,ativo=$4 WHERE id=$5',
        [nome.trim(), email.toLowerCase().trim(), clinica_id, ativo??1, req.params.id]
      );
    }
    return qOne('SELECT id,nome,email,ativo,clinica_id,criado_em FROM gerentes WHERE id=$1', [req.params.id]);
  }));

app.delete('/api/admin/gerentes/:id', requireAdmin, (req, res) =>
  send(res, async () => {
    await qRun('DELETE FROM gerentes WHERE id=$1', [req.params.id]);
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
    const { nome, data_nascimento, cpf, email, telefone, nome_fantasia, horario } = req.body;
    const cid = getClinicaId(req);
    if (!nome)     throw new Error('Nome é obrigatório');
    if (!telefone) throw new Error('Telefone é obrigatório');
    const cpfLimpo = cpf ? cpf.replace(/\D/g,'') : null;
    return qOne(
      'INSERT INTO profissionais (nome,data_nascimento,cpf,email,telefone,nome_fantasia,clinica_id,horario) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [nome.trim(), data_nascimento, cpfLimpo, email||null, telefone.trim(), nome_fantasia||null, cid, horario||null]
    );
  }));

app.put('/api/profissionais/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const { nome, data_nascimento, cpf, email, telefone, nome_fantasia, ativo, horario } = req.body;
    const cid = getClinicaId(req);
    if (!nome || !telefone) throw new Error('Preencha os campos obrigatórios');
    const cpfLimpo = cpf ? cpf.replace(/\D/g,'') : null;
    return qOne(
      'UPDATE profissionais SET nome=$1,data_nascimento=$2,cpf=$3,email=$4,telefone=$5,nome_fantasia=$6,ativo=$7,horario=$8 WHERE id=$9 AND clinica_id=$10 RETURNING *',
      [nome.trim(), data_nascimento, cpfLimpo, email||null, telefone.trim(), nome_fantasia||null, ativo??1, horario||null, req.params.id, cid]
    );
  }));

app.delete('/api/profissionais/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    await qRun('DELETE FROM profissionais WHERE id=$1 AND clinica_id=$2', [req.params.id, cid]);
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
    const vinc = await qOne('SELECT COUNT(*) AS c FROM reservas WHERE massagem_id=$1 AND clinica_id=$2', [req.params.id, cid]);
    if (parseInt(vinc.c) > 0) throw new Error('Esta massagem possui ' + vinc.c + ' reserva(s) vinculada(s). Desative-a ao invés de excluir.');
    await qRun('DELETE FROM massagens WHERE id=$1 AND clinica_id=$2', [req.params.id, cid]);
    return { id: parseInt(req.params.id) };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// ALUGUEIS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/alugueis', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const filtro = req.query.todos === '1' ? '' : 'AND ativo=1';
    return q(`SELECT * FROM alugueis WHERE clinica_id=$1 ${filtro} ORDER BY nome`, [cid]);
  }));

app.post('/api/alugueis', requireAuth, (req, res) =>
  send(res, async () => {
    const { nome, descricao, valor } = req.body;
    const cid = getClinicaId(req);
    if (!nome || valor === undefined) throw new Error('Preencha os campos obrigatórios');
    return qOne(
      'INSERT INTO alugueis (nome,descricao,valor,clinica_id) VALUES ($1,$2,$3,$4) RETURNING *',
      [nome.trim(), descricao||null, parseFloat(valor), cid]
    );
  }));

app.put('/api/alugueis/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const { nome, descricao, valor, ativo } = req.body;
    const cid = getClinicaId(req);
    if (!nome || valor === undefined) throw new Error('Preencha os campos obrigatórios');
    return qOne(
      'UPDATE alugueis SET nome=$1,descricao=$2,valor=$3,ativo=$4 WHERE id=$5 AND clinica_id=$6 RETURNING *',
      [nome.trim(), descricao||null, parseFloat(valor), ativo??1, req.params.id, cid]
    );
  }));

app.delete('/api/alugueis/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const vinc = await qOne('SELECT COUNT(*) AS c FROM reservas WHERE aluguel_id=$1 AND clinica_id=$2', [req.params.id, cid]);
    if (parseInt(vinc.c) > 0) throw new Error('Este aluguel possui ' + vinc.c + ' reserva(s) vinculada(s). Desative-o ao invés de excluir.');
    await qRun('DELETE FROM alugueis WHERE id=$1 AND clinica_id=$2', [req.params.id, cid]);
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
    al.nome AS aluguel_nome, al.valor AS aluguel_valor,
    COALESCE(m.nome, al.nome) AS servico_nome,
    r.bebida, r.preco_bebida,
    rc.nome AS recepcionista_nome
  FROM reservas r
  JOIN quartos q ON r.quarto_id=q.id
  JOIN profissionais p ON r.profissional_id=p.id
  LEFT JOIN massagens m ON r.massagem_id=m.id
  LEFT JOIN alugueis al ON r.aluguel_id=al.id
  LEFT JOIN recepcionistas rc ON r.recepcionista_id=rc.id
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
            massagem_id, aluguel_id, cliente_nome, cliente_telefone, observacoes,
            bebida, preco_bebida, recepcionista_id, pagamento } = req.body;
    const cid = getClinicaId(req);
    if (!data||!hora_inicio||!hora_fim||!quarto_id||!profissional_id||(!massagem_id&&!aluguel_id)||!cliente_nome)
      throw new Error('Preencha todos os campos obrigatórios');
    const cQ = await qOne(
      `SELECT id FROM reservas WHERE clinica_id=$1 AND quarto_id=$2 AND data=$3 AND status!='cancelada' AND hora_inicio<$4 AND hora_fim>$5`,
      [cid, quarto_id, data, hora_fim, hora_inicio]);
    if (cQ) throw new Error('Sala já reservada neste horário');
    const cP = await qOne(
      `SELECT id FROM reservas WHERE clinica_id=$1 AND profissional_id=$2 AND data=$3 AND status!='cancelada' AND hora_inicio<$4 AND hora_fim>$5`,
      [cid, profissional_id, data, hora_fim, hora_inicio]);
    if (cP) throw new Error('Massagista já tem atendimento neste horário');
    const nova = await qOne(
      'INSERT INTO reservas (data,hora_inicio,hora_fim,quarto_id,profissional_id,massagem_id,aluguel_id,clinica_id,cliente_nome,cliente_telefone,observacoes,bebida,preco_bebida,recepcionista_id,pagamento) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id',
      [data, hora_inicio, hora_fim, quarto_id, profissional_id, massagem_id||null, aluguel_id||null, cid, cliente_nome.trim(), cliente_telefone||null, observacoes||null, bebida||null, parseFloat(preco_bebida)||0, recepcionista_id||null, pagamento||null]);
    return qOne(`${RJ} WHERE r.id=$1`, [nova.id]);
  }));

app.put('/api/reservas/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const id  = parseInt(req.params.id);
    const cid = getClinicaId(req);
    const { data, hora_inicio, hora_fim, quarto_id, profissional_id,
            massagem_id, aluguel_id, cliente_nome, cliente_telefone, status, observacoes,
            bebida, preco_bebida, recepcionista_id, pagamento } = req.body;
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
      'UPDATE reservas SET data=$1,hora_inicio=$2,hora_fim=$3,quarto_id=$4,profissional_id=$5,massagem_id=$6,aluguel_id=$7,cliente_nome=$8,cliente_telefone=$9,status=$10,observacoes=$11,bebida=$12,preco_bebida=$13,recepcionista_id=$14,pagamento=$15 WHERE id=$16 AND clinica_id=$17',
      [data, hora_inicio, hora_fim, quarto_id, profissional_id, massagem_id||null, aluguel_id||null,
       cliente_nome.trim(), cliente_telefone||null, status||'confirmada', observacoes||null,
       bebida||null, parseFloat(preco_bebida)||0, recepcionista_id||null, pagamento||null, id, cid]);
    return qOne(`${RJ} WHERE r.id=$1`, [id]);
  }));

app.delete('/api/reservas/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    await qRun("UPDATE reservas SET status='cancelada' WHERE id=$1 AND clinica_id=$2", [req.params.id, cid]);
    return { id: parseInt(req.params.id) };
  }));

// ─── Dashboard pagamentos ────────────────────────────────────────────────────
app.get('/api/dashboard/pagamentos', requireDashboard, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { mes, ano } = req.query;
    if (!mes || !ano) throw new Error('Mês e ano são obrigatórios');
    const pref = `${ano}-${String(mes).padStart(2,'0')}%`;
    const rows = await q(`
      SELECT
        COALESCE(pagamento, 'Não informado') AS metodo,
        COUNT(*) AS qtd,
        SUM(m.preco) AS total_massagens,
        SUM(r.preco_bebida) AS total_bebidas,
        SUM(m.preco + r.preco_bebida) AS total_geral
      FROM reservas r
      LEFT JOIN massagens m ON r.massagem_id = m.id
      WHERE r.clinica_id=$1 AND r.data LIKE $2 AND r.status != 'cancelada' AND r.massagem_id IS NOT NULL
      GROUP BY metodo
      ORDER BY total_geral DESC
    `, [cid, pref]);
    const totais = await qOne(`
      SELECT
        COUNT(*) AS qtd_total,
        SUM(m.preco) AS total_massagens,
        SUM(r.preco_bebida) AS total_bebidas,
        SUM(m.preco + r.preco_bebida) AS total_geral
      FROM reservas r
      LEFT JOIN massagens m ON r.massagem_id = m.id
      WHERE r.clinica_id=$1 AND r.data LIKE $2 AND r.status != 'cancelada' AND r.massagem_id IS NOT NULL
    `, [cid, pref]);
    return { rows, totais };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD FINANCEIRO
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/dashboard/massagista-mensal', requireDashboard, (req, res) =>
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
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(m.preco,0) + COALESCE(r.preco_bebida,0) - COALESCE(al.valor,0) ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(r.preco_bebida,0) ELSE 0 END), 0) AS total_bebidas,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' AND r.massagem_id IS NOT NULL THEN COALESCE(m.preco,0) ELSE 0 END), 0) AS total_massagens_bruto,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' AND r.aluguel_id IS NOT NULL THEN COALESCE(al.valor,0) ELSE 0 END), 0) AS total_alugueis,
        COUNT(CASE WHEN r.status = 'confirmada' THEN 1 END)                             AS confirmadas,
        COUNT(CASE WHEN r.status = 'concluida'  THEN 1 END)                             AS concluidas,
        COUNT(CASE WHEN r.status = 'cancelada'  THEN 1 END)                             AS canceladas
      FROM profissionais p
      LEFT JOIN reservas  r ON r.profissional_id = p.id AND r.clinica_id = $1 AND r.data LIKE $2
      LEFT JOIN massagens m ON m.id = r.massagem_id
      LEFT JOIN alugueis al ON al.id = r.aluguel_id
      WHERE p.clinica_id = $1 AND p.ativo = 1
      GROUP BY p.id, p.nome, p.nome_fantasia
      ORDER BY total DESC NULLS LAST, p.nome
    `, [cid, pref]);
  }));

app.get('/api/dashboard/massagista-diario', requireDashboard, (req, res) =>
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
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(m.preco,0) + COALESCE(r.preco_bebida,0) - COALESCE(al.valor,0) ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(r.preco_bebida,0) ELSE 0 END), 0) AS total_bebidas,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' AND r.massagem_id IS NOT NULL THEN COALESCE(m.preco,0) ELSE 0 END), 0) AS total_massagens_bruto,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' AND r.aluguel_id IS NOT NULL THEN COALESCE(al.valor,0) ELSE 0 END), 0) AS total_alugueis,
        COUNT(CASE WHEN r.status = 'confirmada' THEN 1 END)                             AS confirmadas,
        COUNT(CASE WHEN r.status = 'concluida'  THEN 1 END)                             AS concluidas,
        COUNT(CASE WHEN r.status = 'cancelada'  THEN 1 END)                             AS canceladas
      FROM profissionais p
      LEFT JOIN reservas  r ON r.profissional_id = p.id AND r.clinica_id = $1 AND r.data = $2
      LEFT JOIN massagens m ON m.id = r.massagem_id
      LEFT JOIN alugueis al ON al.id = r.aluguel_id
      WHERE p.clinica_id = $1 AND p.ativo = 1
      GROUP BY p.id, p.nome, p.nome_fantasia
      ORDER BY total DESC NULLS LAST, p.nome
    `, [cid, data]);
  }));

app.get('/api/dashboard/massagem-mensal', requireDashboard, (req, res) =>
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

app.get('/api/dashboard/massagem-diario', requireDashboard, (req, res) =>
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

// ═══════════════════════════════════════════════════════════════════════════════
// RECEPCIONISTAS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/recepcionistas', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    return q('SELECT * FROM recepcionistas WHERE clinica_id=$1 ORDER BY nome', [cid]);
  }));

app.post('/api/recepcionistas', requireAuth, (req, res) =>
  send(res, async () => {
    const { nome, cpf, data_nascimento, telefone, email } = req.body;
    const cid = getClinicaId(req);
    if (!nome) throw new Error('Nome é obrigatório');
    return qOne(
      'INSERT INTO recepcionistas (nome,cpf,data_nascimento,telefone,email,clinica_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [nome.trim(), cpf||null, data_nascimento||null, telefone||null, email||null, cid]
    );
  }));

app.put('/api/recepcionistas/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const { nome, cpf, data_nascimento, telefone, email, ativo } = req.body;
    const cid = getClinicaId(req);
    if (!nome) throw new Error('Nome é obrigatório');
    await qRun(
      'UPDATE recepcionistas SET nome=$1,cpf=$2,data_nascimento=$3,telefone=$4,email=$5,ativo=$6 WHERE id=$7 AND clinica_id=$8',
      [nome.trim(), cpf||null, data_nascimento||null, telefone||null, email||null, ativo??1, req.params.id, cid]
    );
    return qOne('SELECT * FROM recepcionistas WHERE id=$1', [req.params.id]);
  }));

app.delete('/api/recepcionistas/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    await qRun('DELETE FROM recepcionistas WHERE id=$1 AND clinica_id=$2', [req.params.id, cid]);
    return { id: parseInt(req.params.id) };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// REPASSE CONFIG
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/repasse', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const r = await qOne('SELECT percentual FROM repasse_config WHERE clinica_id=$1', [cid]);
    return { percentual: r ? parseFloat(r.percentual) : 0 };
  }));

app.put('/api/repasse', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { percentual } = req.body;
    const pct = parseFloat(percentual) || 0;
    await qRun(
      'INSERT INTO repasse_config (clinica_id, percentual) VALUES ($1,$2) ON CONFLICT (clinica_id) DO UPDATE SET percentual=$2',
      [cid, pct]
    );
    return { percentual: pct };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD — RECEPCIONISTA MENSAL
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/dashboard/recepcionista-mensal', requireDashboard, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { mes, ano } = req.query;
    if (!mes || !ano) throw new Error('Mês e ano são obrigatórios');
    const pref = `${ano}-${String(mes).padStart(2,'0')}%`;
    return q(`
      SELECT
        rc.id,
        rc.nome,
        COUNT(CASE WHEN r.status != 'cancelada' THEN 1 END) AS total_agendamentos,
        COUNT(CASE WHEN r.status = 'confirmada'  THEN 1 END) AS confirmadas,
        COUNT(CASE WHEN r.status = 'concluida'   THEN 1 END) AS concluidas,
        COUNT(CASE WHEN r.status = 'cancelada'   THEN 1 END) AS canceladas,
        json_agg(
          json_build_object('massagem', m.nome, 'status', r.status)
          ORDER BY m.nome
        ) FILTER (WHERE r.id IS NOT NULL) AS detalhes_massagens
      FROM recepcionistas rc
      LEFT JOIN reservas r   ON r.recepcionista_id = rc.id AND r.clinica_id = $1 AND r.data LIKE $2
      LEFT JOIN massagens m  ON m.id = r.massagem_id
      WHERE rc.clinica_id = $1 AND rc.ativo = 1
      GROUP BY rc.id, rc.nome
      ORDER BY total_agendamentos DESC NULLS LAST, rc.nome
    `, [cid, pref]);
  }));

// Endpoint para gerenciar perfil das clínicas (admin)
app.put('/api/admin/clinicas/:id/perfil', requireAdmin, (req, res) =>
  send(res, async () => {
    const { perfil } = req.body;
    if (!['clinica','gerente'].includes(perfil)) throw new Error('Perfil inválido');
    await qRun('UPDATE clinicas SET perfil=$1 WHERE id=$2', [perfil, req.params.id]);
    return qOne('SELECT id,nome,email,ativo,perfil FROM clinicas WHERE id=$1', [req.params.id]);
  }));

// ─── E-mail via Resend ────────────────────────────────────────────────────────
function sendEmail({ to, subject, html }) {
  return new Promise((resolve, reject) => {
    const RESEND_KEY = process.env.RESEND_API_KEY || '';
    if (!RESEND_KEY) { console.warn('RESEND_API_KEY nao configurada'); return resolve(); }
    const FROM = process.env.RESEND_FROM || 'Massagem Reserva <onboarding@resend.dev>';
    const body = JSON.stringify({ from: FROM, to: [to], subject, html });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ─── Esqueceu a senha ─────────────────────────────────────────────────────────
app.post('/api/auth/forgot-password', (req, res) =>
  send(res, async () => {
    const { email } = req.body;
    if (!email) throw new Error('Informe o e-mail');
    const em = email.trim().toLowerCase();

    let found = null;
    const adm = await qOne('SELECT id, email, nome FROM admins WHERE LOWER(email)=$1 AND ativo=1', [em]);
    if (adm) { found = { ...adm, role: 'admin' }; }
    if (!found) {
      const cl = await qOne('SELECT id, email, nome FROM clinicas WHERE LOWER(email)=$1 AND ativo=1', [em]);
      if (cl) { found = { ...cl, role: 'clinica' }; }
    }
    if (!found) {
      const gr = await qOne('SELECT id, email, nome FROM gerentes WHERE LOWER(email)=$1 AND ativo=1', [em]);
      if (gr) { found = { ...gr, role: 'gerente' }; }
    }

    if (!found) return { ok: true }; // nao revela se e-mail existe

    const token = jwt.sign(
      { id: found.id, email: found.email, role: found.role, purpose: 'reset' },
      JWT_SECRET, { expiresIn: '1h' }
    );

    const appUrl = process.env.APP_URL || ('https://' + (req.headers.host || 'localhost:3000'));
    const link = appUrl + '/?reset=' + token;

    await sendEmail({
      to: found.email,
      subject: 'Massagem Reserva — Redefinicao de Senha',
      html:
        '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
        '<h2 style="color:#3d5a6b">Redefinicao de Senha</h2>' +
        '<p style="color:#555">Ola, <strong>' + (found.nome || found.email) + '</strong>!</p>' +
        '<p style="color:#555;margin:12px 0">Recebemos uma solicitacao para redefinir a senha da sua conta no <strong>Massagem Reserva</strong>.</p>' +
        '<p style="margin:24px 0"><a href="' + link + '" style="background:#7fb3d3;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Redefinir minha senha</a></p>' +
        '<p style="color:#999;font-size:12px">Este link expira em <strong>1 hora</strong>. Se voce nao solicitou a redefinicao, ignore este e-mail.</p>' +
        '<hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>' +
        '<p style="color:#bbb;font-size:11px">Massagem Reserva - CRM para Spas</p></div>'
    });
    return { ok: true };
  }));

// ─── Redefinir senha ──────────────────────────────────────────────────────────
app.post('/api/auth/reset-password', (req, res) =>
  send(res, async () => {
    const { token, nova_senha } = req.body;
    if (!token || !nova_senha) throw new Error('Dados incompletos');
    if (nova_senha.length < 6) throw new Error('A senha deve ter pelo menos 6 caracteres');

    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); }
    catch (e) { throw new Error('Link invalido ou expirado. Solicite um novo.'); }

    if (payload.purpose !== 'reset') throw new Error('Token invalido');

    const hash = await bcrypt.hash(nova_senha, 10);
    const { id, role } = payload;

    if (role === 'admin')        await qRun('UPDATE admins    SET senha_hash=$1 WHERE id=$2', [hash, id]);
    else if (role === 'clinica') await qRun('UPDATE clinicas  SET senha_hash=$1 WHERE id=$2', [hash, id]);
    else if (role === 'gerente') await qRun('UPDATE gerentes  SET senha_hash=$1 WHERE id=$2', [hash, id]);
    else throw new Error('Perfil desconhecido');

    return { ok: true };
  }));

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () =>
    console.log(`\n💆 Massagem Reserva rodando em http://localhost:${PORT}\n`));
}).catch(err => {
  console.error('Erro ao conectar ao banco:', err.message);
  process.exit(1);
});
