// ==== Lógica compartilhada: busca da planilha, parsing, agregação e filtros ====
// Usado por index.html, categorias.html e comparativo.html

// responses.json é gerado automaticamente por um fluxo do Power Automate
// (lê a tabela do Excel vinculada ao Microsoft Forms) + um GitHub Actions
// workflow (.github/workflows/update-data.yml) que recebe esse aviso via
// repository_dispatch e commita o arquivo no repositório. Como o arquivo
// vive no mesmo repositório/domínio do site (GitHub Pages), a busca é
// same-origin — sem CORS, sem autenticação, sem depender do OneDrive.
const RESPONSES_JSON_URL = "responses.json";
const REFRESH_MS = 5 * 60 * 1000;
const CATEGORY_COLORS = ["#4C9AFF","#36B37E","#FFAB00","#6554C0","#FF5630","#00B8D9","#B0BEC5"];

// O conector do Excel Online usado pelo Power Automate devolve os nomes das
// colunas no padrão de "escape" do OData: qualquer caractere fora do
// permitido em identificadores vira "_xHHHH_" (código hexadecimal Unicode).
// Isso afeta principalmente o ponto final (".") nos cabeçalhos das perguntas.
// Revertendo esse escape, os cabeçalhos voltam a ficar idênticos ao que o
// parseFields já sabe interpretar.
function unescapeODataKey(s){
  return String(s).replace(/_x([0-9A-Fa-f]{4})_/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// O Excel guarda datas como número de série (dias desde 1899-12-30) — o
// conector do Power Automate devolve esse número cru, em vez de um texto
// formatado. Convertendo para "DD/MM/AAAA HH:MM" para exibição.
function excelSerialToDateStr(serial){
  const n = parseFloat(serial);
  if(isNaN(n)) return serial;
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  const pad = x => String(x).padStart(2, "0");
  return pad(d.getUTCDate()) + "/" + pad(d.getUTCMonth()+1) + "/" + d.getUTCFullYear() + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
}

function scoreClass(v){
  if(v === null || v === undefined || isNaN(v)) return "";
  if(v >= 4.5) return "score-green";
  if(v >= 3.5) return "score-yellow";
  return "score-red";
}

// Mesma faixa de scoreClass, mas retorna uma classe que colore só o texto
// (sem fundo), usada nos números grandes dos cards de KPI.
function scoreTextClass(v){
  if(v === null || v === undefined || isNaN(v)) return "";
  if(v >= 4.5) return "score-text-green";
  if(v >= 3.5) return "score-text-yellow";
  return "score-text-red";
}

function fmt(v){
  if(v === null || v === undefined || isNaN(v)) return "-";
  return (Math.round(v*100)/100).toFixed(2);
}

// Um cabeçalho de pergunta pode vir em dois formatos, dependendo de onde o
// formulário foi criado:
//
// Google Forms (formato antigo):
//   "CATEGORIA\nFrase de valor da categoria. [Pergunta específica.]"
//   → categoria = 1ª linha; frase de valor = subtítulo; pergunta = texto entre colchetes.
//
// Microsoft Forms (formato novo):
//   "Frase de valor da categoria (com a CATEGORIA em maiúsculas).\n.Pergunta específica."
//   → categoria = palavra(s) em maiúsculas dentro da 1ª linha; frase de valor
//     completa = subtítulo; pergunta = 2ª linha, sem o ponto inicial.
//
// Em ambos os casos separamos a categoria, a frase de valor (usada como
// subtítulo da categoria) e a pergunta em si, para não repetir a frase de
// valor em cada linha. Perguntas de identificação do Microsoft Forms (ex.:
// "Quem você vai avaliar?") também trazem uma quebra de linha sobrando no
// final do cabeçalho, mesmo sem serem perguntas de categoria — tratamos esse
// caso como campo comum (metaField), não como pergunta.
function parseFields(fields){
  const questionFields = [];
  const metaFields = [];
  const categorySubtitles = {};
  fields.forEach(f => {
    if(f.includes("\n")){
      const idx = f.indexOf("\n");
      const line1 = f.slice(0, idx).trim();
      const line2 = f.slice(idx+1).trim();

      // Quebra de linha sobrando num campo de identificação (Microsoft Forms) —
      // não é uma pergunta de categoria, então tratamos como campo comum.
      if(line2 === ""){
        if(line1) metaFields.push(f);
        return;
      }

      let category, subtitle, question;
      if(line2.includes("[") && line2.lastIndexOf("]") > line2.indexOf("[")){
        // Formato Google Forms
        category = line1;
        const openIdx = line2.indexOf("[");
        const closeIdx = line2.lastIndexOf("]");
        subtitle = line2.slice(0, openIdx).trim();
        question = line2.slice(openIdx+1, closeIdx).trim();
      } else {
        // Formato Microsoft Forms
        subtitle = line1;
        const capMatch = line1.match(/\p{Lu}[\p{Lu}À-Þ]{2,}/gu);
        const rawCategory = capMatch ? capMatch.join(" ") : line1;
        category = rawCategory.charAt(0) + rawCategory.slice(1).toLowerCase();
        question = line2.replace(/^\.+\s*/, "").trim();
      }

      if(subtitle && !categorySubtitles[category]) categorySubtitles[category] = subtitle;
      questionFields.push({field:f, category, question});
    } else if(f && f.trim() !== ""){
      metaFields.push(f);
    }
  });
  return {questionFields, metaFields, categorySubtitles};
}

// Calcula todos os agregados (médias, melhores/piores categoria, pergunta e
// resposta) a partir de um conjunto de rowStats — pode ser o conjunto
// completo ou um subconjunto já filtrado por avaliador/avaliado.
function computeAggregates(rowStats, categories, questionFields){
  const validOverall = rowStats.map(s=>s.overall).filter(v=>v!==null);
  const overallAvg = validOverall.length ? validOverall.reduce((a,b)=>a+b,0)/validOverall.length : null;

  const catOverallAvg = {};
  categories.forEach(c => {
    const vals = rowStats.map(s=>s.catAvg[c]).filter(v=>v!==null);
    catOverallAvg[c] = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  });

  const validCats = categories.filter(c => catOverallAvg[c] !== null);
  const sortedCats = validCats.slice().sort((a,b)=>catOverallAvg[b]-catOverallAvg[a]);
  const bestCat = sortedCats.length ? sortedCats[0] : null;
  const worstCat = sortedCats.length ? sortedCats[sortedCats.length-1] : null;

  let bestResponse = null, worstResponse = null;
  rowStats.forEach(s => {
    if(s.overall === null) return;
    if(!bestResponse || s.overall > bestResponse.overall) bestResponse = s;
    if(!worstResponse || s.overall < worstResponse.overall) worstResponse = s;
  });

  // Média de cada pergunta individual, considerando as respostas do conjunto.
  const questionAvg = {};
  questionFields.forEach(q => {
    const vals = rowStats.map(s => parseFloat(s.row[q.field])).filter(v => !isNaN(v));
    questionAvg[q.field] = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  });

  let bestQuestion = null, worstQuestion = null;
  questionFields.forEach(q => {
    const avg = questionAvg[q.field];
    if(avg === null) return;
    if(!bestQuestion || avg > bestQuestion.avg) bestQuestion = {...q, avg};
    if(!worstQuestion || avg < worstQuestion.avg) worstQuestion = {...q, avg};
  });

  return {
    overallAvg, catOverallAvg, bestCat, worstCat,
    bestResponse, worstResponse, questionAvg, bestQuestion, worstQuestion
  };
}

// Busca o responses.json (publicado pelo pipeline Power Automate + GitHub
// Actions), parseia e devolve todos os dados já agregados (agregados
// calculados sobre o conjunto completo de respostas).
async function loadDashboardData(){
  const url = RESPONSES_JSON_URL + (RESPONSES_JSON_URL.includes("?") ? "&" : "?") + "_ts=" + Date.now();
  const res = await fetch(url, {cache:"no-store"});
  if(!res.ok) throw new Error("HTTP " + res.status + " ao buscar responses.json");
  const json = await res.json();
  const rawRows = Array.isArray(json.rows) ? json.rows : [];

  // Colunas técnicas adicionadas pelo conector do Power Automate (não fazem
  // parte do formulário original) e chaves com escape OData (ex.: "." vira
  // "_x002e_") — normalizamos antes de qualquer outra coisa.
  const IGNORED_KEYS = new Set(["@odata.etag", "iteminternalid"]);
  const allRows = rawRows.map(r => {
    const clean = {};
    Object.keys(r).forEach(k => {
      if(IGNORED_KEYS.has(k.toLowerCase())) return;
      clean[unescapeODataKey(k)] = r[k];
    });
    return clean;
  });

  const rows = allRows.filter(r => Object.values(r).some(v => v && String(v).trim() !== ""));
  const headerRow = Object.keys(rows.length ? rows[0] : (allRows[0] || {}));
  const {questionFields, metaFields, categorySubtitles} = parseFields(headerRow);

  // Colunas de sistema do Microsoft Forms (Id, Hora de início, Email, Nome)
  // que não existiam no Google Forms — não usamos como campo de texto nem
  // como timestamp principal (usamos "Hora de conclusão" para isso).
  const SYSTEM_FIELD_PATTERNS = [/^id$/i, /^hora de in[ií]cio$/i, /^email$/i, /^nome$/i];
  const timestampField =
    metaFields.find(f => /hora de conclus/i.test(f)) ||
    metaFields.find(f => /carimbo de data/i.test(f)) ||
    metaFields[0];

  // Datas do Excel vêm como número de série — convertemos para texto legível.
  if(timestampField){
    rows.forEach(r => { r[timestampField] = excelSerialToDateStr(r[timestampField]); });
  }
  const metaRest = metaFields.filter(f => f !== timestampField && !SYSTEM_FIELD_PATTERNS.some(re => re.test(f.trim())));

  // Campos de identificação (adicionados quando o formulário passou a
  // diferenciar autoavaliação de avaliação de colaborador).
  const respondentField = metaRest.find(f => /seu nome completo/i.test(f)) || null;
  const evaluatedField = metaRest.find(f => /nome completo da pessoa avaliada/i.test(f)) || null;
  const evalTypeField = metaRest.find(f => /quem.*voc[eê].*avaliar/i.test(f)) || null;
  const textFields = metaRest.filter(f => f !== respondentField && f !== evaluatedField && f !== evalTypeField);

  const categories = [];
  questionFields.forEach(q => { if(!categories.includes(q.category)) categories.push(q.category); });
  const categoryColorMap = {};
  categories.forEach((c,i) => categoryColorMap[c] = CATEGORY_COLORS[i % CATEGORY_COLORS.length]);

  const rowStats = rows.map((r, i) => {
    const catScores = {};
    categories.forEach(c => catScores[c] = []);
    questionFields.forEach(q => {
      const v = parseFloat(r[q.field]);
      if(!isNaN(v)) catScores[q.category].push(v);
    });
    const catAvg = {};
    let allScores = [];
    categories.forEach(c => {
      const arr = catScores[c];
      catAvg[c] = arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
      allScores = allScores.concat(arr);
    });
    const overall = allScores.length ? allScores.reduce((a,b)=>a+b,0)/allScores.length : null;

    const evalType = evalTypeField ? String(r[evalTypeField] || "").trim() : "";
    const isSelf = /auto/i.test(evalType);
    const respondentName = respondentField ? String(r[respondentField] || "").trim() : "";
    const evaluatedName = evaluatedField ? String(r[evaluatedField] || "").trim() : "";
    const subjectName = isSelf ? respondentName : (evaluatedName || respondentName);

    return {
      index:i, row:r, catAvg, overall, timestamp:r[timestampField],
      evalType, isSelf, respondentName, evaluatedName, subjectName
    };
  });

  const agg = computeAggregates(rowStats, categories, questionFields);

  return {
    rows, questionFields, metaFields, timestampField, textFields,
    respondentField, evaluatedField, evalTypeField,
    categories, categoryColorMap, categorySubtitles, rowStats,
    ...agg
  };
}

// Lista (ordenada) de nomes que aparecem como avaliador (quem preencheu o formulário).
function getRespondentNames(data){
  const names = new Set();
  data.rowStats.forEach(s => { if(s.respondentName) names.add(s.respondentName); });
  return Array.from(names).sort((a,b)=>a.localeCompare(b,"pt-BR"));
}

// Lista (ordenada) de nomes de colaboradores que aparecem como avaliados,
// seja por autoavaliação ou avaliados por um colega.
function getSubjectNames(data){
  const names = new Set();
  data.rowStats.forEach(s => { if(s.subjectName) names.add(s.subjectName); });
  return Array.from(names).sort((a,b)=>a.localeCompare(b,"pt-BR"));
}

// Filtra um conjunto de rowStats pelo avaliador e/ou avaliado escolhidos.
// avaliador/avaliado vazios ("") significam "Todos".
function filterRowStats(rowStats, avaliador, avaliado){
  return rowStats.filter(s => {
    if(avaliador && s.respondentName !== avaliador) return false;
    if(avaliado && s.subjectName !== avaliado) return false;
    return true;
  });
}

// Preenche e liga a barra de filtro compartilhada (Avaliador / Avaliado),
// restaura a última seleção salva e chama onChange(avaliador, avaliado)
// sempre que os filtros mudam (inclusive uma vez no carregamento inicial).
// Requer #filterAvaliador e #filterAvaliado no HTML da página.
function initFilterBar(data, onChange){
  const avaliadorSel = document.getElementById("filterAvaliador");
  const avaliadoSel = document.getElementById("filterAvaliado");
  if(!avaliadorSel || !avaliadoSel){
    onChange("", "");
    return;
  }

  const respondents = getRespondentNames(data);
  const subjects = getSubjectNames(data);

  avaliadorSel.innerHTML = '<option value="">Todos</option>' +
    respondents.map(n => `<option value="${n}">${n}</option>`).join("");
  avaliadoSel.innerHTML = '<option value="">Todos</option>' +
    subjects.map(n => `<option value="${n}">${n}</option>`).join("");

  let savedAvaliador = "", savedAvaliado = "";
  try{
    savedAvaliador = localStorage.getItem("filter_avaliador") || "";
    savedAvaliado = localStorage.getItem("filter_avaliado") || "";
  }catch(e){}
  if(!respondents.includes(savedAvaliador)) savedAvaliador = "";
  if(!subjects.includes(savedAvaliado)) savedAvaliado = "";

  avaliadorSel.value = savedAvaliador;
  avaliadoSel.value = savedAvaliado;

  function trigger(){
    const av = avaliadorSel.value;
    const ad = avaliadoSel.value;
    try{
      localStorage.setItem("filter_avaliador", av);
      localStorage.setItem("filter_avaliado", ad);
    }catch(e){}
    onChange(av, ad);
  }

  avaliadorSel.addEventListener("change", trigger);
  avaliadoSel.addEventListener("change", trigger);

  trigger();
}

// Compara autoavaliação (isSelf) vs avaliação de colegas dentro de um
// conjunto de rowStats já filtrado (tipicamente pela barra de filtro,
// com o avaliado escolhido — mas funciona igual sobre qualquer subconjunto).
function computeComparison(rowStats, categories, questionFields){
  const selfStats = rowStats.filter(s => s.isSelf);
  const peerStats = rowStats.filter(s => !s.isSelf);

  function avgOf(list, getter){
    const vals = list.map(getter).filter(v => v !== null && v !== undefined && !isNaN(v));
    return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  }

  const categoryComparison = categories.map(cat => {
    const self = avgOf(selfStats, s => s.catAvg[cat]);
    const peer = avgOf(peerStats, s => s.catAvg[cat]);
    return {
      category: cat,
      self, peer,
      diff: (self !== null && peer !== null) ? (self - peer) : null
    };
  });

  const questionComparison = questionFields.map(q => {
    const self = avgOf(selfStats, s => parseFloat(s.row[q.field]));
    const peer = avgOf(peerStats, s => parseFloat(s.row[q.field]));
    return {
      field: q.field, category: q.category, question: q.question,
      self, peer,
      diff: (self !== null && peer !== null) ? (self - peer) : null
    };
  });

  return {
    selfCount: selfStats.length,
    peerCount: peerStats.length,
    categoryComparison,
    questionComparison
  };
}

// Colore pela direção do gap entre autoavaliação e avaliação de colegas
// (diff = autoavaliação - colegas): vermelho quando a pessoa se avalia
// acima da média dos colegas, verde quando se avalia abaixo, preto (cor
// padrão) quando os dois coincidem.
function diffColorClass(diff){
  if(diff === null || diff === undefined || isNaN(diff)) return "";
  if(diff > 0) return "score-text-red";
  if(diff < 0) return "score-text-green";
  return "";
}

// Monta o HTML do modal de detalhe de uma resposta (usado nas páginas com modal).
function buildDetailHTML(stat, data){
  const {questionFields, categories, categorySubtitles, textFields, timestampField} = data;
  const row = stat.row;
  let html = `<h2>Resposta de ${row[timestampField] || "-"}</h2>
    <div><span class="badge ${scoreClass(stat.overall)}">Média geral: ${fmt(stat.overall)}</span></div>`;

  if(stat.respondentName || stat.evalType){
    html += `<div class="modal-meta">`;
    if(stat.respondentName) html += `<div><strong>Avaliador:</strong> ${stat.respondentName}</div>`;
    html += `<div><strong>Tipo:</strong> ${stat.isSelf ? "Autoavaliação" : "Avaliação de colaborador"}</div>`;
    if(!stat.isSelf && stat.evaluatedName) html += `<div><strong>Avaliado:</strong> ${stat.evaluatedName}</div>`;
    html += `</div>`;
  }

  categories.forEach(cat => {
    const subtitle = categorySubtitles && categorySubtitles[cat];
    html += `<div class="modal-section"><h3>${cat} — média ${fmt(stat.catAvg[cat])}</h3>`;
    if(subtitle) html += `<div class="cat-subtitle">${subtitle}</div>`;
    questionFields.filter(q => q.category === cat).forEach(q => {
      const v = row[q.field];
      html += `<div class="qrow"><span class="qtext">${q.question}</span><span class="qscore">${v || "-"}</span></div>`;
    });
    html += `</div>`;
  });

  if(textFields.length){
    html += `<div class="modal-section"><h3>Comentários</h3>`;
    textFields.forEach(tf => {
      const val = row[tf];
      if(val && val.trim() !== ""){
        html += `<div style="margin-bottom:10px;"><strong>${tf}</strong><div class="textblock">${val}</div></div>`;
      }
    });
    html += `</div>`;
  }
  return html;
}

// Abre o modal de detalhe (requer #overlay e #modalBody no HTML da página).
function openDetailModal(stat, data){
  document.getElementById("modalBody").innerHTML = buildDetailHTML(stat, data);
  document.getElementById("overlay").classList.add("open");
}

// Quebra um texto longo em várias linhas (para rótulos de gráfico).
function wrapLabel(text, maxLen){
  maxLen = maxLen || 42;
  const words = String(text).split(" ");
  const lines = [];
  let cur = "";
  words.forEach(w => {
    if((cur + " " + w).trim().length > maxLen){
      if(cur) lines.push(cur.trim());
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  });
  if(cur) lines.push(cur.trim());
  return lines;
}

// Liga os botões de fechar do modal (chamar uma vez em cada página com modal).
function wireModalClose(){
  const closeBtn = document.getElementById("closeModal");
  const overlay = document.getElementById("overlay");
  if(closeBtn) closeBtn.addEventListener("click", () => overlay.classList.remove("open"));
  if(overlay) overlay.addEventListener("click", (e) => { if(e.target.id === "overlay") overlay.classList.remove("open"); });
}

// Gera e baixa um arquivo .xlsx com todas as respostas (usa os dados já carregados).
function downloadExcelFromData(data){
  if(!data){
    alert("Os dados ainda não carregaram. Aguarde um instante e tente novamente.");
    return;
  }
  if(typeof XLSX === "undefined"){
    alert("A biblioteca de geração de Excel não carregou. Verifique bloqueador de anúncios/firewall e tente novamente.");
    return;
  }
  const idHeaders = [];
  if(data.respondentField) idHeaders.push("Avaliador");
  if(data.evalTypeField) idHeaders.push("Tipo de Avaliação");
  if(data.evaluatedField) idHeaders.push("Avaliado");

  const headers = [data.timestampField, ...idHeaders, ...data.questionFields.map(q => q.category + " - " + q.question), ...data.textFields];
  const aoa = [headers];
  data.rows.forEach(r => {
    const line = [r[data.timestampField]];
    if(data.respondentField) line.push(r[data.respondentField]);
    if(data.evalTypeField) line.push(r[data.evalTypeField]);
    if(data.evaluatedField) line.push(r[data.evaluatedField]);
    data.questionFields.forEach(q => line.push(r[q.field]));
    data.textFields.forEach(tf => line.push(r[tf]));
    aoa.push(line);
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = headers.map(h => ({ wch: Math.min(Math.max(String(h).length, 12), 60) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Respostas");
  const stamp = new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb, `respostas_avaliacao_${stamp}.xlsx`);
}
