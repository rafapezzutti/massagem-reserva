const express = require('express');
const https   = require('https');
const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
neonConfig.webSocketConstructor = ws; // WebSocket em vez de TCP → Neon escala a zero mais rápido
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
  max: 5,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 5000,
});
const q    = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const qOne = (sql, p = []) => pool.query(sql, p).then(r => r.rows[0] || null);
const qRun = (sql, p = []) => pool.query(sql, p);

// Eventos de login (painel de atividade no Master) — autocria + helper
qRun(`CREATE TABLE IF NOT EXISTS login_events (
  id BIGSERIAL PRIMARY KEY, user_id INTEGER, user_name TEXT, user_role TEXT, ip TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(() => {});
qRun('CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events(created_at DESC)').catch(() => {});
const logLogin = (req, id, nome, role) =>
  qRun('INSERT INTO login_events (user_id, user_name, user_role, ip) VALUES ($1,$2,$3,$4)',
    [id, nome, role, (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip]).catch(() => {});

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
  // 3j. Multa por tempo
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS multa_valor NUMERIC(10,2) NOT NULL DEFAULT 0`).catch(()=>{});

  // 3i. Tabela de ausencias de profissionais
  await pool.query(`CREATE TABLE IF NOT EXISTS ausencias (
    id SERIAL PRIMARY KEY,
    profissional_id INTEGER NOT NULL REFERENCES profissionais(id),
    clinica_id INTEGER REFERENCES clinicas(id),
    data DATE NOT NULL,
    hora_inicio TIME,
    hora_fim TIME,
    dia_inteiro INTEGER NOT NULL DEFAULT 1,
    motivo TEXT,
    criado_em TIMESTAMP NOT NULL DEFAULT NOW()
  )`);


  // 3k. Autônomas — massagistas independentes sem clínica
  await pool.query(`
    CREATE TABLE IF NOT EXISTS autonomas (
      id         SERIAL PRIMARY KEY,
      nome       TEXT NOT NULL,
      cpf        TEXT,
      email      TEXT NOT NULL UNIQUE,
      telefone   TEXT,
      senha_hash TEXT NOT NULL,
      ativo      INTEGER NOT NULL DEFAULT 1,
      criado_em  TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS autonoma_locais (
      id          SERIAL PRIMARY KEY,
      autonoma_id INTEGER NOT NULL REFERENCES autonomas(id),
      nome        TEXT NOT NULL,
      endereco    TEXT,
      ativo       INTEGER NOT NULL DEFAULT 1,
      criado_em   TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS autonoma_servicos (
      id          SERIAL PRIMARY KEY,
      autonoma_id INTEGER NOT NULL REFERENCES autonomas(id),
      nome        TEXT NOT NULL,
      descricao   TEXT,
      duracao     INTEGER NOT NULL,
      preco       NUMERIC(10,2) NOT NULL,
      ativa       INTEGER NOT NULL DEFAULT 1,
      criado_em   TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS autonoma_clientes (
      id          SERIAL PRIMARY KEY,
      autonoma_id INTEGER NOT NULL REFERENCES autonomas(id),
      nome        TEXT NOT NULL,
      telefone    TEXT,
      email       TEXT,
      observacoes TEXT,
      criado_em   TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS autonoma_reservas (
      id               SERIAL PRIMARY KEY,
      autonoma_id      INTEGER NOT NULL REFERENCES autonomas(id),
      local_id         INTEGER REFERENCES autonoma_locais(id),
      servico_id       INTEGER REFERENCES autonoma_servicos(id),
      cliente_id       INTEGER REFERENCES autonoma_clientes(id),
      cliente_nome     TEXT NOT NULL,
      cliente_telefone TEXT,
      data             DATE NOT NULL,
      hora_inicio      TIME NOT NULL,
      hora_fim         TIME NOT NULL,
      status           TEXT NOT NULL DEFAULT 'confirmada',
      observacoes      TEXT,
      pagamento        TEXT,
      valor_servico    NUMERIC(10,2) NOT NULL DEFAULT 0,
      multa_valor      NUMERIC(10,2) NOT NULL DEFAULT 0,
      criado_em        TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // 3l. Profissional externo em locações (aluguel) — campo livre
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS profissional_externo TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE reservas ALTER COLUMN profissional_id DROP NOT NULL`).catch(()=>{});

  // 3m. Permissões granulares por gerente (JSON)
  await pool.query(`ALTER TABLE gerentes ADD COLUMN IF NOT EXISTS permissoes TEXT DEFAULT NULL`).catch(()=>{});

  // 3n. Despesas operacionais
  await pool.query(`
    CREATE TABLE IF NOT EXISTS despesas (
      id              SERIAL PRIMARY KEY,
      clinica_id      INTEGER NOT NULL REFERENCES clinicas(id),
      tipo            VARCHAR(50)  NOT NULL DEFAULT 'outro',
      subtipo         VARCHAR(50),
      descricao       VARCHAR(200),
      nome_custom     VARCHAR(100),
      valor           NUMERIC(10,2) NOT NULL DEFAULT 0,
      recorrente      INTEGER NOT NULL DEFAULT 0,
      dia_vencimento  INTEGER,
      data_vencimento DATE,
      data_pagamento  DATE,
      status          VARCHAR(20)  NOT NULL DEFAULT 'pendente',
      observacao      TEXT,
      criado_em       TIMESTAMP DEFAULT NOW()
    )
  `).catch(()=>{});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_despesas_clinica ON despesas(clinica_id)').catch(()=>{});
  await pool.query(`ALTER TABLE despesas ADD COLUMN IF NOT EXISTS reserva_id INTEGER`).catch(()=>{});

  // 3o. Estoque
  await pool.query(`
    CREATE TABLE IF NOT EXISTS estoque (
      id              SERIAL PRIMARY KEY,
      clinica_id      INTEGER NOT NULL REFERENCES clinicas(id),
      nome            VARCHAR(200) NOT NULL,
      unidade         VARCHAR(50)  DEFAULT 'un',
      quantidade      NUMERIC(10,3) NOT NULL DEFAULT 0,
      custo_unitario  NUMERIC(10,2) NOT NULL DEFAULT 0,
      estoque_minimo  NUMERIC(10,3) DEFAULT 0,
      ativo           INTEGER NOT NULL DEFAULT 1,
      criado_em       TIMESTAMP DEFAULT NOW()
    )
  `).catch(()=>{});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS estoque_movimentacoes (
      id              SERIAL PRIMARY KEY,
      estoque_id      INTEGER NOT NULL REFERENCES estoque(id),
      clinica_id      INTEGER NOT NULL,
      tipo            VARCHAR(10) NOT NULL,
      quantidade      NUMERIC(10,3) NOT NULL,
      custo_unitario  NUMERIC(10,2),
      custo_total     NUMERIC(10,2),
      data            DATE NOT NULL DEFAULT CURRENT_DATE,
      observacao      TEXT,
      criado_em       TIMESTAMP DEFAULT NOW()
    )
  `).catch(()=>{});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_estoque_clinica ON estoque(clinica_id)').catch(()=>{});

  // ── Máquinas de cartão ──────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maquinas_cartao (
      id             SERIAL PRIMARY KEY,
      clinica_id     INTEGER NOT NULL,
      nome           TEXT NOT NULL,
      bandeira       TEXT NOT NULL DEFAULT 'Todas',
      taxa_credito   NUMERIC(5,2) NOT NULL DEFAULT 0,
      taxa_debito    NUMERIC(5,2) NOT NULL DEFAULT 0,
      ativo          INTEGER NOT NULL DEFAULT 1,
      criado_em      TIMESTAMP DEFAULT NOW()
    )
  `).catch(()=>{});
  await pool.query(`ALTER TABLE maquinas_cartao ADD COLUMN IF NOT EXISTS taxa_credito_2_6  NUMERIC(5,2) NOT NULL DEFAULT 0`).catch(()=>{});
  await pool.query(`ALTER TABLE maquinas_cartao ADD COLUMN IF NOT EXISTS taxa_credito_7_12 NUMERIC(5,2) NOT NULL DEFAULT 0`).catch(()=>{});
  await pool.query(`ALTER TABLE maquinas_cartao ADD COLUMN IF NOT EXISTS taxa_antecipacao  NUMERIC(5,2) NOT NULL DEFAULT 0`).catch(()=>{});
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS parcelas          INTEGER DEFAULT 1`).catch(()=>{});
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS maquina_cartao_id INTEGER`).catch(()=>{});
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS pagamentos_json TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE quartos  ADD COLUMN IF NOT EXISTS is_externa   INTEGER NOT NULL DEFAULT 0`).catch(()=>{});
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS preco_custom NUMERIC`).catch(()=>{});
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS tem_brinde   BOOLEAN NOT NULL DEFAULT false`).catch(()=>{});
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS valor_brinde NUMERIC(10,2) NOT NULL DEFAULT 0`).catch(()=>{});
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS profissional_id_2 INTEGER`).catch(()=>{});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clinica_admins (
      id         SERIAL PRIMARY KEY,
      clinica_id INTEGER NOT NULL REFERENCES clinicas(id) ON DELETE CASCADE,
      nome       TEXT NOT NULL,
      email      TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      ativo      INTEGER NOT NULL DEFAULT 1,
      criado_em  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `).catch(()=>{});

  // ── Seed: taxas Inter para Bali Spa ─────────────────────────────────────────
  await (async () => {
    try {
      const bali = await pool.query(`SELECT id FROM clinicas WHERE nome ILIKE '%bali%' LIMIT 1`);
      if (!bali.rows.length) return;
      const cid = bali.rows[0].id;
      const existing = await pool.query(`SELECT COUNT(*) FROM maquinas_cartao WHERE clinica_id=$1`, [cid]);
      if (parseInt(existing.rows[0].count) > 0) return;
      const bandeiras = [
        { nome:'Inter Visa',       bandeira:'Visa',             taxa_debito:1.55, taxa_credito:2.73, taxa_credito_2_6:2.92, taxa_credito_7_12:3.34, taxa_antecipacao:2.09 },
        { nome:'Inter Mastercard', bandeira:'Mastercard',       taxa_debito:1.55, taxa_credito:2.73, taxa_credito_2_6:2.92, taxa_credito_7_12:3.34, taxa_antecipacao:2.09 },
        { nome:'Inter Elo',        bandeira:'Elo',              taxa_debito:1.89, taxa_credito:3.22, taxa_credito_2_6:3.70, taxa_credito_7_12:3.97, taxa_antecipacao:2.09 },
        { nome:'Inter Amex',       bandeira:'American Express', taxa_debito:0.00, taxa_credito:3.49, taxa_credito_2_6:4.09, taxa_credito_7_12:4.39, taxa_antecipacao:2.09 },
        { nome:'Inter Hipercard',  bandeira:'Hipercard',        taxa_debito:0.00, taxa_credito:4.46, taxa_credito_2_6:4.09, taxa_credito_7_12:4.39, taxa_antecipacao:2.09 },
      ];
      for (const b of bandeiras) {
        await pool.query(
          `INSERT INTO maquinas_cartao (clinica_id,nome,bandeira,taxa_credito,taxa_debito,taxa_credito_2_6,taxa_credito_7_12,taxa_antecipacao) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [cid, b.nome, b.bandeira, b.taxa_credito, b.taxa_debito, b.taxa_credito_2_6, b.taxa_credito_7_12, b.taxa_antecipacao]
        );
      }
      console.log(`✅ Taxas Inter inseridas para Bali Spa (clinica_id=${cid})`);
    } catch(e) { console.error('Seed Bali Spa cartoes:', e.message); }
  })();

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
// Bloqueia gerentes do dashboard completo (mensal/pagamentos/recepcionistas)
function requireDashboard(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role === 'gerente')
      return res.status(403).json({ ok: false, error: 'Gerentes não têm acesso a este relatório' });
    next();
  });
}
// Verifica permissão de gerente (key = chave de permissão)
function gerenteCan(user, key) {
  if (user.role !== 'gerente') return true;
  const perm = user.permissoes;
  if (!perm) {
    // comportamento legado: apenas diários de massagista/massagem
    return ['dash_dm','dash_dt'].includes(key);
  }
  return !!perm[key];
}
// Permite gerentes com permissão adequada no dashboard
function requireDashDiario(req, res, next) {
  requireAuth(req, res, () => {
    const allowed = ['admin','clinica','gerente'];
    if (!allowed.includes(req.user.role))
      return res.status(403).json({ ok: false, error: 'Acesso negado' });
    next();
  });
}

function requireAutonoma(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'autonoma' && req.user.role !== 'admin')
      return res.status(403).json({ ok: false, error: 'Acesso restrito a autônomas' });
    next();
  });
}
function getAutonomaId(req) {
  if (req.user.role === 'autonoma') return req.user.autonoma_id;
  // admin can pass autonoma_id in query params or body
  const aid = req.query.autonoma_id || req.body?.autonoma_id;
  if (!aid) throw new Error('Selecione uma autônoma no seletor do topo para continuar');
  return parseInt(aid);
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
      logLogin(req, admin.id, admin.nome, 'admin');
      return res.json({ ok: true, data: { token, user: { role: 'admin', nome: admin.nome, email: admin.email } } });
    }

    const clinica = await qOne('SELECT * FROM clinicas WHERE email=$1 AND ativo=1', [em]);
    if (clinica && await bcrypt.compare(senha, clinica.senha_hash)) {
      const token = jwt.sign(
        { id: clinica.id, email: clinica.email, role: 'clinica',
          clinica_id: clinica.id, nome_clinica: clinica.nome },
        JWT_SECRET, { expiresIn: '10h' }
      );
      logLogin(req, clinica.id, clinica.nome, 'clinica');
      return res.json({ ok: true, data: { token,
        user: { role: 'clinica', nome_clinica: clinica.nome, email: clinica.email,
          clinica_id: clinica.id } } });
    }

    // Login via admin secundário de clínica
    const cliAdmin = await qOne('SELECT ca.*, c.nome AS nome_clinica FROM clinica_admins ca JOIN clinicas c ON c.id=ca.clinica_id WHERE ca.email=$1 AND ca.ativo=1 AND c.ativo=1', [em]);
    if (cliAdmin && await bcrypt.compare(senha, cliAdmin.senha_hash)) {
      const token = jwt.sign(
        { id: cliAdmin.id, email: cliAdmin.email, role: 'clinica',
          clinica_id: cliAdmin.clinica_id, nome_clinica: cliAdmin.nome_clinica },
        JWT_SECRET, { expiresIn: '10h' }
      );
      logLogin(req, cliAdmin.id, cliAdmin.nome, 'clinica_admin');
      return res.json({ ok: true, data: { token,
        user: { role: 'clinica', nome_clinica: cliAdmin.nome_clinica, email: cliAdmin.email,
          clinica_id: cliAdmin.clinica_id } } });
    }

    const gerente = await qOne('SELECT * FROM gerentes WHERE email=$1 AND ativo=1', [em]);
    if (gerente && await bcrypt.compare(senha, gerente.senha_hash)) {
      const token = jwt.sign(
        { id: gerente.id, email: gerente.email, role: 'gerente',
          clinica_id: gerente.clinica_id, nome: gerente.nome,
          permissoes: gerente.permissoes ? JSON.parse(gerente.permissoes) : null },
        JWT_SECRET, { expiresIn: '10h' }
      );
      logLogin(req, gerente.id, gerente.nome, 'gerente');
      return res.json({ ok: true, data: { token,
        user: { role: 'gerente', nome: gerente.nome, email: gerente.email, clinica_id: gerente.clinica_id,
          permissoes: gerente.permissoes ? JSON.parse(gerente.permissoes) : null } } });
    }

    const autonoma = await qOne('SELECT * FROM autonomas WHERE email=$1 AND ativo=1', [em]);
    if (autonoma && await bcrypt.compare(senha, autonoma.senha_hash)) {
      const token = jwt.sign(
        { id: autonoma.id, email: autonoma.email, role: 'autonoma',
          autonoma_id: autonoma.id, nome: autonoma.nome },
        JWT_SECRET, { expiresIn: '10h' }
      );
      logLogin(req, autonoma.id, autonoma.nome, 'autonoma');
      return res.json({ ok: true, data: { token,
        user: { role: 'autonoma', nome: autonoma.nome, email: autonoma.email, autonoma_id: autonoma.id } } });
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
      `INSERT INTO clinicas (nome,email,senha_hash,telefone,endereco,emails_adicionais,horario_funcionamento)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id,nome,email,telefone,endereco,emails_adicionais,horario_funcionamento,ativo,criado_em`,
      [nome.trim(), email.toLowerCase().trim(), hash, telefone||null, endereco||null,
       emails_adicionais||null, horario_funcionamento||null]
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

// ── Admins secundários de clínica ─────────────────────────────────────────
app.get('/api/admin/clinicas/:id/admins', requireAdmin, (req, res) =>
  send(res, () => q(
    'SELECT id,nome,email,ativo,criado_em FROM clinica_admins WHERE clinica_id=$1 ORDER BY nome',
    [req.params.id]
  ))
);
app.post('/api/admin/clinicas/:id/admins', requireAdmin, async (req, res) =>
  send(res, async () => {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) throw new Error('Nome, email e senha são obrigatórios');
    const hash = await bcrypt.hash(senha, 10);
    try {
      return await qOne(
        'INSERT INTO clinica_admins (clinica_id,nome,email,senha_hash) VALUES ($1,$2,$3,$4) RETURNING id,nome,email,ativo,criado_em',
        [req.params.id, nome.trim(), email.toLowerCase().trim(), hash]
      );
    } catch (e) {
      if (e.code === '23505') throw new Error('Usuário já existente');
      throw e;
    }
  })
);
app.put('/api/admin/clinicas/:id/admins/:aid', requireAdmin, async (req, res) =>
  send(res, async () => {
    const { nome, email, senha, ativo } = req.body;
    if (senha) {
      const hash = await bcrypt.hash(senha, 10);
      await qRun('UPDATE clinica_admins SET nome=$1,email=$2,senha_hash=$3,ativo=$4 WHERE id=$5 AND clinica_id=$6',
        [nome.trim(), email.toLowerCase().trim(), hash, ativo ?? 1, req.params.aid, req.params.id]);
    } else {
      await qRun('UPDATE clinica_admins SET nome=$1,email=$2,ativo=$3 WHERE id=$4 AND clinica_id=$5',
        [nome.trim(), email.toLowerCase().trim(), ativo ?? 1, req.params.aid, req.params.id]);
    }
    return qOne('SELECT id,nome,email,ativo,criado_em FROM clinica_admins WHERE id=$1', [req.params.aid]);
  })
);
app.delete('/api/admin/clinicas/:id/admins/:aid', requireAdmin, (req, res) =>
  send(res, () => qRun('DELETE FROM clinica_admins WHERE id=$1 AND clinica_id=$2', [req.params.aid, req.params.id]))
);

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
    SELECT g.id, g.nome, g.email, g.ativo, g.criado_em, g.clinica_id, g.permissoes, c.nome AS clinica_nome
    FROM gerentes g LEFT JOIN clinicas c ON g.clinica_id=c.id
    ORDER BY g.nome
  `)));

app.post('/api/admin/gerentes', requireAdmin, (req, res) =>
  send(res, async () => {
    const { nome, email, senha, clinica_id, permissoes } = req.body;
    if (!nome || !email || !senha) throw new Error('Nome, email e senha sao obrigatorios');
    if (!clinica_id) throw new Error('Selecione a clinica do gerente');
    const hash = await bcrypt.hash(senha, 10);
    const permJson = permissoes ? JSON.stringify(permissoes) : null;
    return qOne(
      'INSERT INTO gerentes (nome,email,senha_hash,clinica_id,permissoes) VALUES ($1,$2,$3,$4,$5) RETURNING id,nome,email,ativo,clinica_id,criado_em,permissoes',
      [nome.trim(), email.toLowerCase().trim(), hash, clinica_id, permJson]
    );
  }));

app.put('/api/admin/gerentes/:id', requireAdmin, (req, res) =>
  send(res, async () => {
    const { nome, email, senha, clinica_id, ativo, permissoes } = req.body;
    if (!nome || !email) throw new Error('Nome e email sao obrigatorios');
    const permJson = permissoes !== undefined ? JSON.stringify(permissoes) : undefined;
    if (senha) {
      const hash = await bcrypt.hash(senha, 10);
      await qRun(
        'UPDATE gerentes SET nome=$1,email=$2,senha_hash=$3,clinica_id=$4,ativo=$5,permissoes=$6 WHERE id=$7',
        [nome.trim(), email.toLowerCase().trim(), hash, clinica_id, ativo??1, permJson??null, req.params.id]
      );
    } else {
      await qRun(
        'UPDATE gerentes SET nome=$1,email=$2,clinica_id=$3,ativo=$4,permissoes=$5 WHERE id=$6',
        [nome.trim(), email.toLowerCase().trim(), clinica_id, ativo??1, permJson??null, req.params.id]
      );
    }
    return qOne('SELECT id,nome,email,ativo,clinica_id,criado_em,permissoes FROM gerentes WHERE id=$1', [req.params.id]);
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
      'INSERT INTO quartos (nome,numero,tem_hidromassagem,clinica_id,is_externa) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [nome.trim(), numero, tem_hidromassagem?1:0, cid, req.body.is_externa?1:0]
    );
  }));

app.put('/api/quartos/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const { nome, tem_hidromassagem } = req.body;
    const cid = getClinicaId(req);
    if (!nome) throw new Error('Nome é obrigatório');
    return qOne(
      'UPDATE quartos SET nome=$1,tem_hidromassagem=$2,is_externa=$3 WHERE id=$4 AND clinica_id=$5 RETURNING *',
      [nome.trim(), tem_hidromassagem?1:0, req.body.is_externa?1:0, req.params.id, cid]
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


// ─── Helper: taxa cartão automática ──────────────────────────────────────────
async function gerarDespesasCartao(cid, reservaId, data, clienteNome, pagamentosJson, valorServico) {
  // Apaga despesas de cartão anteriores para esta reserva
  await pool.query(`DELETE FROM despesas WHERE reserva_id=$1 AND clinica_id=$2 AND tipo='tarifa_cartao'`, [reservaId, cid]).catch(()=>{});
  let pagamentos = [];
  if (pagamentosJson) { try { pagamentos = JSON.parse(pagamentosJson); } catch(e) {} }
  for (const pag of pagamentos) {
    if (!['Crédito','Débito'].includes(pag.metodo) || !pag.maquina_cartao_id) continue;
    const mq = await pool.query(`SELECT * FROM maquinas_cartao WHERE id=$1 AND clinica_id=$2`, [pag.maquina_cartao_id, cid]);
    if (!mq.rows.length) continue;
    const m = mq.rows[0];
    const p = parseInt(pag.parcelas) || 1;
    let taxa = 0;
    if (pag.metodo === 'Débito') {
      taxa = parseFloat(m.taxa_debito) || 0;
    } else {
      if (p >= 7)      taxa = parseFloat(m.taxa_credito_7_12) || 0;
      else if (p >= 2) taxa = parseFloat(m.taxa_credito_2_6)  || 0;
      else             taxa = parseFloat(m.taxa_credito)       || 0;
    }
    if (taxa <= 0) continue;
    const valorPag = parseFloat(pag.valor) > 0 ? parseFloat(pag.valor) : parseFloat(valorServico) || 0;
    const valor = Math.round(valorPag * taxa) / 100;
    if (valor <= 0) continue;
    const parcelaStr = pag.metodo === 'Crédito' ? ` ${p}x` : '';
    const descricao = `Taxa cartão ${m.bandeira} (${pag.metodo}${parcelaStr}) – ${clienteNome}`;
    await pool.query(
      `INSERT INTO despesas (clinica_id,tipo,descricao,valor,status,data_pagamento,data_vencimento,reserva_id)
       VALUES ($1,'tarifa_cartao',$2,$3,'pago',$4,$4,$5)`,
      [cid, descricao, valor, data, reservaId]
    ).catch(()=>{});
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESERVAS
// ═══════════════════════════════════════════════════════════════════════════════
const RJ = `
  SELECT r.*,
    q.nome AS quarto_nome, q.numero AS quarto_numero, q.tem_hidromassagem, q.is_externa AS quarto_externa,
    p.nome AS profissional_nome, p.nome_fantasia,
    COALESCE(p.nome_fantasia, p.nome, r.profissional_externo) AS prof_display,
    COALESCE(p2.nome_fantasia, p2.nome) AS prof_display_2,
    m.nome AS massagem_nome, m.duracao AS massagem_duracao, m.preco AS massagem_preco,
    al.nome AS aluguel_nome, al.valor AS aluguel_valor,
    COALESCE(m.nome, al.nome) AS servico_nome,
    r.bebida, r.preco_bebida, r.multa_valor, r.preco_custom, r.tem_brinde, r.valor_brinde,
    rc.nome AS recepcionista_nome
  FROM reservas r
  JOIN quartos q ON r.quarto_id=q.id
  LEFT JOIN profissionais p  ON r.profissional_id=p.id
  LEFT JOIN profissionais p2 ON r.profissional_id_2=p2.id
  LEFT JOIN massagens m ON r.massagem_id=m.id
  LEFT JOIN alugueis al ON r.aluguel_id=al.id
  LEFT JOIN recepcionistas rc ON r.recepcionista_id=rc.id
`;

app.get('/api/reservas/resumo-mensal', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { mes, ano } = req.query;
    if (!mes || !ano) throw new Error('Mês e ano são obrigatórios');
    const _mesPad = mes.padStart(2,'0');
    const inicio = `${ano}-${_mesPad}-01`;
    const proxMes = new Date(parseInt(ano), parseInt(mes), 1);
    const fim = `${proxMes.getFullYear()}-${String(proxMes.getMonth()+1).padStart(2,'0')}-01`;
    return q(`
      SELECT data,
        COUNT(*) AS total,
        SUM(CASE WHEN status='confirmada' THEN 1 ELSE 0 END) AS confirmadas,
        SUM(CASE WHEN status='concluida'  THEN 1 ELSE 0 END) AS concluidas,
        SUM(CASE WHEN status='cancelada'  THEN 1 ELSE 0 END) AS canceladas
      FROM reservas WHERE clinica_id=$1 AND data >= $2 AND data < $3 GROUP BY data ORDER BY data
    `, [cid, inicio, fim]);
  }));

app.get('/api/reservas', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    if (req.query.data)
      return q(`${RJ} WHERE r.clinica_id=$1 AND r.data=$2 ORDER BY r.hora_inicio,q.numero`, [cid, req.query.data]);
    if (req.query.mes && req.query.ano) {
      const _ano=req.query.ano, _mes=req.query.mes.padStart(2,'0');
      const _inicio=`${_ano}-${_mes}-01`;
      const _prox=new Date(parseInt(_ano),parseInt(req.query.mes),1);
      const _fim=`${_prox.getFullYear()}-${String(_prox.getMonth()+1).padStart(2,'0')}-01`;
      return q(`${RJ} WHERE r.clinica_id=$1 AND r.data >= $2 AND r.data < $3 ORDER BY r.data,r.hora_inicio`, [cid, _inicio, _fim]);
    }
    return q(`${RJ} WHERE r.clinica_id=$1 ORDER BY r.data DESC,r.hora_inicio`, [cid]);
  }));

app.post('/api/reservas', requireAuth, (req, res) =>
  send(res, async () => {
    const { data, hora_inicio, hora_fim, quarto_id, profissional_id, profissional_id_2,
            massagem_id, aluguel_id, profissional_externo,
            cliente_nome, cliente_telefone, observacoes,
            bebida, preco_bebida, multa_valor, recepcionista_id,
            pagamentos_json } = req.body;
    // Deriva pagamento principal e campos cartão do primeiro item dos pagamentos
    let pagamento = null, parcelas = 1, maquina_cartao_id = null;
    if (pagamentos_json) {
      try {
        const pags = JSON.parse(pagamentos_json);
        if (pags.length) {
          pagamento = pags[0].metodo || null;
          const card = pags.find(p => ['Crédito','Débito'].includes(p.metodo));
          if (card) { maquina_cartao_id = card.maquina_cartao_id || null; parcelas = card.parcelas || 1; }
        }
      } catch(e) {}
    }
    const cid = getClinicaId(req);
    const pid = profissional_id ? parseInt(profissional_id) : null;
    const isExterno = !pid && profissional_externo?.trim();
    if (!data||!hora_inicio||!hora_fim||!quarto_id||(!massagem_id&&!aluguel_id)||!cliente_nome)
      throw new Error('Preencha todos os campos obrigatórios');
    if (!isExterno && !pid) throw new Error('Selecione uma massagista ou informe o nome do profissional externo');
    // Sala EXTERNA: sem trava de conflito de quarto
    const _quartoInfo = await qOne('SELECT is_externa FROM quartos WHERE id=$1', [quarto_id]);
    if (!_quartoInfo?.is_externa) {
      const cQ = await qOne(
        `SELECT id FROM reservas WHERE clinica_id=$1 AND quarto_id=$2 AND data=$3 AND status!='cancelada' AND hora_inicio<$4 AND hora_fim>$5`,
        [cid, quarto_id, data, hora_fim, hora_inicio]);
      if (cQ) throw new Error('Sala já reservada neste horário');
    }
    if (pid) {
      const cP = await qOne(
        `SELECT id FROM reservas WHERE clinica_id=$1 AND profissional_id=$2 AND data=$3 AND status!='cancelada' AND hora_inicio<$4 AND hora_fim>$5`,
        [cid, pid, data, hora_fim, hora_inicio]);
      if (cP) throw new Error('Massagista já tem atendimento neste horário');
    }
    // Verifica conflito da 2ª massagista
    const pid2 = profissional_id_2 ? parseInt(profissional_id_2) : null;
    if (pid2) {
      const cP2 = await qOne(
        `SELECT id FROM reservas WHERE clinica_id=$1 AND profissional_id=$2 AND data=$3 AND status!='cancelada' AND hora_inicio<$4 AND hora_fim>$5`,
        [cid, pid2, data, hora_fim, hora_inicio]);
      if (cP2) throw new Error('2ª Massagista já tem atendimento neste horário');
    }
    const nova = await qOne(
      'INSERT INTO reservas (data,hora_inicio,hora_fim,quarto_id,profissional_id,massagem_id,aluguel_id,profissional_externo,clinica_id,cliente_nome,cliente_telefone,observacoes,bebida,preco_bebida,multa_valor,recepcionista_id,pagamento,parcelas,maquina_cartao_id,pagamentos_json,preco_custom,tem_brinde,valor_brinde,profissional_id_2) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id',
      [data, hora_inicio, hora_fim, quarto_id, pid, massagem_id||null, aluguel_id||null,
       isExterno ? profissional_externo.trim() : null,
       cid, cliente_nome.trim(), cliente_telefone||null, observacoes||null,
       bebida||null, parseFloat(preco_bebida)||0, parseFloat(multa_valor)||0, recepcionista_id||null, pagamento||null,
       parseInt(parcelas)||1, maquina_cartao_id?parseInt(maquina_cartao_id):null, pagamentos_json||null,
       req.body.preco_custom!=null?parseFloat(req.body.preco_custom)||null:null,
       req.body.tem_brinde===true||req.body.tem_brinde==='true'?true:false,
       parseFloat(req.body.valor_brinde)||0,
       pid2||null]);
    // gerar despesas de taxa cartão automaticamente
    if (pagamentos_json) {
      const svcVal = massagem_id
        ? (await pool.query('SELECT preco FROM massagens WHERE id=$1',[massagem_id]).then(r=>r.rows[0]?.preco||0))
        : (await pool.query('SELECT valor FROM alugueis WHERE id=$1',[aluguel_id]).then(r=>r.rows[0]?.valor||0));
      await gerarDespesasCartao(cid, nova.id, data, cliente_nome.trim(), pagamentos_json, svcVal);
    }
    return qOne(`${RJ} WHERE r.id=$1`, [nova.id]);
  }));

app.put('/api/reservas/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const id  = parseInt(req.params.id);
    const cid = getClinicaId(req);
    const { data, hora_inicio, hora_fim, quarto_id, profissional_id, profissional_id_2,
            massagem_id, aluguel_id, profissional_externo,
            cliente_nome, cliente_telefone, status, observacoes,
            bebida, preco_bebida, multa_valor, recepcionista_id,
            pagamentos_json } = req.body;
    // Deriva pagamento principal e campos cartão do primeiro item dos pagamentos
    let pagamento = null, parcelas = 1, maquina_cartao_id = null;
    if (pagamentos_json) {
      try {
        const pags = JSON.parse(pagamentos_json);
        if (pags.length) {
          pagamento = pags[0].metodo || null;
          const card = pags.find(p => ['Crédito','Débito'].includes(p.metodo));
          if (card) { maquina_cartao_id = card.maquina_cartao_id || null; parcelas = card.parcelas || 1; }
        }
      } catch(e) {}
    }
    const pid = profissional_id ? parseInt(profissional_id) : null;
    const isExterno = !pid && profissional_externo?.trim();
    if (!data||!hora_inicio||!hora_fim||!cliente_nome) throw new Error('Preencha os campos obrigatórios');
    if (!isExterno && !pid) throw new Error('Selecione uma massagista ou informe o nome do profissional externo');
    if (status !== 'cancelada') {
      const _quartoInfoPut = await qOne('SELECT is_externa FROM quartos WHERE id=$1', [quarto_id]);
      if (!_quartoInfoPut?.is_externa) {
        const cQ = await qOne(
          `SELECT id FROM reservas WHERE clinica_id=$1 AND quarto_id=$2 AND data=$3 AND id!=$4 AND status!='cancelada' AND hora_inicio<$5 AND hora_fim>$6`,
          [cid, quarto_id, data, id, hora_fim, hora_inicio]);
        if (cQ) throw new Error('Sala já reservada neste horário');
      }
      if (pid) {
        const cP = await qOne(
          `SELECT id FROM reservas WHERE clinica_id=$1 AND profissional_id=$2 AND data=$3 AND id!=$4 AND status!='cancelada' AND hora_inicio<$5 AND hora_fim>$6`,
          [cid, pid, data, id, hora_fim, hora_inicio]);
        if (cP) throw new Error('Massagista já tem atendimento neste horário');
      }
    }
    // Verifica conflito da 2ª massagista
    const pid2 = profissional_id_2 ? parseInt(profissional_id_2) : null;
    if (pid2 && status !== 'cancelada') {
      const cP2 = await qOne(
        `SELECT id FROM reservas WHERE clinica_id=$1 AND profissional_id=$2 AND data=$3 AND id!=$4 AND status!='cancelada' AND hora_inicio<$5 AND hora_fim>$6`,
        [cid, pid2, data, id, hora_fim, hora_inicio]);
      if (cP2) throw new Error('2ª Massagista já tem atendimento neste horário');
    }
    await qRun(
      'UPDATE reservas SET data=$1,hora_inicio=$2,hora_fim=$3,quarto_id=$4,profissional_id=$5,massagem_id=$6,aluguel_id=$7,profissional_externo=$8,cliente_nome=$9,cliente_telefone=$10,status=$11,observacoes=$12,bebida=$13,preco_bebida=$14,recepcionista_id=$15,pagamento=$16,multa_valor=$17,parcelas=$18,maquina_cartao_id=$19,pagamentos_json=$20,preco_custom=$21,tem_brinde=$22,valor_brinde=$23,profissional_id_2=$24 WHERE id=$25 AND clinica_id=$26',
      [data, hora_inicio, hora_fim, quarto_id, pid, massagem_id||null, aluguel_id||null,
       isExterno ? profissional_externo.trim() : null,
       cliente_nome.trim(), cliente_telefone||null, status||'confirmada', observacoes||null,
       bebida||null, parseFloat(preco_bebida)||0, recepcionista_id||null, pagamento||null,
       parseFloat(multa_valor)||0, parseInt(parcelas)||1, maquina_cartao_id?parseInt(maquina_cartao_id):null,
       pagamentos_json||null, req.body.preco_custom!=null?parseFloat(req.body.preco_custom)||null:null,
       req.body.tem_brinde===true||req.body.tem_brinde==='true'?true:false,
       parseFloat(req.body.valor_brinde)||0,
       pid2||null, id, cid]);
    // atualizar despesas de taxa cartão (apaga e recria)
    if (pagamentos_json) {
      const svcVal = massagem_id
        ? (await pool.query('SELECT preco FROM massagens WHERE id=$1',[massagem_id]).then(r=>r.rows[0]?.preco||0))
        : (await pool.query('SELECT valor FROM alugueis WHERE id=$1',[aluguel_id]).then(r=>r.rows[0]?.valor||0));
      await gerarDespesasCartao(cid, id, data, cliente_nome.trim(), pagamentos_json, svcVal);
    } else {
      // sem pagamentos_json: remove despesa de cartão existente
      await pool.query(`DELETE FROM despesas WHERE reserva_id=$1 AND clinica_id=$2 AND tipo='tarifa_cartao'`,[id,cid]).catch(()=>{});
    }
    return qOne(`${RJ} WHERE r.id=$1`, [id]);
  }));

