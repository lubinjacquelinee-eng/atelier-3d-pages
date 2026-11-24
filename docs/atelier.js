import { API_URL } from "./config.js";

const $ = (selector) => document.querySelector(selector);
const labels = {received:"Demande reçue",queued:"En attente",preparing:"En préparation",slicing:"Découpage en cours",ready:"Prête à imprimer",printing:"Impression en cours",done:"Terminée",error:"Erreur"};
const reasons = {download:"Fichier indisponible.",validation:"Format, géométrie ou sécurité du modèle non validés.",slicer:"OrcaSlicer n’a pas produit une sortie conforme.",operator:"Erreur déclarée par le responsable.",expired:"Préparation interrompue ou délai dépassé.",storage:"Stockage non confirmé."};
const fmt = new Intl.DateTimeFormat("fr-FR",{dateStyle:"short",timeStyle:"short"});
const cfg = /^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/atelier$/.test(API_URL);
const limit = 12*1024*1024;
let token, timer, expiry, generation = 0, filter = "all", page = 0, cursors = [null], data, revision = 0, inFlight = false;

function message(target, text = "", bad = false) {
  $(target).textContent=text;
  $(target).classList.toggle("bad",bad);
}
async function api(action, payload = {}, file = null, auth = token) {
  if (!cfg) throw new Error("Le service Supabase n’est pas encore raccordé.");
  const headers = {"Content-Type":file ? "application/octet-stream" : "application/json"};
  if (auth) headers.Authorization=`Bearer ${auth}`;
  if (file) headers["X-Atelier-Meta"]=encodeURIComponent(JSON.stringify(payload));
  const sep = `${API_URL}?action=${encodeURIComponent(action)}`;
  const response = await fetch(sep,{method:"POST",headers,body:file ?? JSON.stringify(payload),cache:"no-store",credentials:"omit",
    signal:AbortSignal.timeout(file ? 85000 : 12000)});
  const body=await response.json().catch(()=>({}));
  if (response.status===401 && action!=="login" && auth===token) closeSession("Session expirée. Reconnecte-toi.");
  if (!response.ok) throw new Error(body.error || "Service inaccessible. Réessaie dans un instant.");
  return body;
}
function closeSession(text = "") {
  token=null; generation++; data=null; inFlight=false; page=0; cursors=[null]; filter="all";
  clearInterval(timer); clearTimeout(expiry);
  $("#jobs").replaceChildren(); $("#submit-form").reset(); showFileName();
  message("#submit-message"); message("#dash-message");
  $("#dashboard").hidden=true; $("#logout").hidden=true; $("#login-view").hidden=false;
  message("#login-message",text,Boolean(text));
  $("#code").focus();
}
function showFileName() { $("#file-label").textContent=$("#file").files[0]?.name ?? "Choisir un modèle 3D"; }
function node(tag, text, cls) {
  const element=document.createElement(tag);
  if (text != null) element.textContent=text;
  if (cls) element.className=cls;
  return element;
}
function render() {
  const list=$("#jobs");
  const open=new Set([...list.querySelectorAll("details[open]")].map(e=>e.dataset.id));
  const final=(job)=>["done","error"].includes(job.status);
  const jobs=(data?.jobs ?? []).filter(job=>filter==="all" || final(job)===(filter==="closed"));
  list.replaceChildren();
  if (!jobs.length) list.append(node("p",data ? (filter==="all" ? "Aucune demande pour le moment." : "Aucune demande pour ce filtre sur cette page.") : "Chargement des demandes…","empty"));
  for (const job of jobs) {
    const details=node("details",null,"job");
    details.dataset.id=job.id; details.open=open.has(job.id);
    const summary=node("summary");
    const description=node("span");
    description.append(node("strong",job.name),node("small",`${job.ext.toUpperCase()} · ${fmt.format(new Date(job.created_at))}`));
    summary.append(description,node("span",labels[job.status] ?? "État inconnu",`badge ${job.status}`));
    const info=node("div",null,"job-body");
    info.append(node("p",`Référence : ${job.id}`),node("p",`Supports : ${job.supports?"Oui":"Non"} · Matériau : ${job.material ?? "profil imprimante"}`));
    if (job.note) info.append(node("p",job.note));
    if (job.reason) info.append(node("p",reasons[job.reason] ?? "Consulte le responsable."));
    if (job.status==="ready") info.append(node("p",job.approved_at?"Validée sur le Mac. En attente du départ confirmé.":"En attente de validation sur le Mac."));
    const events=node("ol");
    for (const event of data.events.filter(e=>e.job_id===job.id)) {
      events.append(node("li",`${fmt.format(new Date(event.created_at))} · ${event.action==="approval"?"Départ autorisé sur le Mac":labels[event.status]}`));
    }
    info.append(events); details.append(summary,info); list.append(details);
  }
  $("#previous").hidden=page===0; $("#more").hidden=!data?.more;
  for (const button of document.querySelectorAll("[data-filter]")) button.setAttribute("aria-pressed",String(button.dataset.filter===filter));
}
async function refresh(target = page, quiet = false) {
  if (!token || (quiet && (inFlight || document.hidden || $("#jobs").contains(document.activeElement)))) return;
  const epoch=generation, call=++revision;
  inFlight=true;
  try {
    const next=await api("list",{before:cursors[target]});
    if (epoch!==generation || call!==revision) return;
    page=target; data=next;
    if (next.jobs.length) {
      const last=next.jobs.at(-1);
      cursors[page+1]={id:last.id,at:last.created_at};
    }
    if (!quiet) message("#dash-message");
    render();
  } catch (error) {
    if (epoch===generation && call===revision) message("#dash-message",error.message,true);
  } finally { if(call===revision) inFlight=false; }
}
$("#login-form").addEventListener("submit",async (event)=>{
  event.preventDefault();
  const button=event.submitter;
  button.disabled=true; message("#login-message","Vérification…");
  try {
    const result=await api("login",{code:$("#code").value});
    token=result.token; generation++;
    $("#login-view").hidden=true; $("#dashboard").hidden=false; $("#logout").hidden=false;
    render();
    expiry=setTimeout(()=>closeSession("Session expirée. Reconnecte-toi."),Math.max(0,Date.parse(result.expires)-Date.now()));
    timer=setInterval(()=>{ if (page===0) void refresh(0,true); },25000);
    void refresh();
    $("#refresh").focus();
  } catch(error) { message("#login-message",error.message,true); }
  finally { button.disabled=false; $("#code").value=""; }
});
$("#logout").addEventListener("click",async ()=>{
  const previous=token;
  closeSession();
  try { await api("logout",{},null,previous); }
  catch { if(!token) message("#login-message","Fermée sur cet appareil. La révocation serveur n’a pas pu être confirmée.",true); }
});
$("#file").addEventListener("change",showFileName);
$("#refresh").addEventListener("click",()=>void refresh());
$("#previous").addEventListener("click",()=>void refresh(page-1));
$("#more").addEventListener("click",()=>void refresh(page+1));
for(const button of document.querySelectorAll("[data-filter]")) button.addEventListener("click",()=>{filter=button.dataset.filter;render();});
$("#submit-form").addEventListener("submit",async (event)=>{
  event.preventDefault();
  const file=$("#file").files[0], ext=file?.name.split(".").at(-1).toLowerCase();
  if(!file?.size || file.size>limit || !["stl","step","stp","3mf"].includes(ext)) {
    message("#submit-message","Choisis un modèle valide de 12 Mio maximum.",true); return;
  }
  const name=$("#name").value.trim();
  if(!name){ message("#submit-message","Indique le nom de l’impression.",true);return; }
  const button=event.submitter, epoch=generation;
  button.disabled=true; message("#submit-message","Dépôt du modèle…");
  try {
    await api("submit",{name,note:$("#note").value.trim(),ext,supports:new FormData(event.currentTarget).get("supports")==="oui"},file);
    if(epoch!==generation) return;
    $("#submit-form").reset(); showFileName(); filter="all";
    message("#submit-message","Demande déposée et mise en attente."); await refresh(0);
  } catch(error) { if(epoch===generation) message("#submit-message",error.message,true); }
  finally { button.disabled=false; }
});
if (!cfg) message("#login-message","Le service Supabase n’est pas encore raccordé.",true);
