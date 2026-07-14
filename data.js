// ==== Lógica compartilhada: busca do CSV, parsing e agregação ====
// Usado tanto por index.html quanto por categorias.html

const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTgaz_Xppuf6aUcKpMu30bln-5repgU5cGj7gkSc9UMI9Ru_nyJ_dVTpLPnsTqFNjAhQseBmrTCqJLO/pub?output=csv";
const REFRESH_MS = 5 * 60 * 1000;
const CATEGORY_COLORS = ["#4C9AFF","#36B37E","#FFAB00","#6554C0","#FF5630","#00B8D9","#B0BEC5"];

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

// Um cabeçalho de pergunta vem no formato:
// "CATEGORIA\nFrase de valor da categoria. [Pergunta específica sobre o colaborador.]"
// Separamos a categoria, a frase de valor (usada como subtítulo da categoria)
// e a pergunta em si (sem colchetes), para não repetir a frase de valor em cada linha.
function parseFields(fields){
  const questionFields = [];
  const metaFields = [];
  const categorySubtitles = {};
  fields.forEach(f => {
    if(f.includes("\n")){
      const idx = f.indexOf("\n");
      const category = f.slice(0, idx).trim();
      const remainder = f.slice(idx+1).trim();
      const openIdx = remainder.indexOf("[");
      const closeIdx = remainder.lastIndexOf("]");
      let question, subtitle;
      if(openIdx !== -1 && closeIdx > openIdx){
        subtitle = remainder.slice(0, openIdx).trim();
        question = remainder.slice(openIdx+1, closeIdx).trim();
      } else {
        subtitle = null;
        question = remainder;
      }
      if(subtitle && !categorySubtitles[category]) categorySubtitles[category] = subtitle;
      questionFields.push({field:f, category, question});
    } else if(f && f.trim() !== ""){
      metaFields.push(f);
    }
  });
  return {questionFields, metaFields, categorySubtitles};
}

// Busca o CSV publicado, parseia e devolve todos os dados já agregados.
async function loadDashboardData(){
  if(typeof Papa === "undefined"){
    throw new Error("Biblioteca PapaParse não carregou. Verifique bloqueador de anúncios, firewall ou extensão de privacidade que possa estar bloqueando cdn.jsdelivr.net.");
  }
  const url = CSV_URL + (CSV_URL.includes("?") ? "&" : "?") + "_ts=" + Date.now();
  const res = await fetch(url, {cache:"no-store"});
  if(!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  const parsed = Papa.parse(text, {header:true, skipEmptyLines:true});

  const rows = parsed.data.filter(r => Object.values(r).some(v => v && String(v).trim() !== ""));
  const {questionFields, metaFields, categorySubtitles} = parseFields(parsed.meta.fields);
  const timestampField = metaFields[0];
  const metaRest = metaFields.slice(1);

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

  const validOverall = rowStats.map(s=>s.overall).filter(v=>v!==null);
  const overallAvg = validOverall.length ? validOverall.reduce((a,b)=>a+b,0)/validOverall.length : null;

  const catOverallAvg = {};
  categories.forEach(c => {
    const vals = rowStats.map(s=>s.catAvg[c]).filter(v=>v!==null);
    catOverallAvg[c] = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  });

  const sortedCats = categories.slice().sort((a,b)=>(catOverallAvg[b]??-1)-(catOverallAvg[a]??-1));
  const bestCat = sortedCats.length ? sortedCats[0] : null;
  const worstCat = sortedCats.length ? sortedCats[sortedCats.length-1] : null;

  let bestResponse = null, worstResponse = null;
  rowStats.forEach(s => {
    if(s.overall === null) return;
    if(!bestResponse || s.overall > bestResponse.overall) bestResponse = s;
    if(!worstResponse || s.overall < worstResponse.overall) worstResponse = s;
  });

  // Média de cada pergunta individual, considerando todas as respostas.
  const questionAvg = {};
  questionFields.forEach(q => {
    const vals = rows.map(r => parseFloat(r[q.field])).filter(v => !isNaN(v));
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
    rows, questionFields, metaFields, timestampField, textFields,
    respondentField, evaluatedField, evalTypeField,
    categories, categoryColorMap, categorySubtitles, rowStats,
    overallAvg, catOverallAvg, bestCat, worstCat,
    bestResponse, worstResponse, questionAvg, bestQuestion, worstQuestion
  };
}

// Lista (ordenada) de nomes de colaboradores que aparecem nas respostas,
// seja como autoavaliação ou como avaliado por um colega.
function getSubjectNames(data){
  const names = new Set();
  data.rowStats.forEach(s => { if(s.subjectName) names.add(s.subjectName); });
  return Array.from(names).sort((a,b)=>a.localeCompare(b,"pt-BR"));
}

// Calcula, para um colaborador específico, a comparação entre a
// autoavaliação dele e as avaliações recebidas de colegas — por categoria
// e por pergunta.
function computeComparison(data, subjectName){
  const selfStats = data.rowStats.filter(s => s.isSelf && s.subjectName === subjectName);
  const peerStats = data.rowStats.filter(s => !s.isSelf && s.subjectName === subjectName);

  function avgOf(list, getter){
    const vals = list.map(getter).filter(v => v !== null && v !== undefined && !isNaN(v));
    return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  }

  const categoryComparison = data.categories.map(cat => {
    const self = avgOf(selfStats, s => s.catAvg[cat]);
    const peer = avgOf(peerStats, s => s.catAvg[cat]);
    return {
      category: cat,
      self, peer,
      diff: (self !== null && peer !== null) ? (self - peer) : null
    };
  });

  const questionComparison = data.questionFields.map(q => {
    const self = avgOf(selfStats, s => parseFloat(s.row[q.field]));
    const peer = avgOf(peerStats, s => parseFloat(s.row[q.field]));
    return {
      field: q.field, category: q.category, question: q.question,
      self, peer,
      diff: (self !== null && peer !== null) ? (self - peer) : null
    };
  });

  return {
    subjectName,
    selfCount: selfStats.length,
    peerCount: peerStats.length,
    categoryComparison,
    questionComparison
  };
}

// Colore pela magnitude do gap entre autoavaliação e avaliação de colegas
// (não pela direção — um gap grande é digno de atenção nos dois sentidos).
function gapClass(diff){
  if(diff === null || diff === undefined || isNaN(diff)) return "";
  const abs = Math.abs(diff);
  if(abs <= 0.3) return "score-text-green";
  if(abs <= 0.7) return "score-text-yellow";
  return "score-text-red";
}

// Monta o HTML do modal de detalhe de uma resposta (usado nas duas páginas).
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

// Liga os botões de fechar do modal (chamar uma vez em cada página).
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