app.delete('/api/reservas/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    await qRun("UPDATE reservas SET status='cancelada' WHERE id=$1 AND clinica_id=$2", [req.params.id, cid]);
    return { id: parseInt(req.params.id) };
  }));

app.delete('/api/reservas/:id/excluir', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    await qRun('DELETE FROM despesas WHERE reserva_id=$1 AND clinica_id=$2', [req.params.id, cid]).catch(()=>{});
    await qRun('DELETE FROM reservas WHERE id=$1 AND clinica_id=$2', [req.params.id, cid]);
    return { id: parseInt(req.params.id) };
  }));

// ─── Dashboard pagamentos ────────────────────────────────────────────────────
app.get('/api/dashboard/pagamentos', requireDashboard, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { mes, ano } = req.query;
    if (!mes || !ano) throw new Error('Mês e ano são obrigatórios');
    const inicio = `${ano}-${String(mes).padStart(2,'0')}-01`;
    const proximo = new Date(parseInt(ano), parseInt(mes), 1);
    const fim = `${proximo.getFullYear()}-${String(proximo.getMonth()+1).padStart(2,'0')}-01`;
    const rows = await q(`
      SELECT
        COALESCE(pagamento, 'Não informado') AS metodo,
        COUNT(*) AS qtd,
        SUM(m.preco) AS total_massagens,
        SUM(r.preco_bebida) AS total_bebidas,
        SUM(r.multa_valor) AS total_multas,
        SUM(m.preco + r.preco_bebida + r.multa_valor) AS total_geral
      FROM reservas r
      LEFT JOIN massagens m ON r.massagem_id = m.id
      WHERE r.clinica_id=$1 AND r.data >= $2 AND r.data < $3 AND r.status != 'cancelada' AND r.massagem_id IS NOT NULL
      GROUP BY metodo
      ORDER BY total_geral DESC
    `, [cid, inicio, fim]);
    const totais = await qOne(`
      SELECT
        COUNT(*) AS qtd_total,
        SUM(m.preco) AS total_massagens,
        SUM(r.preco_bebida) AS total_bebidas,
        SUM(r.multa_valor) AS total_multas,
        SUM(m.preco + r.preco_bebida + r.multa_valor) AS total_geral
      FROM reservas r
      LEFT JOIN massagens m ON r.massagem_id = m.id
      WHERE r.clinica_id=$1 AND r.data >= $2 AND r.data < $3 AND r.status != 'cancelada' AND r.massagem_id IS NOT NULL
    `, [cid, inicio, fim]);
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
    const inicio = `${ano}-${String(mes).padStart(2,'0')}-01`;
    const proximo = new Date(parseInt(ano), parseInt(mes), 1); // mes is 1-based, Date uses 0-based, so this gives 1st of next month
    const fim = `${proximo.getFullYear()}-${String(proximo.getMonth()+1).padStart(2,'0')}-01`;
    const rows = await q(`
      SELECT
        p.id,
        COALESCE(p.nome_fantasia, p.nome) AS nome_display,
        p.nome                            AS nome_completo,
        COUNT(CASE WHEN r.status != 'cancelada' THEN 1 END)
          + COALESCE(MAX(duo.qtd_ativas),0)                                              AS atendimentos,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN
          CASE WHEN r.profissional_id_2 IS NOT NULL
            THEN (COALESCE(r.preco_custom,m.preco,0) + COALESCE(r.preco_bebida,0) + COALESCE(r.multa_valor,0) + COALESCE(al.valor,0)) / 2.0
            ELSE  COALESCE(r.preco_custom,m.preco,0) + COALESCE(r.preco_bebida,0) + COALESCE(r.multa_valor,0) + COALESCE(al.valor,0)
          END
        ELSE 0 END), 0)
          + COALESCE(MAX(duo.total_duo),0)                                               AS total,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(r.preco_bebida,0) ELSE 0 END), 0) AS total_bebidas,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(r.multa_valor,0) ELSE 0 END), 0) AS total_multas,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' AND r.massagem_id IS NOT NULL THEN
          CASE WHEN r.profissional_id_2 IS NOT NULL
            THEN COALESCE(r.preco_custom,m.preco,0) / 2.0
            ELSE COALESCE(r.preco_custom,m.preco,0)
          END
        ELSE 0 END), 0)
          + COALESCE(MAX(duo.total_massagens_duo),0)                                     AS total_massagens_bruto,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' AND r.aluguel_id IS NOT NULL THEN COALESCE(al.valor,0) ELSE 0 END), 0) AS total_alugueis,
        COUNT(CASE WHEN r.status = 'confirmada' THEN 1 END)
          + COALESCE(MAX(duo.qtd_confirmadas),0)                                         AS confirmadas,
        COUNT(CASE WHEN r.status = 'concluida'  THEN 1 END)
          + COALESCE(MAX(duo.qtd_concluidas),0)                                          AS concluidas,
        COUNT(CASE WHEN r.status = 'cancelada'  THEN 1 END)                             AS canceladas
      FROM profissionais p
      LEFT JOIN reservas  r ON r.profissional_id = p.id AND r.clinica_id = $1 AND r.data >= $2 AND r.data < $3
      LEFT JOIN massagens m ON m.id = r.massagem_id
      LEFT JOIN alugueis al ON al.id = r.aluguel_id
      LEFT JOIN (
        SELECT rd.profissional_id_2                                                              AS prof_id,
               COUNT(CASE WHEN rd.status != 'cancelada' THEN 1 END)                             AS qtd_ativas,
               COUNT(CASE WHEN rd.status = 'confirmada' THEN 1 END)                              AS qtd_confirmadas,
               COUNT(CASE WHEN rd.status = 'concluida'  THEN 1 END)                              AS qtd_concluidas,
               COALESCE(SUM(CASE WHEN rd.status != 'cancelada' THEN
                 (COALESCE(rd.preco_custom, md.preco, 0) + COALESCE(rd.preco_bebida,0) + COALESCE(rd.multa_valor,0)) / 2.0
               ELSE 0 END), 0)                                                                   AS total_duo,
               COALESCE(SUM(CASE WHEN rd.status != 'cancelada' AND rd.massagem_id IS NOT NULL THEN
                 COALESCE(rd.preco_custom, md.preco, 0) / 2.0
               ELSE 0 END), 0)                                                                   AS total_massagens_duo
        FROM reservas rd
        LEFT JOIN massagens md ON md.id = rd.massagem_id
        WHERE rd.clinica_id = $1 AND rd.data >= $2 AND rd.data < $3 AND rd.profissional_id_2 IS NOT NULL
        GROUP BY rd.profissional_id_2
      ) duo ON duo.prof_id = p.id
      WHERE p.clinica_id = $1 AND p.ativo = 1
      GROUP BY p.id, p.nome, p.nome_fantasia
      ORDER BY total DESC NULLS LAST, p.nome
    `, [cid, inicio, fim]);
    const externas = await q(`
      SELECT
        r.profissional_externo            AS nome_display,
        COUNT(CASE WHEN r.status != 'cancelada' THEN 1 END) AS atendimentos,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(al.valor,0) ELSE 0 END), 0) AS total_alugueis,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(al.valor,0) ELSE 0 END), 0) AS total,
        COUNT(CASE WHEN r.status = 'confirmada' THEN 1 END) AS confirmadas,
        COUNT(CASE WHEN r.status = 'concluida'  THEN 1 END) AS concluidas,
        COUNT(CASE WHEN r.status = 'cancelada'  THEN 1 END) AS canceladas
      FROM reservas r
      LEFT JOIN alugueis al ON al.id = r.aluguel_id
      WHERE r.clinica_id=$1 AND r.profissional_id IS NULL AND r.profissional_externo IS NOT NULL
        AND r.data >= $2 AND r.data < $3
      GROUP BY r.profissional_externo
      ORDER BY total_alugueis DESC
    `, [cid, inicio, fim]);
    const pagByMethod = await q(`
      SELECT
        COALESCE(r.pagamento, 'Não informado') AS metodo,
        COUNT(CASE WHEN r.status != 'cancelada' THEN 1 END) AS qtd,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN
          COALESCE(m.preco,0) + COALESCE(r.preco_bebida,0) + COALESCE(r.multa_valor,0) + COALESCE(al.valor,0)
        ELSE 0 END), 0) AS total
      FROM reservas r
      LEFT JOIN massagens m ON m.id = r.massagem_id
      LEFT JOIN alugueis al ON al.id = r.aluguel_id
      WHERE r.clinica_id=$1 AND r.data >= $2 AND r.data < $3 AND r.status != 'cancelada'
      GROUP BY metodo ORDER BY total DESC
    `, [cid, inicio, fim]);
    const pagByProf = await q(`
      SELECT
        COALESCE(p.nome_fantasia, p.nome, r.profissional_externo, '—') AS nome_display,
        COALESCE(r.pagamento, 'Não informado') AS metodo,
        COUNT(*) AS qtd,
        COALESCE(SUM(COALESCE(m.preco,0) + COALESCE(r.preco_bebida,0) + COALESCE(r.multa_valor,0) + COALESCE(al.valor,0)), 0) AS total
      FROM reservas r
      LEFT JOIN profissionais p ON p.id = r.profissional_id
      LEFT JOIN massagens m ON m.id = r.massagem_id
      LEFT JOIN alugueis al ON al.id = r.aluguel_id
      WHERE r.clinica_id=$1 AND r.status != 'cancelada' AND r.data >= $2 AND r.data < $3
      GROUP BY nome_display, metodo ORDER BY nome_display, total DESC
    `, [cid, inicio, fim]);
    return { rows, externas, pagByMethod, pagByProf };
  }));

