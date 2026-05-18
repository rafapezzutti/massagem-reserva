# 💆 Massagem Reserva — CRM para Spa de Massagem

Sistema web completo para gerenciamento de reservas de spa: quartos, profissionais, massagens e agenda.

---

## ✅ Pré-requisitos

- [Node.js](https://nodejs.org/) versão 18 ou superior

---

## 🚀 Como instalar e rodar

1. **Abra o terminal** na pasta `massagem-reserva`

2. **Instale as dependências:**
   ```bash
   npm install
   ```

3. **Inicie o servidor:**
   ```bash
   npm start
   ```

4. **Acesse no navegador:**
   ```
   http://localhost:3000
   ```

Para desenvolvimento com reinício automático:
```bash
npm run dev
```

---

## 📱 Acesso pelo celular

Com o servidor rodando no computador, descubra o IP local (ex.: `192.168.1.100`) e acesse:
```
http://192.168.1.100:3000
```

---

## 🗂️ Funcionalidades

- **📅 Visão Diária** — Timeline de quartos × horários com reservas do dia
- **📆 Visão Mensal** — Calendário completo com contagem de reservas por dia
- **🛏 Quartos** — Cadastro com nome, número e hidromassagem
- **👤 Profissionais** — Cadastro completo de massagistas
- **💆 Massagens** — Catálogo de serviços com duração e preço
- **📋 Reservas** — Criação, edição e cancelamento de reservas

---

## 🗃️ Banco de dados

O banco SQLite é criado automaticamente em `massagem-reserva.db` na primeira execução.
Os dados ficam salvos localmente e persistem entre reinicializações do servidor.

---

## 🎨 Design

Paleta refinada em tons pastéis — Azul Celeste & Pêssego — responsivo para PC e celular.
