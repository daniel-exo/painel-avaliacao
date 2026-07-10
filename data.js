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

function fmt(v){
  if(v === null || v === undefined || isNaN(v)) return "-";
  return (Math.round(v*100)/100).toFixed(2);
}

function parseFields(fields){
  const questionFields = [];
  const metaFields = [];
  fields.forEach(f => {
    if(f.includes("\n")){
      const idx = f.indexOf("\n");
      const category = f.slice(0, idx).trim();
      const question = f.slice(idx+1).trim();
      questionFields.push({field:f, category, question});
    } else if(f && f.trim() !== ""){
      metaFields.push(f);
    }
  });
  return {questionFields, metaFields};
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
  const {questionFields, metaFields} = parseFields(parsed.meta.fields);
  const timestampField = metaFields[0];
  const textFields = metaFields.slice(1);

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
    return {index:i, row:r, catAvg, overall, timestamp:r[timestampField]};
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

  return {
    rows, questionFields, metaFields, timestampField, textFields,
    categories, categoryColorMap, rowStats,
    overallAvg, catOverallAvg, bestCat, worstCat,
    bestResponse, worstResponse
  };
}

// Monta o HTML do modal de detalhe de uma resposta (usado nas duas páginas).
function buildDetailHTML(stat, data){
  const {questionFields, categories, textFields, timestampField} = data;
  const row = stat.row;
  let html = `<h2>Resposta de ${row[timestampField] || "-"}</h2>
    <div><span class="badge ${scoreClass(stat.overall)}">Média geral: ${fmt(stat.overall)}</span></div>`;

  categories.forEach(cat => {
    html += `<div class="modal-section"><h3>${cat} — média ${fmt(stat.catAvg[cat])}</h3>`;
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
  const headers = [data.timestampField, ...data.questionFields.map(q => q.category + " - " + q.question), ...data.textFields];
  const aoa = [headers];
  data.rows.forEach(r => {
    const line = [r[data.timestampField]];
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