app.get('/api/dashboard/massagista-diario', requireDashDiario, (req, res) =>
  send(res, async () => {
    if (!gerenteCan(req.user,'dash_dm')) throw new Error('Acesso negado');
    const cid = getClinicaId(req);
    const { data } = req.query;
    if (!data) throw new Error('Data é obrigatória');
    const rows = await q(`
      SELECT
        p.id,
        COALESCE(p.nome_fantasia, p.nome) AS nome_display,
        p.nome                            AS nome_completo,
        COUNT(CASE WHEN r.status != 'cancelada' THEN 1 END)
          + COALESCE(MAX(duo.qtd_ativas),0)                                              AS atendimentos,
        -- Total exibição: regular=preço cheio, duo=price/2 por massagista
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN
          CASE WHEN r.profissional_id_2 IS NOT NULL
            THEN (COALESCE(r.preco_custom,m.preco,0) + COALESCE(r.preco_bebida,0) + COALESCE(r.multa_valor,0) + COALESCE(al.valor,0)) / 2.0
            ELSE  COALESCE(r.preco_custom,m.preco,0) + COALESCE(r.preco_bebida,0) + COALESCE(r.multa_valor,0) + COALESCE(al.valor,0)
          END
        ELSE 0 END), 0)
          + COALESCE(MAX(duo.total_duo),0)                                               AS total,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(r.preco_bebida,0) ELSE 0 END), 0) AS total_bebidas,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(r.multa_valor,0) ELSE 0 END), 0) AS total_multas,
        -- total_massagens_bruto: regular=preço cheio, duo=price/2 → frontend aplica pct% normalmente
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' AND r.massagem_id IS NOT NULL THEN
          CASE WHEN r.profissional_id_2 IS NOT NULL
            THEN COALESCE(r.preco_custom,m.preco,0) / 2.0
            ELSE COALESCE(r.preco_custom,m.preco,0)
          END
        ELSE 0 END), 0)
          + COALESCE(MAX(duo.total_massagens_duo),0)                                     AS total_massagens_bruto,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' AND r.aluguel_id IS NOT NULL THEN COALESCE(al.valor,0) ELSE 0 END), 0) AS total_alugueis,
        COUNT(CASE WHEN r.status = 'confirmada' THEN 1 END)
          + COALESCE(MAX(duo.qtd_confirmadas),0)                                         AS confirmadas,
        COUNT(CASE WHEN r.status = 'concluida'  THEN 1 END)
          + COALESCE(MAX(duo.qtd_concluidas),0)                                          AS concluidas,
        COUNT(CASE WHEN r.status = 'cancelada'  THEN 1 END)                             AS canceladas
      FROM profissionais p
      LEFT JOIN reservas  r ON r.profissional_id = p.id AND r.clinica_id = $1 AND r.data = $2
      LEFT JOIN massagens m ON m.id = r.massagem_id
      LEFT JOIN alugueis al ON al.id = r.aluguel_id
      LEFT JOIN (
        SELECT rd.profissional_id_2                                                              AS prof_id,
               COUNT(CASE WHEN rd.status != 'cancelada' THEN 1 END)                             AS qtd_ativas,
               COUNT(CASE WHEN rd.status = 'confirmada' THEN 1 END)                              AS qtd_confirmadas,
               COUNT(CASE WHEN rd.status = 'concluida'  THEN 1 END)                              AS qtd_concluidas,
               -- 2a massagista: total e massagens_bruto = price/2 (frontend aplica pct% normalmente)
               COALESCE(SUM(CASE WHEN rd.status != 'cancelada' THEN
                 (COALESCE(rd.preco_custom, md.preco, 0) + COALESCE(rd.preco_bebida,0) + COALESCE(rd.multa_valor,0)) / 2.0
               ELSE 0 END), 0)                                                                   AS total_duo,
               COALESCE(SUM(CASE WHEN rd.status != 'cancelada' AND rd.massagem_id IS NOT NULL THEN
                 COALESCE(rd.preco_custom, md.preco, 0) / 2.0
               ELSE 0 END), 0)                                                                   AS total_massagens_duo
        FROM reservas rd
        LEFT JOIN massagens md ON md.id = rd.massagem_id
        WHERE rd.clinica_id = $1 AND rd.data = $2 AND rd.profissional_id_2 IS NOT NULL
        GROUP BY rd.profissional_id_2
      ) duo ON duo.prof_id = p.id
      WHERE p.clinica_id = $1 AND p.ativo = 1
      GROUP BY p.id, p.nome, p.nome_fantasia
      ORDER BY total DESC NULLS LAST, p.nome
    `, [cid, data]);
    const externas = await q(`
      SELECT
        r.profissional_externo            AS nome_display,
        COUNT(CASE WHEN r.status != 'cancelada' THEN 1 END) AS atendimentos,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(al.valor,0) ELSE 0 END), 0) AS total_alugueis,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN COALESCE(al.valor,0) ELSE 0 END), 0) AS total,
        COUNT(CASE WHEN r.status = 'confirmada' THEN 1 END) AS confirmadas,
        COUNT(CASE WHEN r.status = 'concluida'  THEN 1 END) AS concluidas,
        COUNT(CASE WHEN r.status = 'cancelada'  THEN 1 END) AS canceladas
      FROM reservas r
      LEFT JOIN alugueis al ON al.id = r.aluguel_id
      WHERE r.clinica_id=$1 AND r.profissional_id IS NULL AND r.profissional_externo IS NOT NULL
        AND r.data = $2
      GROUP BY r.profissional_externo
      ORDER BY total_alugueis DESC
    `, [cid, data]);
    const pagByMethod = await q(`
      SELECT
        COALESCE(r.pagamento, 'Não informado') AS metodo,
        COUNT(CASE WHEN r.status != 'cancelada' THEN 1 END) AS qtd,
        COALESCE(SUM(CASE WHEN r.status != 'cancelada' THEN
          COALESCE(m.preco,0) + COALESCE(r.preco_bebida,0) + COALESCE(r.multa_valor,0) + COALESCE(al.valor,0)
        ELSE 0 END), 0) AS total
      FROM reservas r
      LEFT JOIN massagens m ON m.id = r.massagem_id
      LEFT JOIN alugueis al ON al.id = r.aluguel_id
      WHERE r.clinica_id=$1 AND r.data = $2 AND r.status != 'cancelada'
      GROUP BY metodo ORDER BY total DESC
    `, [cid, data]);
    const pagByProf = await q(`
      SELECT
        COALESCE(p.nome_fantasia, p.nome, r.profissional_externo, '—') AS nome_display,
        COALESCE(r.pagamento, 'Não informado') AS metodo,
        COUNT(*) AS qtd,
        COALESCE(SUM(COALESCE(m.preco,0) + COALESCE(r.preco_bebida,0) + COALESCE(r.multa_valor,0) + COALESCE(al.valor,0)), 0) AS total
      FROM reservas r
      LEFT JOIN profissionais p ON p.id = r.profissional_id
      LEFT JOIN massagens m ON m.id = r.massagem_id
      LEFT JOIN alugueis al ON al.id = r.aluguel_id
      WHERE r.clinica_id=$1 AND r.status != 'cancelada' AND r.data = $2
      GROUP BY nome_display, metodo ORDER BY nome_display, total DESC
    `, [cid, data]);
    return { rows, externas, pagByMethod, pagByProf };
  }));

