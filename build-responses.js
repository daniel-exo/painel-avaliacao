#!/usr/bin/env node
/*
 * Monta responses.json a partir do payload que o Power Automate envia via
 * repository_dispatch.
 *
 * Contexto: o formato original ({"rows":[{cabeçalho: valor}]}) repetia os ~40
 * títulos de pergunta em cada linha — 5 KB por resposta — e estourava o limite
 * do client_payload do GitHub na 12ª resposta, com 422 "client_payload is too
 * large". A esteira morria em silêncio e o painel continuava servindo a última
 * carga boa.
 *
 * Formatos aceitos, do mais enxuto ao legado:
 *   {"csv": "..."}                     saída da ação "Criar tabela CSV"
 *   {"h":[...], "sep":"|", "r":[...]}  linhas delimitadas
 *   {"h":[...], "r":[[...]]}           linhas como arrays
 *   {"rows":[{...}]}                   formato antigo
 *
 * Uso: node build-responses.js <payload.json> <responses.json> [schema.json]
 */
"use strict";
const fs = require("fs");

const [, , payloadPath, outPath, schemaPath = "schema.json"] = process.argv;

const die = msg => { console.error("::error::" + msg); process.exit(1); };
const warn = msg => console.log("::warning::" + msg);

/* ---------- CSV (RFC 4180): aspas duplicadas e campos multilinha ---------- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ""));
}

/* ---------- Normalização e validação -------------------------------------- */
const clean = s => String(s == null ? "" : s).replace(/[\s ]+/g, " ").trim();
const isQuestion = h => /\n/.test(h) && !/\?\s*$|^avaliador\s*:?\s*$/i.test(clean(h));

// A checagem que impede o pior cenário: colunas desalinhadas produzem um painel
// que PARECE certo e está errado. As notas são sempre 1..5 e o tipo é sempre
// Autoavaliação/Gestor — se isso não bater, a ordem das colunas mudou.
function validate(headers, rows) {
  const qIdx = headers.map((h, i) => (isQuestion(h) ? i : -1)).filter(i => i >= 0);
  if (qIdx.length < 5) die(`Só ${qIdx.length} colunas de pergunta reconhecidas em ${headers.length}. ` +
    `Cabeçalho provavelmente desalinhado.`);

  let ok = 0, bad = 0;
  const amostras = [];
  rows.forEach(r => qIdx.forEach(i => {
    const v = clean(r[i]);
    if (v === "") return;
    if (/^[1-5]$/.test(v)) ok++;
    else { bad++; if (amostras.length < 5) amostras.push(`col ${i}="${v.slice(0, 25)}"`); }
  }));
  if (ok + bad === 0) die("Nenhuma nota encontrada nas colunas de pergunta.");
  if (bad / (ok + bad) > 0.05)
    die(`${bad} de ${ok + bad} notas fora da escala 1..5 (${amostras.join("; ")}). ` +
        `A ordem das colunas não bate com o esperado — nada foi gravado.`);
  if (bad) warn(`${bad} nota(s) fora da escala 1..5, dentro da tolerância.`);

  const tIdx = headers.findIndex(h => /^avaliador\s*:?\s*$/i.test(clean(h)) || /quem.*avaliar/i.test(h));
  if (tIdx >= 0) {
    const ruins = rows.map(r => clean(r[tIdx])).filter(v => v && !/^(autoavalia|gestor)/i.test(v));
    if (ruins.length > rows.length * 0.1)
      die(`Coluna de tipo de avaliação com valores inesperados: ${[...new Set(ruins)].slice(0, 3).join(", ")}.`);
  } else {
    warn("Coluna 'Avaliador:' não encontrada — o comparativo autoavaliação × gestor ficará vazio.");
  }
  return qIdx.length;
}

/* ---------- Leitura do payload -------------------------------------------- */
let p;
try { p = JSON.parse(fs.readFileSync(payloadPath, "utf8")); }
catch (e) { die("Payload não é JSON válido: " + e.message); }

