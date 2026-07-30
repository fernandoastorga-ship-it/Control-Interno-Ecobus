const GLOBAL_PROFILES_KEY = "compras_agiles_profiles_v4";
const LEGACY_KEYS = ["compras_agiles_v2", "compras_agiles_v1"];
const MIGRATION_DONE_KEY = "compras_agiles_cloud_migrated_v1";

let activeProfile = null;
let compras = [];
let expandedId = null;
let archivosModal = [];

const $ = (id) => document.getElementById(id);
const money = (value) => new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(Number(value || 0));
const dateFmt = (value) => value ? new Date(value + "T00:00:00").toLocaleDateString("es-CL") : "-";
const sizeFmt = (bytes) => {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
const slug = (text) => String(text || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const profileKey = (name) => `compras_agiles_data_v4_${slug(name)}`;

async function apiFetch(url, options = {}) {
  const config = { ...options, headers: { ...(options.headers || {}) } };
  if (config.body && typeof config.body !== "string") {
    config.headers["Content-Type"] = "application/json";
    config.body = JSON.stringify(config.body);
  }
  const response = await fetch(url, config);
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("Sesión vencida");
  }
  if (!response.ok) {
    let detail = `Error ${response.status}`;
    try { detail = (await response.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  if (response.status === 204) return null;
  return response.json();
}

function showStatus(message, type = "ok") {
  const banner = $("statusBanner");
  banner.textContent = message;
  banner.className = `status-banner ${type}`;
  setTimeout(() => banner.classList.add("hidden"), 4500);
}

async function renderProfileScreen() {
  try {
    const profiles = await apiFetch("/compras/api/profiles");
    $("profileGrid").innerHTML = profiles.map(p => `
      <button class="profile-option" onclick="seleccionarPerfil('${escapeAttribute(p.name)}')">
        <strong>${escapeHtml(p.name)}</strong>
        <span>${p.count} compras registradas · ${p.pending} pendientes de pago</span>
      </button>
    `).join("") || `<p class="muted">No hay perfiles creados.</p>`;
    renderMigrationBox();
  } catch (error) {
    $("profileGrid").innerHTML = `<p class="payment-alert">${escapeHtml(error.message)}</p>`;
  }
}

async function seleccionarPerfil(nombre) {
  try {
    activeProfile = nombre;
    compras = (await apiFetch(`/compras/api/profiles/${encodeURIComponent(nombre)}/purchases`)).map(normalizarCompra);
    expandedId = null;
    $("profileScreen").classList.add("hidden");
    $("appRoot").classList.remove("hidden");
    $("sidebarProfileName").textContent = nombre;
    $("perfilActivoTexto").textContent = `Perfil activo: ${nombre}`;
    render();
  } catch (error) {
    alert(`No se pudo cargar el perfil: ${error.message}`);
  }
}

async function volverASelectorPerfil() {
  activeProfile = null;
  compras = [];
  $("appRoot").classList.add("hidden");
  $("profileScreen").classList.remove("hidden");
  await renderProfileScreen();
}

function normalizarCompra(c) {
  return { ...c, idInterno: c.idInterno || crypto.randomUUID(), archivos: Array.isArray(c.archivos) ? c.archivos : [] };
}

function pagoPendiente(compra) { return compra?.estado === "GANADA" && !compra?.fechaPago; }
function estadoPagoTexto(compra) {
  if (compra?.estado !== "GANADA") return "No aplica";
  return pagoPendiente(compra) ? "Pendiente de pago" : "Pago registrado";
}
function estadoTexto(estado) {
  return { EN_EVALUACION: "En evaluación", GANADA: "Ganada / Adquirida", PERDIDA: "Perdida", DESIERTA: "Desierta" }[estado] || estado;
}
function render() { renderCards(); renderTabla(); renderResumen(); }
function getComprasFiltradas() {
  const q = $("buscador").value.trim().toLowerCase();
  const estado = $("filtroEstado").value;
  const pago = $("filtroPago").value;
  return compras.filter(c => {
    const matchesQ = !q || [c.cliente, c.idCompra, c.destino, c.detalleServicio].join(" ").toLowerCase().includes(q);
    const matchesEstado = estado === "TODOS" || c.estado === estado;
    const matchesPago = pago === "TODOS" || (pago === "PENDIENTE" && pagoPendiente(c)) || (pago === "PAGADO" && c.estado === "GANADA" && c.fechaPago);
    return matchesQ && matchesEstado && matchesPago;
  });
}
function renderCards() {
  const ganadas = compras.filter(c => c.estado === "GANADA");
  const perdidas = compras.filter(c => c.estado === "PERDIDA");
  const desiertas = compras.filter(c => c.estado === "DESIERTA");
  const totalCobrado = compras.reduce((sum, c) => sum + Number(c.montoCobrado || 0), 0);
  const totalGanado = ganadas.reduce((sum, c) => sum + Number(c.montoCobrado || 0), 0);
  const pendientesPago = compras.filter(pagoPendiente);
  const montoPendientePago = pendientesPago.reduce((sum, c) => sum + Number(c.montoCobrado || 0), 0);
  $("summaryCards").innerHTML = `
    <div class="card"><span>Total compras</span><strong>${compras.length}</strong></div>
    <div class="card"><span>Ganadas / adquiridas</span><strong>${ganadas.length}</strong><p>${money(totalGanado)}</p></div>
    <div class="card"><span>Perdidas</span><strong>${perdidas.length}</strong></div>
    <div class="card"><span>Desiertas</span><strong>${desiertas.length}</strong></div>
    <div class="card"><span>Monto ofertado</span><strong>${money(totalCobrado)}</strong></div>
    <div class="card alert-card"><span>Pendientes de pago</span><strong>${pendientesPago.length}</strong><p>${money(montoPendientePago)}</p></div>`;
}
function renderTabla() {
  const data = getComprasFiltradas();
  if (!data.length) {
    $("tablaCompras").innerHTML = `<tr><td colspan="10">No hay compras que coincidan con los filtros seleccionados.</td></tr>`;
    return;
  }
  $("tablaCompras").innerHTML = data.map(c => `
    <tr><td>${dateFmt(c.fechaPublicacion)}</td><td><strong>${escapeHtml(c.cliente)}</strong></td><td>${escapeHtml(c.idCompra)}</td><td>${escapeHtml(c.destino || "-")}</td><td>${escapeHtml(c.detalleServicio || "-")}</td><td>${money(c.montoCobrado)}</td><td>${dateFmt(c.fechaCierre)}</td><td>${c.factorComercial ? `${c.factorComercial}%` : "-"}</td><td><span class="badge ${c.estado}">${estadoTexto(c.estado)}</span>${pagoPendiente(c) ? `<div class="payment-alert">Pendiente de pago</div>` : ""}<div class="file-count">📎 ${c.archivos?.length || 0}</div></td><td><div class="action-row"><button class="small-btn" onclick="editarCompra('${c.idInterno}')">Editar</button><button class="small-btn" onclick="toggleDetalle('${c.idInterno}')">${expandedId === c.idInterno ? "Ocultar" : "Ver"}</button><button class="small-btn" onclick="eliminarCompra('${c.idInterno}')">Eliminar</button></div></td></tr>
    ${expandedId === c.idInterno ? renderDetalle(c) : ""}`).join("");
}
function renderDetalle(c) {
  return `<tr class="detail-row"><td colspan="10"><div class="detail-box"><div class="detail-card"><h4>Información de gestión</h4>${linea("Estado", estadoTexto(c.estado))}${linea("ID Orden de Compra", c.ordenCompraId)}${linea("Contacto facturación", formatContacto(c.facturacionNombre, c.facturacionEmail, c.facturacionTelefono))}${linea("Contacto coordinación", formatContacto(c.coordinacionNombre, c.coordinacionEmail, c.coordinacionTelefono))}${linea("Fecha envío factura", dateFmt(c.fechaEnvioFactura))}${linea("Fecha de pago", pagoPendiente(c) ? `<span class="payment-alert inline">Pendiente de pago</span>` : dateFmt(c.fechaPago))}</div><div class="detail-card"><h4>Archivos adjuntos</h4>${renderArchivosDetalle(c.archivos || [])}</div></div></td></tr>`;
}
function renderArchivosDetalle(archivos) {
  if (!archivos.length) return `<p class="muted">Esta compra no tiene archivos adjuntos.</p>`;
  return `<div class="file-list-detail">${archivos.map(a => `<div class="file-item-detail"><div><strong>${escapeHtml(a.nombre)}</strong><span>${escapeHtml(a.tipo || "Archivo")} · ${sizeFmt(a.size)} · ${dateFmt(a.fechaCarga?.slice(0,10))}</span></div><button class="small-btn" onclick="descargarArchivo('${a.id}')">Descargar</button></div>`).join("")}</div>`;
}
function linea(label, value) { return `<div class="detail-line"><strong>${label}</strong><span>${value || "-"}</span></div>`; }
function formatContacto(nombre, email, telefono) {
  const partes = [nombre, email, telefono].filter(Boolean);
  return partes.length ? partes.map(escapeHtml).join("<br>") : "-";
}
function renderResumen() {
  const porEstado = ["EN_EVALUACION", "GANADA", "PERDIDA", "DESIERTA"].map(e => {
    const items = compras.filter(c => c.estado === e);
    const monto = items.reduce((sum, c) => sum + Number(c.montoCobrado || 0), 0);
    return `<div class="card"><span>${estadoTexto(e)}</span><strong>${items.length}</strong><p>${money(monto)}</p></div>`;
  }).join("");
  const pendientes = compras.filter(pagoPendiente);
  $("resumenDetalle").innerHTML = porEstado + `<div class="card alert-card"><span>Pendientes de pago</span><strong>${pendientes.length}</strong><p>${money(pendientes.reduce((s,c)=>s+Number(c.montoCobrado||0),0))}</p></div>`;
}
function abrirModal(compra = null) {
  $("modalCompra").classList.remove("hidden");
  $("modalTitle").textContent = compra ? "Editar Compra Ágil" : "Nueva Compra Ágil";
  $("formCompra").reset();
  $("compraIdInterno").value = compra?.idInterno || "";
  archivosModal = structuredClone(compra?.archivos || []);
  renderArchivosModal();
  const campos = ["fechaPublicacion", "cliente", "idCompra", "destino", "detalleServicio", "montoCobrado", "fechaCierre", "factorComercial", "estado", "ordenCompraId", "facturacionNombre", "facturacionEmail", "facturacionTelefono", "coordinacionNombre", "coordinacionEmail", "coordinacionTelefono", "fechaEnvioFactura", "fechaPago"];
  campos.forEach(campo => { if (compra?.[campo] !== undefined) $(campo).value = compra[campo]; });
  toggleSeccionGanada();
}
function cerrarModal() { $("modalCompra").classList.add("hidden"); archivosModal = []; }
function toggleSeccionGanada() { $("seccionGanada").classList.toggle("hidden", $("estado").value !== "GANADA"); }
function editarCompra(id) { const compra = compras.find(c => c.idInterno === id); if (compra) abrirModal(compra); }
async function eliminarCompra(id) {
  if (!confirm("¿Seguro que quieres eliminar esta compra? También se eliminarán sus archivos adjuntos.")) return;
  try {
    await apiFetch(`/compras/api/profiles/${encodeURIComponent(activeProfile)}/purchases/${encodeURIComponent(id)}`, { method: "DELETE" });
    compras = compras.filter(c => c.idInterno !== id);
    render();
    await renderProfileScreen();
    showStatus("Compra eliminada.");
  } catch (error) { alert(error.message); }
}
function toggleDetalle(id) { expandedId = expandedId === id ? null : id; renderTabla(); }
function archivoADataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ id: crypto.randomUUID(), nombre: file.name, tipo: file.type || "application/octet-stream", size: file.size, fechaCarga: new Date().toISOString(), dataUrl: reader.result });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function agregarArchivos(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  const demasiadoGrande = files.find(f => f.size > 10 * 1024 * 1024);
  if (demasiadoGrande) { alert(`${demasiadoGrande.name} supera el máximo de 10 MB.`); event.target.value = ""; return; }
  const convertidos = await Promise.all(files.map(archivoADataURL));
  archivosModal.push(...convertidos);
  event.target.value = "";
  renderArchivosModal();
}
function renderArchivosModal() {
  if (!archivosModal.length) { $("listaArchivosModal").innerHTML = `<p class="muted">Aún no has adjuntado archivos para esta compra.</p>`; return; }
  $("listaArchivosModal").innerHTML = archivosModal.map(a => `<div class="file-item"><div><strong>${escapeHtml(a.nombre)}</strong><span>${escapeHtml(a.tipo || "Archivo")} · ${sizeFmt(a.size)}</span></div><button type="button" class="small-btn danger-text" onclick="quitarArchivoModal('${a.id}')">Quitar</button></div>`).join("");
}
function quitarArchivoModal(id) { archivosModal = archivosModal.filter(a => a.id !== id); renderArchivosModal(); }
function descargarArchivo(idArchivo) {
  const archivo = compras.flatMap(c => c.archivos || []).find(a => a.id === idArchivo);
  if (!archivo) return alert("No se encontró el archivo.");
  if (archivo.dataUrl) {
    const a = document.createElement("a"); a.href = archivo.dataUrl; a.download = archivo.nombre; a.click(); return;
  }
  window.location.href = archivo.downloadUrl || `/compras/api/attachments/${encodeURIComponent(idArchivo)}`;
}
function exportarCSV() {
  const headers = ["perfil","fechaPublicacion","cliente","idCompra","destino","detalleServicio","montoCobrado","fechaCierre","factorComercial","estado","estadoPago","cantidadArchivos","ordenCompraId","facturacionNombre","facturacionEmail","facturacionTelefono","coordinacionNombre","coordinacionEmail","coordinacionTelefono","fechaEnvioFactura","fechaPago"];
  const rows = compras.map(c => headers.map(h => {
    const value = h === "perfil" ? activeProfile : h === "cantidadArchivos" ? (c.archivos?.length || 0) : h === "estadoPago" ? estadoPagoTexto(c) : (c[h] ?? "");
    return `"${String(value).replaceAll('"', '""')}"`;
  }).join(","));
  descargarTexto([headers.join(","), ...rows].join("\n"), `compras_agiles_${slug(activeProfile)}.csv`, "text/csv;charset=utf-8");
}
function blobADataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
async function exportarBackupJSON() {
  const button = $("btnExportarBackup");
  button.disabled = true;
  button.textContent = "Preparando backup...";
  try {
    const comprasBackup = structuredClone(compras);
    for (const compra of comprasBackup) {
      for (const archivo of (compra.archivos || [])) {
        if (archivo.dataUrl) continue;
        const response = await fetch(archivo.downloadUrl || `/compras/api/attachments/${encodeURIComponent(archivo.id)}`);
        if (!response.ok) throw new Error(`No se pudo incluir el archivo ${archivo.nombre}`);
        archivo.dataUrl = await blobADataURL(await response.blob());
        delete archivo.downloadUrl;
      }
    }
    const payload = JSON.stringify({ generado: new Date().toISOString(), perfil: activeProfile, compras: comprasBackup }, null, 2);
    descargarTexto(payload, `backup_compras_agiles_${slug(activeProfile)}.json`, "application/json;charset=utf-8");
    showStatus("Backup completo descargado, incluidos los adjuntos.");
  } catch (error) {
    alert(`No se pudo generar el backup: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Exportar backup JSON";
  }
}
function descargarTexto(contenido, nombreArchivo, tipo) {
  const blob = new Blob([contenido], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = nombreArchivo; a.click(); URL.revokeObjectURL(url);
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#039;",'"':"&quot;"}[char])); }
function escapeAttribute(value) { return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

function collectLocalData() {
  const found = new Map();
  let profiles = ["Fernando", "Patricio"];
  try {
    const parsed = JSON.parse(localStorage.getItem(GLOBAL_PROFILES_KEY) || "[]");
    if (Array.isArray(parsed) && parsed.length) profiles = parsed;
  } catch {}
  for (const profile of profiles) {
    try {
      const data = JSON.parse(localStorage.getItem(profileKey(profile)) || "[]");
      if (Array.isArray(data) && data.length) found.set(profile, data);
    } catch {}
  }
  if (!found.has("Fernando")) {
    for (const key of LEGACY_KEYS) {
      try {
        const data = JSON.parse(localStorage.getItem(key) || "[]");
        if (Array.isArray(data) && data.length) { found.set("Fernando", data); break; }
      } catch {}
    }
  }
  return found;
}
function renderMigrationBox() {
  const data = collectLocalData();
  const total = [...data.values()].reduce((sum, list) => sum + list.length, 0);
  const box = $("migrationBox");
  if (!total || localStorage.getItem(MIGRATION_DONE_KEY) === "1") { box.classList.add("hidden"); return; }
  $("migrationText").textContent = `${total} compras pueden copiarse desde localStorage a PostgreSQL.`;
  box.classList.remove("hidden");
}
async function migrarDatosLocales() {
  const data = collectLocalData();
  if (!data.size) return alert("No se encontraron datos locales para transferir.");
  if (!confirm("Se copiarán las compras antiguas a la base de datos en la nube. Los registros con el mismo ID se actualizarán.")) return;
  const button = $("btnMigrarLocal");
  button.disabled = true; button.textContent = "Transfiriendo...";
  try {
    let total = 0;
    for (const [profile, list] of data.entries()) {
      const result = await apiFetch("/compras/api/import", { method: "POST", body: { profile, compras: list } });
      total += result.imported;
    }
    localStorage.setItem(MIGRATION_DONE_KEY, "1");
    alert(`${total} compras fueron transferidas correctamente a la nube.`);
    await renderProfileScreen();
  } catch (error) { alert(`No se pudo completar la migración: ${error.message}`); }
  finally { button.disabled = false; button.textContent = "Transferir a la nube"; }
}
async function importarBackupArchivo(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const profile = payload.perfil || payload.profile || activeProfile;
    const list = payload.compras;
    if (!profile || !Array.isArray(list)) throw new Error("El archivo no tiene el formato de backup esperado.");
    const result = await apiFetch("/compras/api/import", { method: "POST", body: { profile, compras: list } });
    if (activeProfile === profile) compras = (await apiFetch(`/compras/api/profiles/${encodeURIComponent(profile)}/purchases`)).map(normalizarCompra);
    render(); await renderProfileScreen();
    showStatus(`${result.imported} compras importadas al perfil ${profile}.`);
  } catch (error) { alert(`No se pudo importar el backup: ${error.message}`); }
}

$("formNuevoPerfil").addEventListener("submit", async (event) => {
  event.preventDefault();
  const nombre = $("nuevoPerfilNombre").value.trim();
  if (!nombre) return;
  try { await apiFetch("/compras/api/profiles", { method: "POST", body: { name: nombre } }); $("nuevoPerfilNombre").value = ""; await renderProfileScreen(); }
  catch (error) { alert(error.message); }
});
$("btnCambiarPerfil").addEventListener("click", volverASelectorPerfil);
$("btnToggleSidebar").addEventListener("click", () => $("sidebar").classList.toggle("collapsed"));
$("btnNuevaCompra").addEventListener("click", () => abrirModal());
$("btnCerrarModal").addEventListener("click", cerrarModal);
$("btnCancelar").addEventListener("click", cerrarModal);
$("estado").addEventListener("change", toggleSeccionGanada);
$("buscador").addEventListener("input", renderTabla);
$("filtroEstado").addEventListener("change", renderTabla);
$("filtroPago").addEventListener("change", renderTabla);
$("btnExportar").addEventListener("click", exportarCSV);
$("btnExportarBackup").addEventListener("click", exportarBackupJSON);
$("btnImportarBackup").addEventListener("click", () => $("archivoBackup").click());
$("archivoBackup").addEventListener("change", importarBackupArchivo);
$("archivosCompra").addEventListener("change", agregarArchivos);
$("btnMigrarLocal").addEventListener("click", migrarDatosLocales);
$("btnLimpiar").addEventListener("click", async () => {
  if (!activeProfile || !confirm(`Esto eliminará todas las compras del perfil ${activeProfile} en la nube. ¿Continuar?`)) return;
  try { await apiFetch(`/compras/api/profiles/${encodeURIComponent(activeProfile)}/purchases`, { method: "DELETE" }); compras = []; expandedId = null; render(); await renderProfileScreen(); showStatus("Perfil limpiado."); }
  catch (error) { alert(error.message); }
});
$("formCompra").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("btnGuardarCompra");
  button.disabled = true; button.textContent = "Guardando...";
  const idInterno = $("compraIdInterno").value || crypto.randomUUID();
  const compra = {
    idInterno,
    fechaPublicacion: $("fechaPublicacion").value,
    cliente: $("cliente").value.trim(),
    idCompra: $("idCompra").value.trim(),
    destino: $("destino").value.trim(),
    detalleServicio: $("detalleServicio").value.trim(),
    montoCobrado: Number($("montoCobrado").value || 0),
    fechaCierre: $("fechaCierre").value,
    factorComercial: Number($("factorComercial").value || 0),
    estado: $("estado").value,
    archivos: archivosModal,
    ordenCompraId: $("ordenCompraId").value.trim(),
    facturacionNombre: $("facturacionNombre").value.trim(),
    facturacionEmail: $("facturacionEmail").value.trim(),
    facturacionTelefono: $("facturacionTelefono").value.trim(),
    coordinacionNombre: $("coordinacionNombre").value.trim(),
    coordinacionEmail: $("coordinacionEmail").value.trim(),
    coordinacionTelefono: $("coordinacionTelefono").value.trim(),
    fechaEnvioFactura: $("fechaEnvioFactura").value,
    fechaPago: $("fechaPago").value
  };
  try {
    const saved = await apiFetch(`/compras/api/profiles/${encodeURIComponent(activeProfile)}/purchases/${encodeURIComponent(idInterno)}`, { method: "PUT", body: compra });
    const index = compras.findIndex(c => c.idInterno === idInterno);
    if (index >= 0) compras[index] = saved; else compras.unshift(saved);
    cerrarModal(); render(); await renderProfileScreen(); showStatus("Compra guardada en la nube.");
  } catch (error) { alert(`No se pudo guardar: ${error.message}`); }
  finally { button.disabled = false; button.textContent = "Guardar compra"; }
});
document.querySelectorAll(".menu-item").forEach(btn => btn.addEventListener("click", () => {
  document.querySelectorAll(".menu-item").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  $("viewCompras").classList.toggle("hidden", btn.dataset.view !== "compras");
  $("viewResumen").classList.toggle("hidden", btn.dataset.view !== "resumen");
}));

window.seleccionarPerfil = seleccionarPerfil;
window.editarCompra = editarCompra;
window.eliminarCompra = eliminarCompra;
window.toggleDetalle = toggleDetalle;
window.quitarArchivoModal = quitarArchivoModal;
window.descargarArchivo = descargarArchivo;
renderProfileScreen();