app.get('/api/dashboard/massagem-mensal', requireDashboard, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { mes, ano } = req.query;
    if (!mes || !ano) throw new Error('Mês e ano são obrigatórios');
    const inicio = `${ano}-${String(mes).padStart(2,'0')}-01`;
    const proximo = new Date(parseInt(ano), parseInt(mes), 1);
    const fim = `${proximo.getFullYear()}-${String(proximo.getMonth()+1).padStart(2,'0')}-01`;
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
      LEFT JOIN reservas r ON r.massagem_id = m.id AND r.clinica_id = $1 AND r.data >= $2 AND r.data < $3
      WHERE m.clinica_id = $1
      GROUP BY m.id, m.nome, m.duracao, m.preco
      ORDER BY total DESC NULLS LAST, m.nome
    `, [cid, inicio, fim]);
  }));

app.get('/api/dashboard/massagem-diario', requireDashDiario, (req, res) =>
  send(res, async () => {
    if (!gerenteCan(req.user,'dash_dt')) throw new Error('Acesso negado');
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
    const inicio = `${ano}-${String(mes).padStart(2,'0')}-01`;
    const proximo = new Date(parseInt(ano), parseInt(mes), 1);
    const fim = `${proximo.getFullYear()}-${String(proximo.getMonth()+1).padStart(2,'0')}-01`;
    return q(`
      SELECT
        rc.id,
        rc.nome,
        COUNT(CASE WHEN r.status != 'cancelada' THEN 1 END) AS total_agendamentos,
        COUNT(CASE WHEN r.status = 'confirmada'  THEN 1 END) AS confirmadas,
        COUNT(CASE WHEN r.status = 'concluida'   THEN 1 END) AS concluidas,
        COUNT(CASE WHEN r.status = 'cancelada'   THEN 1 END) AS canceladas,
        json_agg(
          json_build_object(
            'massagem', COALESCE(m.nome, '🏷 Aluguel' || CASE WHEN al.nome IS NOT NULL THEN ': ' || al.nome ELSE '' END),
            'status', r.status,
            'tipo', CASE WHEN r.aluguel_id IS NOT NULL THEN 'aluguel' ELSE 'massagem' END,
            'duracao_min', ROUND(EXTRACT(EPOCH FROM (r.hora_fim::time - r.hora_inicio::time))/60)
          )
          ORDER BY COALESCE(m.nome, al.nome)
        ) FILTER (WHERE r.id IS NOT NULL) AS detalhes_massagens
      FROM recepcionistas rc
      LEFT JOIN reservas r   ON r.recepcionista_id = rc.id AND r.clinica_id = $1 AND r.data >= $2 AND r.data < $3
      LEFT JOIN massagens m  ON m.id = r.massagem_id
      LEFT JOIN alugueis  al ON al.id = r.aluguel_id
      WHERE rc.clinica_id = $1 AND rc.ativo = 1
      GROUP BY rc.id, rc.nome
      ORDER BY total_agendamentos DESC NULLS LAST, rc.nome
    `, [cid, inicio, fim]);
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

// ─── Ausências ───────────────────────────────────────────────────────────────
app.get('/api/ausencias', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { profissional_id, data } = req.query;
    let q = 'SELECT * FROM ausencias WHERE clinica_id=$1';
    const params = [cid];
    if (profissional_id) { params.push(profissional_id); q += ` AND profissional_id=$${params.length}`; }
    if (data)            { params.push(data);             q += ` AND data=$${params.length}`; }
    q += ' ORDER BY data DESC, hora_inicio';
    return (await pool.query(q, params)).rows;
  }));

app.post('/api/ausencias', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { profissional_id, data, dia_inteiro, hora_inicio, hora_fim, motivo } = req.body;
    if (!profissional_id || !data) throw new Error('Profissional e data são obrigatórios');
    const r = await qOne(
      'INSERT INTO ausencias (profissional_id,clinica_id,data,dia_inteiro,hora_inicio,hora_fim,motivo) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [profissional_id, cid, data, dia_inteiro??1, dia_inteiro?null:(hora_inicio||null), dia_inteiro?null:(hora_fim||null), motivo||null]
    );
    return r;
  }));

app.delete('/api/ausencias/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    await qRun('DELETE FROM ausencias WHERE id=$1 AND clinica_id=$2', [req.params.id, cid]);
    return { id: parseInt(req.params.id) };
  }));


// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — Autônomas
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/autonomas', requireAdmin, (req, res) =>
  send(res, () => q('SELECT id,nome,cpf,email,telefone,ativo,criado_em FROM autonomas ORDER BY nome')));

app.post('/api/admin/autonomas', requireAdmin, (req, res) =>
  send(res, async () => {
    const { nome, cpf, email, senha, telefone } = req.body;
    if (!nome || !email || !senha) throw new Error('Nome, email e senha são obrigatórios');
    const hash = await bcrypt.hash(senha, 10);
    return qOne(
      'INSERT INTO autonomas (nome,cpf,email,senha_hash,telefone) VALUES ($1,$2,$3,$4,$5) RETURNING id,nome,cpf,email,telefone,ativo,criado_em',
      [nome.trim(), cpf||null, email.toLowerCase().trim(), hash, telefone||null]
    );
  }));

app.put('/api/admin/autonomas/:id', requireAdmin, (req, res) =>
  send(res, async () => {
    const { nome, cpf, email, senha, telefone, ativo } = req.body;
    if (!nome || !email) throw new Error('Nome e email são obrigatórios');
    if (senha) {
      const hash = await bcrypt.hash(senha, 10);
      await qRun('UPDATE autonomas SET nome=$1,cpf=$2,email=$3,senha_hash=$4,telefone=$5,ativo=$6 WHERE id=$7',
        [nome.trim(), cpf||null, email.toLowerCase().trim(), hash, telefone||null, ativo??1, req.params.id]);
    } else {
      await qRun('UPDATE autonomas SET nome=$1,cpf=$2,email=$3,telefone=$4,ativo=$5 WHERE id=$6',
        [nome.trim(), cpf||null, email.toLowerCase().trim(), telefone||null, ativo??1, req.params.id]);
    }
    return qOne('SELECT id,nome,cpf,email,telefone,ativo,criado_em FROM autonomas WHERE id=$1', [req.params.id]);
  }));

app.delete('/api/admin/autonomas/:id', requireAdmin, (req, res) =>
  send(res, async () => {
    const id = req.params.id;
    await qRun('DELETE FROM autonoma_reservas WHERE autonoma_id=$1', [id]);
    await qRun('DELETE FROM autonoma_clientes  WHERE autonoma_id=$1', [id]);
    await qRun('DELETE FROM autonoma_servicos  WHERE autonoma_id=$1', [id]);
    await qRun('DELETE FROM autonoma_locais    WHERE autonoma_id=$1', [id]);
    await qRun('DELETE FROM autonomas WHERE id=$1', [id]);
    return { id: parseInt(id) };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// AUTÔNOMA — Locais
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/autonoma/locais', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    const filtro = req.query.todos ? '' : ' AND ativo=1';
    return q(`SELECT * FROM autonoma_locais WHERE autonoma_id=$1${filtro} ORDER BY nome`, [aid]);
  }));

app.post('/api/autonoma/locais', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    const { nome, endereco } = req.body;
    if (!nome) throw new Error('Nome é obrigatório');
    return qOne('INSERT INTO autonoma_locais (autonoma_id,nome,endereco) VALUES ($1,$2,$3) RETURNING *',
      [aid, nome.trim(), endereco||null]);
  }));

app.put('/api/autonoma/locais/:id', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    const { nome, endereco, ativo } = req.body;
    if (!nome) throw new Error('Nome é obrigatório');
    return qOne('UPDATE autonoma_locais SET nome=$1,endereco=$2,ativo=$3 WHERE id=$4 AND autonoma_id=$5 RETURNING *',
      [nome.trim(), endereco||null, ativo??1, req.params.id, aid]);
  }));

app.delete('/api/autonoma/locais/:id', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    await qRun('DELETE FROM autonoma_locais WHERE id=$1 AND autonoma_id=$2', [req.params.id, aid]);
    return { id: parseInt(req.params.id) };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// AUTÔNOMA — Serviços
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/autonoma/servicos', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    const filtro = req.query.todos ? '' : ' AND ativa=1';
    return q(`SELECT * FROM autonoma_servicos WHERE autonoma_id=$1${filtro} ORDER BY nome`, [aid]);
  }));

app.post('/api/autonoma/servicos', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    const { nome, descricao, duracao, preco } = req.body;
    if (!nome || !duracao || preco==null) throw new Error('Nome, duração e preço são obrigatórios');
    return qOne('INSERT INTO autonoma_servicos (autonoma_id,nome,descricao,duracao,preco) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [aid, nome.trim(), descricao||null, parseInt(duracao), parseFloat(preco)]);
  }));

app.put('/api/autonoma/servicos/:id', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    const { nome, descricao, duracao, preco, ativa } = req.body;
    if (!nome || !duracao || preco==null) throw new Error('Nome, duração e preço são obrigatórios');
    return qOne('UPDATE autonoma_servicos SET nome=$1,descricao=$2,duracao=$3,preco=$4,ativa=$5 WHERE id=$6 AND autonoma_id=$7 RETURNING *',
      [nome.trim(), descricao||null, parseInt(duracao), parseFloat(preco), ativa??1, req.params.id, aid]);
  }));

app.delete('/api/autonoma/servicos/:id', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    await qRun('DELETE FROM autonoma_servicos WHERE id=$1 AND autonoma_id=$2', [req.params.id, aid]);
    return { id: parseInt(req.params.id) };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// AUTÔNOMA — Clientes
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/autonoma/clientes', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    const busca = req.query.q;
    if (busca)
      return q('SELECT * FROM autonoma_clientes WHERE autonoma_id=$1 AND (nome ILIKE $2 OR telefone ILIKE $2) ORDER BY nome',
        [aid, '%'+busca+'%']);
    return q('SELECT * FROM autonoma_clientes WHERE autonoma_id=$1 ORDER BY nome', [aid]);
  }));

app.post('/api/autonoma/clientes', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    const { nome, telefone, email, observacoes } = req.body;
    if (!nome) throw new Error('Nome é obrigatório');
    return qOne('INSERT INTO autonoma_clientes (autonoma_id,nome,telefone,email,observacoes) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [aid, nome.trim(), telefone||null, email||null, observacoes||null]);
  }));

app.put('/api/autonoma/clientes/:id', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    const { nome, telefone, email, observacoes } = req.body;
    if (!nome) throw new Error('Nome é obrigatório');
    return qOne('UPDATE autonoma_clientes SET nome=$1,telefone=$2,email=$3,observacoes=$4 WHERE id=$5 AND autonoma_id=$6 RETURNING *',
      [nome.trim(), telefone||null, email||null, observacoes||null, req.params.id, aid]);
  }));

app.delete('/api/autonoma/clientes/:id', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    await qRun('DELETE FROM autonoma_clientes WHERE id=$1 AND autonoma_id=$2', [req.params.id, aid]);
    return { id: parseInt(req.params.id) };
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// AUTÔNOMA — Reservas
// ═══════════════════════════════════════════════════════════════════════════════
const RJA = `SELECT ar.*,
  als.nome AS local_nome, als.endereco AS local_endereco,
  ass.nome AS servico_nome, ass.duracao AS servico_duracao, ass.preco AS servico_preco,
  ac.nome AS cliente_nome_cad, ac.telefone AS cliente_tel_cad
  FROM autonoma_reservas ar
  LEFT JOIN autonoma_locais als ON als.id=ar.local_id
  LEFT JOIN autonoma_servicos ass ON ass.id=ar.servico_id
  LEFT JOIN autonoma_clientes ac ON ac.id=ar.cliente_id`;

app.get('/api/autonoma/reservas', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    if (req.query.data)
      return q(`${RJA} WHERE ar.autonoma_id=$1 AND ar.data=$2 ORDER BY ar.hora_inicio`, [aid, req.query.data]);
    if (req.query.mes && req.query.ano) {
      const _ano=req.query.ano, _mes=req.query.mes.padStart(2,'0');
      const inicio=`${_ano}-${_mes}-01`;
      const prox=new Date(parseInt(_ano),parseInt(req.query.mes),1);
      const fim=`${prox.getFullYear()}-${String(prox.getMonth()+1).padStart(2,'0')}-01`;
      return q(`${RJA} WHERE ar.autonoma_id=$1 AND ar.data>=$2 AND ar.data<$3 ORDER BY ar.data,ar.hora_inicio`, [aid, inicio, fim]);
    }
    return q(`${RJA} WHERE ar.autonoma_id=$1 ORDER BY ar.data DESC,ar.hora_inicio`, [aid]);
  }));

app.post('/api/autonoma/reservas', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    const { local_id, servico_id, cliente_id, cliente_nome, cliente_telefone,
            data, hora_inicio, hora_fim, observacoes, pagamento, valor_servico, multa_valor } = req.body;
    if (!data||!hora_inicio||!hora_fim||!cliente_nome)
      throw new Error('Data, horário e cliente são obrigatórios');
    const conf = await qOne(
      `SELECT id FROM autonoma_reservas WHERE autonoma_id=$1 AND data=$2 AND status!='cancelada' AND hora_inicio<$3 AND hora_fim>$4`,
      [aid, data, hora_fim, hora_inicio]);
    if (conf) throw new Error('Você já tem um agendamento neste horário');
    return qOne(
      `INSERT INTO autonoma_reservas (autonoma_id,local_id,servico_id,cliente_id,cliente_nome,cliente_telefone,data,hora_inicio,hora_fim,observacoes,pagamento,valor_servico,multa_valor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [aid, local_id||null, servico_id||null, cliente_id||null, cliente_nome, cliente_telefone||null,
       data, hora_inicio, hora_fim, observacoes||null, pagamento||null,
       parseFloat(valor_servico||0), parseFloat(multa_valor||0)]
    );
  }));