let schema = null;
try { schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")).columns; } catch (e) {}

let headers, values;

if (typeof p.csv === "string" && p.csv.trim()) {
  const grid = parseCSV(p.csv);
  if (!grid.length) die("Campo 'csv' veio vazio.");

  // Largura real dos dados. Quando o cabeçalho vaza em pedaços, ele vira
  // DEZENAS de linhas curtas — mais numerosas que as próprias respostas — então
  // "largura mais comum" daria a resposta errada. Medimos pelas linhas que
  // começam com um Id numérico; se nenhuma começar (o conector põe @odata.etag
  // na frente), caímos na maior largura observada, que é a do dado.
  const dataRows = grid.filter(r => /^\d+$/.test(clean(r[0])));
  let larguraDados;
  if (dataRows.length) {
    const cont = {};
    dataRows.forEach(r => { cont[r.length] = (cont[r.length] || 0) + 1; });
    larguraDados = Number(Object.keys(cont).sort((a, b) => cont[b] - cont[a])[0]);
  } else {
    larguraDados = Math.max(...grid.map(r => r.length));
  }

  const cabecalhoOk = grid[0].length === larguraDados &&
                      grid[0].some(h => /hora de conclus/i.test(clean(h)));

  // O conector do Excel acrescenta colunas técnicas (@odata.etag,
  // ItemInternalId) que não existem na exportação do Forms — então schema.json
  // pode ter largura diferente da do CSV. Se o cabeçalho veio bom, isso não
  // importa. Se veio quebrado, importa muito: não dá para mapear às cegas.
  if (!cabecalhoOk && schema && larguraDados !== schema.length) {
    const exemplo = grid.find(r => r.length === larguraDados) || [];
    console.log("::group::Diagnóstico do CSV recebido");
    console.log(`Largura dos dados: ${larguraDados} colunas | schema.json: ${schema.length}`);
    console.log(`Primeiros campos de uma linha de dados: ${JSON.stringify(exemplo.slice(0, 6))}`);
    console.log("Primeiras 3 linhas do texto recebido:");
    p.csv.split("\n").slice(0, 3).forEach(l => console.log("  " + l.slice(0, 200)));
    console.log("::endgroup::");
    die(`O CSV tem ${larguraDados} colunas e schema.json descreve ${schema.length}, ` +
        `e o cabeçalho veio quebrado — não é possível mapear com segurança. ` +
        `Veja o diagnóstico acima e atualize schema.json com a lista real de colunas.`);
  }

  const larguraEsperada = cabecalhoOk ? grid[0].length : (schema ? schema.length : larguraDados);

  if (cabecalhoOk) {
    headers = grid[0];
    values = grid.slice(1);
  } else {
    // A ação "Criar tabela CSV" do Power Automate não põe aspas em campos com
    // quebra de linha, e os títulos das perguntas TÊM quebra de linha — então o
    // cabeçalho pode chegar espalhado por várias linhas. Nesse caso usamos a
    // ordem de colunas do schema.json e descartamos tudo até a primeira linha
    // que se pareça com dado (começa com um Id numérico e tem a largura certa).
    if (!schema) die("Cabeçalho do CSV malformado e schema.json ausente.");
    warn("Cabeçalho do CSV veio malformado (quebras de linha nos títulos). Usando a ordem de schema.json.");
    headers = schema;
    const inicio = grid.findIndex((r, i) => i > 0 && r.length === larguraEsperada);
    if (inicio < 0) die(`Nenhuma linha de dados com ${larguraEsperada} campos foi encontrada no CSV.`);
    values = grid.slice(inicio);

    // Usar schema.json só é seguro se a ordem das colunas ainda for a mesma.
    // O cabeçalho vazou espalhado por várias linhas, mas o TEXTO continua lá —
    // então remontamos e conferimos que os títulos aparecem nessa ordem. Sem
    // isso, uma coluna nova ou movida no formulário atribuiria as notas de uma
    // pergunta a outra, e o painel ficaria plausível e errado.
    const bruto = grid.slice(0, inicio).map(r => r.join(",")).join(" ");
    const achatar = s => String(s)
      .replace(/_x([0-9A-Fa-f]{4})_/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/[\s ]+/g, " ").trim().toLowerCase();
    const alvo = achatar(bruto);
    let cursor = 0;
    for (const col of schema) {
      const c = achatar(col);
      if (!c) continue;
      const at = alvo.indexOf(c, cursor);
      if (at < 0)
        die(`A coluna "${clean(col).slice(0, 60)}" não foi encontrada na posição esperada do ` +
            `cabeçalho. A tabela do Excel mudou de forma — atualize schema.json antes de seguir. ` +
            `Nada foi gravado.`);
      cursor = at + c.length;
    }
  }
} else if (Array.isArray(p.h) && Array.isArray(p.r)) {
  headers = p.h;
  values = p.sep ? p.r.map(l => String(l).split(p.sep)) : p.r;
} else if (Array.isArray(p.rows)) {
  headers = Object.keys(p.rows[0] || {});
  values = p.rows.map(r => headers.map(h => r[h]));
} else {
  die("Payload sem 'csv', 'h'/'r' nem 'rows'. Chaves recebidas: " + JSON.stringify(Object.keys(p)));
}

/* ---------- Travas contra carga ruim -------------------------------------- */
if (!values.length) die("Payload chegou com 0 respostas. Abortando para não zerar o painel.");

const errado = values.filter(v => v.length !== headers.length);
if (errado.length)
  die(`${errado.length} linha(s) com número de campos diferente de ${headers.length} ` +
      `(primeira tem ${errado[0].length}). Provável vírgula dentro de um nome.`);

const nQ = validate(headers, values);

let anteriorRows = null, anteriorGeneratedAt = null;
try {
  const old = JSON.parse(fs.readFileSync(outPath, "utf8"));
  anteriorRows = old.rows || [];
  anteriorGeneratedAt = old.generatedAt || null;
} catch (e) {}

if (anteriorRows && anteriorRows.length && values.length < anteriorRows.length)
  die(`Regressão: chegaram ${values.length} respostas, mas o arquivo atual tem ${anteriorRows.length}. Abortando.`);

/* ---------- Escrita -------------------------------------------------------- */
const rows = values.map(v => {
  const o = {};
  headers.forEach((h, i) => { o[h] = v[i] == null ? "" : String(v[i]); });
  return o;
});

// "Hora de conclusão" chega como número de série do Excel; convertemos a mais
// recente para ISO, que é o que o painel usa para mostrar a idade do dado.
const colData = headers.find(h => /^hora de conclus/i.test(clean(h)));
let sourceUpdatedAt = null;
if (colData) {
  const seriais = rows.map(r => parseFloat(r[colData])).filter(n => !isNaN(n));
  if (seriais.length)
    sourceUpdatedAt = new Date(Math.round((Math.max(...seriais) - 25569) * 86400000)).toISOString();
  else warn(`Coluna "${colData}" não trouxe números de série — a data do dado ficará em branco.`);
}

// O carimbo de vida da esteira, com uma sutileza que quase virou um bug:
// se gravássemos generatedAt novo a cada execução, o repositório ganharia um
// commit a cada 30 minutos para sempre. Mas se NUNCA regravássemos quando nada
// muda, o carimbo congelaria — e passadas 24h o painel acusaria "esteira
// parada" com a esteira viva, que é exatamente o alarme falso que destrói a
// confiança no alarme. Solução: quando não há resposta nova, mantemos o
// carimbo (arquivo idêntico, sem commit) até ele completar HEARTBEAT_H horas;
// aí sim renovamos, gerando no máximo dois commits por dia em período parado.
const HEARTBEAT_H = 12;

const semNovidade = anteriorRows && JSON.stringify(anteriorRows) === JSON.stringify(rows);
const idadeCarimbo = anteriorGeneratedAt
  ? (Date.now() - new Date(anteriorGeneratedAt).getTime()) / 3600000
  : Infinity;

let generatedAt;
if (semNovidade && idadeCarimbo < HEARTBEAT_H) {
  generatedAt = anteriorGeneratedAt;
  console.log(`Sem respostas novas e carimbo com ${idadeCarimbo.toFixed(1)}h — arquivo inalterado, nada a commitar.`);
} else if (semNovidade) {
  generatedAt = new Date().toISOString();
  console.log("Sem respostas novas; renovando o carimbo de vida da esteira.");
} else {
  generatedAt = new Date().toISOString();
}

fs.writeFileSync(outPath, JSON.stringify({
  generatedAt,
  sourceUpdatedAt,
  count: rows.length,
  rows
}, null, 1));

console.log(`OK: ${rows.length} respostas, ${headers.length} colunas (${nQ} perguntas), ` +
            `mais recente ${sourceUpdatedAt || "?"}.`);