app.put('/api/autonoma/reservas/:id', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    const { local_id, servico_id, cliente_id, cliente_nome, cliente_telefone,
            data, hora_inicio, hora_fim, status, observacoes, pagamento, valor_servico, multa_valor } = req.body;
    if (!data||!hora_inicio||!hora_fim||!cliente_nome)
      throw new Error('Data, horário e cliente são obrigatórios');
    await qRun(
      `UPDATE autonoma_reservas SET local_id=$1,servico_id=$2,cliente_id=$3,cliente_nome=$4,
       cliente_telefone=$5,data=$6,hora_inicio=$7,hora_fim=$8,status=$9,observacoes=$10,
       pagamento=$11,valor_servico=$12,multa_valor=$13 WHERE id=$14 AND autonoma_id=$15`,
      [local_id||null, servico_id||null, cliente_id||null, cliente_nome, cliente_telefone||null,
       data, hora_inicio, hora_fim, status||'confirmada', observacoes||null, pagamento||null,
       parseFloat(valor_servico||0), parseFloat(multa_valor||0), req.params.id, aid]
    );
    return qOne(`${RJA} WHERE ar.id=$1`, [req.params.id]);
  }));

app.delete('/api/autonoma/reservas/:id', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    await qRun('DELETE FROM autonoma_reservas WHERE id=$1 AND autonoma_id=$2', [req.params.id, aid]);
    return { id: parseInt(req.params.id) };
  }));

app.get('/api/autonoma/resumo-mensal', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    const { mes, ano } = req.query;
    if (!mes || !ano) throw new Error('Mês e ano são obrigatórios');
    const mesPad = mes.padStart(2,'0');
    const inicio = `${ano}-${mesPad}-01`;
    const prox = new Date(parseInt(ano), parseInt(mes), 1);
    const fim = `${prox.getFullYear()}-${String(prox.getMonth()+1).padStart(2,'0')}-01`;
    return q(`
      SELECT data, COUNT(*) AS total,
        SUM(CASE WHEN status='confirmada' THEN 1 ELSE 0 END) AS confirmadas,
        SUM(CASE WHEN status='concluida'  THEN 1 ELSE 0 END) AS concluidas,
        SUM(CASE WHEN status='cancelada'  THEN 1 ELSE 0 END) AS canceladas
      FROM autonoma_reservas WHERE autonoma_id=$1 AND data>=$2 AND data<$3 GROUP BY data ORDER BY data
    `, [aid, inicio, fim]);
  }));

app.get('/api/autonoma/dashboard', requireAutonoma, (req, res) =>
  send(res, async () => {
    const aid = getAutonomaId(req);
    const { mes, ano } = req.query;
    if (!mes || !ano) throw new Error('Mês e ano são obrigatórios');
    const mesPad = mes.padStart(2,'0');
    const inicio = `${ano}-${mesPad}-01`;
    const prox = new Date(parseInt(ano), parseInt(mes), 1);
    const fim = `${prox.getFullYear()}-${String(prox.getMonth()+1).padStart(2,'0')}-01`;
    const rows = await q(`
      SELECT ar.*, als.nome AS local_nome, ass.nome AS servico_nome
      FROM autonoma_reservas ar
      LEFT JOIN autonoma_locais als ON als.id=ar.local_id
      LEFT JOIN autonoma_servicos ass ON ass.id=ar.servico_id
      WHERE ar.autonoma_id=$1 AND ar.data>=$2 AND ar.data<$3 AND ar.status!='cancelada'
      ORDER BY ar.data,ar.hora_inicio
    `, [aid, inicio, fim]);
    const total_servicos = rows.reduce((s,r) => s + parseFloat(r.valor_servico||0), 0);
    const total_multas   = rows.reduce((s,r) => s + parseFloat(r.multa_valor||0), 0);
    return { rows, totais: { total_servicos, total_multas, total: total_servicos+total_multas, qtd: rows.length } };
  }));


// ─── Despesas ─────────────────────────────────────────────────────────────────
app.get('/api/despesas', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { mes, ano, status } = req.query;
    let q2 = 'SELECT * FROM despesas WHERE clinica_id=$1';
    const p = [cid];
    if (mes && ano) {
      q2 += ` AND (EXTRACT(MONTH FROM data_vencimento)=$${p.length+1} AND EXTRACT(YEAR FROM data_vencimento)=$${p.length+2})`;
      p.push(parseInt(mes), parseInt(ano));
    }
    if (status) { q2 += ` AND status=$${p.length+1}`; p.push(status); }
    q2 += ' ORDER BY data_vencimento NULLS LAST, id';
    return pool.query(q2, p).then(r => r.rows);
  }));

app.post('/api/despesas', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { tipo, subtipo, descricao, nome_custom, valor, recorrente,
            dia_vencimento, data_vencimento, data_pagamento, status, observacao } = req.body;
    if (!tipo || valor === undefined) throw new Error('Tipo e valor são obrigatórios');
    const r = await pool.query(
      `INSERT INTO despesas (clinica_id,tipo,subtipo,descricao,nome_custom,valor,recorrente,
       dia_vencimento,data_vencimento,data_pagamento,status,observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [cid, tipo, subtipo||null, descricao||null, nome_custom||null, parseFloat(valor)||0,
       recorrente?1:0, dia_vencimento||null, data_vencimento||null,
       data_pagamento||null, status||'pendente', observacao||null]
    );
    return r.rows[0];
  }));

app.put('/api/despesas/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { tipo, subtipo, descricao, nome_custom, valor, recorrente,
            dia_vencimento, data_vencimento, data_pagamento, status, observacao } = req.body;
    await pool.query(
      `UPDATE despesas SET tipo=$1,subtipo=$2,descricao=$3,nome_custom=$4,valor=$5,recorrente=$6,
       dia_vencimento=$7,data_vencimento=$8,data_pagamento=$9,status=$10,observacao=$11
       WHERE id=$12 AND clinica_id=$13`,
      [tipo, subtipo||null, descricao||null, nome_custom||null, parseFloat(valor)||0,
       recorrente?1:0, dia_vencimento||null, data_vencimento||null,
       data_pagamento||null, status||'pendente', observacao||null,
       req.params.id, cid]
    );
    return pool.query('SELECT * FROM despesas WHERE id=$1', [req.params.id]).then(r => r.rows[0]);
  }));

app.delete('/api/despesas/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    await pool.query('DELETE FROM despesas WHERE id=$1 AND clinica_id=$2', [req.params.id, cid]);
    return { ok: true };
  }));

// Fluxo de Caixa — dia a dia para N dias
app.get('/api/despesas/fluxo-caixa', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    // passado = dias antes da data âncora, futuro = dias após, data = âncora (default hoje)
    const passado = Math.min(Math.abs(parseInt(req.query.passado) || 0), 365);
    const futuro  = Math.min(Math.abs(parseInt(req.query.futuro)  || 30), 365);
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const hojeStr = hoje.toISOString().split('T')[0];
    const anchorStr = req.query.data && /^\d{4}-\d{2}-\d{2}$/.test(req.query.data)
      ? req.query.data : hojeStr;
    const anchor = new Date(anchorStr + 'T00:00:00');
    const inicioDate = new Date(anchor.getTime() - passado * 86400000);
    const fimDate    = new Date(anchor.getTime() + futuro  * 86400000);
    const inicio = inicioDate.toISOString().split('T')[0];
    const fim    = fimDate.toISOString().split('T')[0];
    const totalDias = passado + futuro + 1;

    const [recRec, ponRec, receitasRec, repasseCfg] = await Promise.all([
      pool.query('SELECT * FROM despesas WHERE clinica_id=$1 AND recorrente=1', [cid]),
      pool.query(
        `SELECT * FROM despesas WHERE clinica_id=$1 AND recorrente=0
         AND data_vencimento >= $2 AND data_vencimento <= $3`,
        [cid, inicio, fim]
      ),
      pool.query(
        `SELECT r.data,
           SUM(
             CASE
               WHEN r.aluguel_id IS NOT NULL AND r.pagamento='Acerto' THEN 0
               WHEN r.pagamento IS NOT NULL AND r.pagamento ~ '^[0-9]' THEN r.pagamento::numeric
               ELSE COALESCE(m.preco, 0)
                  + COALESCE(r.preco_bebida, 0)
                  + COALESCE(r.multa_valor, 0)
                  + COALESCE(al.valor, 0)
             END
           ) AS valor,
           SUM(
             CASE WHEN r.massagem_id IS NOT NULL THEN
               CASE WHEN r.pagamento IS NOT NULL AND r.pagamento ~ '^[0-9]' THEN r.pagamento::numeric
               ELSE COALESCE(m.preco,0)+COALESCE(r.preco_bebida,0)+COALESCE(r.multa_valor,0) END
             ELSE 0 END
           ) AS massagem_valor,
           SUM(
             CASE WHEN r.aluguel_id IS NOT NULL AND r.pagamento='Acerto'
               THEN COALESCE(al.valor,0) ELSE 0 END
           ) AS aluguel_acerto
         FROM reservas r
         LEFT JOIN massagens m  ON m.id = r.massagem_id
         LEFT JOIN alugueis  al ON al.id = r.aluguel_id
         WHERE r.clinica_id=$1 AND r.data >= $2 AND r.data <= $3
           AND r.status IN ('confirmada','concluida')
         GROUP BY r.data`,
        [cid, inicio, fim]
      ),
      pool.query('SELECT percentual FROM repasse_config WHERE clinica_id=$1', [cid])
    ]);
    const repassePct = repasseCfg.rows.length ? parseFloat(repasseCfg.rows[0].percentual) / 100 : 0;

    const fluxo = {};
    for (let i = 0; i < totalDias; i++) {
      const d = new Date(inicioDate.getTime() + i * 86400000);
      const ds = d.toISOString().split('T')[0];
      fluxo[ds] = { data: ds, receitas: 0, despesas: 0, repasse: 0, saldo_dia: 0, saldo_acum: 0, hoje: ds === anchorStr };
    }

    receitasRec.rows.forEach(r => {
      if (fluxo[r.data]) {
        const rec     = parseFloat(r.valor         || 0);
        const massVal = parseFloat(r.massagem_valor || 0);
        const acerto  = parseFloat(r.aluguel_acerto || 0);
        fluxo[r.data].receitas += rec;
        // repasse apenas sobre massagens; aluguel Acerto reduz o repasse a pagar
        fluxo[r.data].repasse  += massVal * repassePct - acerto;
      }
    });
    ponRec.rows.forEach(d => {
      const k = d.data_vencimento instanceof Date
        ? d.data_vencimento.toISOString().split('T')[0]
        : String(d.data_vencimento).split('T')[0];
      if (fluxo[k]) fluxo[k].despesas += parseFloat(d.valor || 0);
    });
    recRec.rows.forEach(desp => {
      if (!desp.dia_vencimento) return;
      for (let i = 0; i < totalDias; i++) {
        const d = new Date(inicioDate.getTime() + i * 86400000);
        if (d.getDate() === parseInt(desp.dia_vencimento)) {
          const ds = d.toISOString().split('T')[0];
          if (fluxo[ds]) fluxo[ds].despesas += parseFloat(desp.valor || 0);
        }
      }
    });

    let saldo = 0;
    return Object.values(fluxo).map(d => {
      d.repasse    = Math.round(d.repasse * 100) / 100;
      d.saldo_dia  = d.receitas - d.despesas - d.repasse;
      saldo       += d.saldo_dia;
      d.saldo_acum = saldo;
      return d;
    });
  }));

// ─── Fluxo Dia (agenda detalhada de um dia) ─────────────────────────────────
app.get('/api/fluxo-dia', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const data = req.query.data || new Date().toISOString().split('T')[0];
    const diaMes = parseInt(data.split('-')[2]);

    const [reservas, pontuais, recorrentes, repasseCfg] = await Promise.all([
      pool.query(
        `SELECT r.hora_inicio, r.hora_fim, r.status, r.cliente_nome,
                r.pagamento, r.preco_bebida, r.multa_valor, r.bebida,
                r.preco_custom, r.profissional_id_2,
                m.nome AS massagem_nome, m.preco AS massagem_preco,
                al.nome AS aluguel_nome, al.valor AS aluguel_valor,
                p.nome AS profissional_nome,
                COALESCE(p2.nome_fantasia, p2.nome) AS profissional_nome_2,
                q.numero AS quarto_numero
         FROM reservas r
         LEFT JOIN massagens      m  ON m.id  = r.massagem_id
         LEFT JOIN alugueis       al ON al.id = r.aluguel_id
         LEFT JOIN profissionais  p  ON p.id  = r.profissional_id
         LEFT JOIN profissionais  p2 ON p2.id = r.profissional_id_2
         LEFT JOIN quartos        q  ON q.id  = r.quarto_id
         WHERE r.clinica_id=$1 AND r.data=$2
         ORDER BY r.hora_inicio`,
        [cid, data]
      ),
      pool.query(
        `SELECT tipo, nome_custom, descricao, valor, status, recorrente
         FROM despesas WHERE clinica_id=$1 AND recorrente=0
           AND data_vencimento::date = $2::date`,
        [cid, data]
      ),
      pool.query(
        `SELECT tipo, nome_custom, descricao, valor, status, dia_vencimento
         FROM despesas WHERE clinica_id=$1 AND recorrente=1
           AND dia_vencimento=$2`,
        [cid, diaMes]
      ),
      pool.query('SELECT percentual FROM repasse_config WHERE clinica_id=$1', [cid])
    ]);

    const repassePct = repasseCfg.rows.length ? parseFloat(repasseCfg.rows[0].percentual) / 100 : 0;

    const reservasFormatadas = reservas.rows.map(r => {
      const massPrecoBase = r.preco_custom != null ? parseFloat(r.preco_custom) : parseFloat(r.massagem_preco || 0);
      const valorBase = massPrecoBase || (r.aluguel_valor ? parseFloat(r.aluguel_valor) : 0);
      let total = valorBase + parseFloat(r.preco_bebida || 0) + parseFloat(r.multa_valor || 0);
      if (r.pagamento && /^[0-9]/.test(r.pagamento)) total = parseFloat(r.pagamento);
      // Brinde: incluído no total pago pelo cliente, mas excluído da base de repasse
      const valorBrinde = r.tem_brinde ? parseFloat(r.valor_brinde || 0) : 0;
      const totalNetRepasse = Math.max(0, total - valorBrinde);
      const isDuo = !!r.profissional_id_2;
      let repasse = 0;
      if (r.status !== 'cancelada') {
        if (r.aluguel_valor && !r.massagem_preco && !r.preco_custom) {
          // Aluguel: Acerto deduz do repasse da profissional; outros métodos = 0 (pago separadamente)
          if (r.pagamento === 'Acerto') repasse = -Math.round(parseFloat(r.aluguel_valor) * 100) / 100;
        } else {
          // Massagem: duo = 25% cada; simples = % configurado; brinde excluído
          const pct = isDuo ? 0.25 : repassePct;
          repasse = Math.round(totalNetRepasse * pct * 100) / 100;
        }
      }
      return {
        hora_inicio: r.hora_inicio,
        hora_fim:    r.hora_fim,
        status:      r.status,
        cliente:     r.cliente_nome,
        servico:     r.massagem_nome || r.aluguel_nome || '—',
        tipo:        r.aluguel_valor ? 'aluguel' : 'massagem',
        profissional:r.profissional_nome || r.profissional_externo || '—',
        profissional2: r.profissional_nome_2 || null,
        isDuo: !!r.profissional_id_2,
        quarto:      r.quarto_numero,
        total,
        repasse,
        bebida:  r.bebida || null,
        preco_bebida: parseFloat(r.preco_bebida || 0)
      };
    });

    const despesasFormatadas = [
      ...pontuais.rows.map(d => ({...d, recorrente: false})),
      ...recorrentes.rows.map(d => ({...d, recorrente: true}))
    ];

    const totReceita  = reservasFormatadas.filter(r=>r.status!=='cancelada').reduce((s,r)=>s+r.total,0);
    const totRepasse  = reservasFormatadas.filter(r=>r.status!=='cancelada').reduce((s,r)=>s+r.repasse+(r.isDuo?r.repasse:0),0);
    const totDespesas = despesasFormatadas.reduce((s,d)=>s+parseFloat(d.valor||0),0);

    return {
      data,
      reservas:  reservasFormatadas,
      despesas:  despesasFormatadas,
      resumo: {
        receita:  Math.round(totReceita  * 100) / 100,
        repasse:  Math.round(totRepasse  * 100) / 100,
        despesas: Math.round(totDespesas * 100) / 100,
        liquido:  Math.round((totReceita - totRepasse - totDespesas) * 100) / 100
      }
    };
  }));

// ─── Estoque ──────────────────────────────────────────────────────────────────
app.get('/api/estoque', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    return pool.query(
      'SELECT * FROM estoque WHERE clinica_id=$1 AND ativo=1 ORDER BY nome',
      [cid]
    ).then(r => r.rows);
  }));

app.post('/api/estoque', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { nome, unidade, quantidade, custo_unitario, estoque_minimo } = req.body;
    if (!nome) throw new Error('Nome é obrigatório');
    const r = await pool.query(
      `INSERT INTO estoque (clinica_id,nome,unidade,quantidade,custo_unitario,estoque_minimo)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [cid, nome.trim(), unidade||'un', parseFloat(quantidade)||0,
       parseFloat(custo_unitario)||0, parseFloat(estoque_minimo)||0]
    );
    return r.rows[0];
  }));

app.put('/api/estoque/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { nome, unidade, custo_unitario, estoque_minimo, ativo } = req.body;
    await pool.query(
      `UPDATE estoque SET nome=$1,unidade=$2,custo_unitario=$3,estoque_minimo=$4,ativo=$5
       WHERE id=$6 AND clinica_id=$7`,
      [nome.trim(), unidade||'un', parseFloat(custo_unitario)||0,
       parseFloat(estoque_minimo)||0, ativo!==undefined?(ativo?1:0):1,
       req.params.id, cid]
    );
    return pool.query('SELECT * FROM estoque WHERE id=$1', [req.params.id]).then(r => r.rows[0]);
  }));

app.delete('/api/estoque/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    await pool.query('UPDATE estoque SET ativo=0 WHERE id=$1 AND clinica_id=$2', [req.params.id, cid]);
    return { ok: true };
  }));

app.post('/api/estoque/:id/movimentacao', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { tipo, quantidade, custo_unitario, custo_total, data, observacao } = req.body;
    if (!tipo || !quantidade) throw new Error('Tipo e quantidade são obrigatórios');
    const qtd = parseFloat(quantidade);
    const cu  = parseFloat(custo_unitario) || (custo_total ? parseFloat(custo_total)/qtd : 0);
    const ct  = parseFloat(custo_total)    || cu * qtd;
    const delta = tipo === 'entrada' ? qtd : -qtd;
    await pool.query(
      'UPDATE estoque SET quantidade=quantidade+$1 WHERE id=$2 AND clinica_id=$3',
      [delta, req.params.id, cid]
    );
    const r = await pool.query(
      `INSERT INTO estoque_movimentacoes
         (estoque_id,clinica_id,tipo,quantidade,custo_unitario,custo_total,data,observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, cid, tipo, qtd, cu||null, ct||null,
       data||new Date().toISOString().split('T')[0], observacao||null]
    );
    return r.rows[0];
  }));

app.get('/api/estoque/:id/movimentacoes', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    return pool.query(
      `SELECT * FROM estoque_movimentacoes WHERE estoque_id=$1 AND clinica_id=$2
       ORDER BY data DESC, id DESC LIMIT 100`,
      [req.params.id, cid]
    ).then(r => r.rows);
  }));

// ─── Máquinas de Cartão ───────────────────────────────────────────────────────
app.get('/api/maquinas-cartao', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    return pool.query(
      'SELECT * FROM maquinas_cartao WHERE clinica_id=$1 AND ativo=1 ORDER BY nome',
      [cid]
    ).then(r => r.rows);
  }));

app.post('/api/maquinas-cartao', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { nome, bandeira, taxa_credito, taxa_debito,
            taxa_credito_2_6, taxa_credito_7_12, taxa_antecipacao } = req.body;
    if (!nome) throw new Error('Nome é obrigatório');
    const r = await pool.query(
      `INSERT INTO maquinas_cartao (clinica_id,nome,bandeira,taxa_credito,taxa_debito,taxa_credito_2_6,taxa_credito_7_12,taxa_antecipacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cid, nome.trim(), bandeira||'Todas',
       parseFloat(taxa_credito)||0, parseFloat(taxa_debito)||0,
       parseFloat(taxa_credito_2_6)||0, parseFloat(taxa_credito_7_12)||0,
       parseFloat(taxa_antecipacao)||0]
    );
    return r.rows[0];
  }));

app.put('/api/maquinas-cartao/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    const { nome, bandeira, taxa_credito, taxa_debito,
            taxa_credito_2_6, taxa_credito_7_12, taxa_antecipacao } = req.body;
    if (!nome) throw new Error('Nome é obrigatório');
    await pool.query(
      `UPDATE maquinas_cartao SET nome=$1,bandeira=$2,taxa_credito=$3,taxa_debito=$4,
       taxa_credito_2_6=$5,taxa_credito_7_12=$6,taxa_antecipacao=$7
       WHERE id=$8 AND clinica_id=$9`,
      [nome.trim(), bandeira||'Todas',
       parseFloat(taxa_credito)||0, parseFloat(taxa_debito)||0,
       parseFloat(taxa_credito_2_6)||0, parseFloat(taxa_credito_7_12)||0,
       parseFloat(taxa_antecipacao)||0,
       req.params.id, cid]
    );
    return pool.query('SELECT * FROM maquinas_cartao WHERE id=$1', [req.params.id])
      .then(r => r.rows[0]);
  }));

app.delete('/api/maquinas-cartao/:id', requireAuth, (req, res) =>
  send(res, async () => {
    const cid = getClinicaId(req);
    await pool.query(
      'UPDATE maquinas_cartao SET ativo=0 WHERE id=$1 AND clinica_id=$2',
      [req.params.id, cid]
    );
    return { ok: true };
  }));

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () =>
    console.log(`
💆 Massagem Reserva rodando em http://localhost:${PORT}
`));
}).catch(err => {
  console.error('Erro ao conectar ao banco:', err.message);
  process.exit(1);
});
