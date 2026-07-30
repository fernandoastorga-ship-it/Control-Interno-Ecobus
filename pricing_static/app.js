const MAPBOX_TOKEN = window.ECOBUS_CONFIG?.MAPBOX_TOKEN || "";
const BASE = { lat: -33.60627, lng: -70.87649 };

let origenCoords = null;
let destinoCoords = null;
let origenTexto = "";
let destinoTexto = "";
let ultimoResultado = null;
let cotizaciones = [];
let editandoId = null;

const $ = id => document.getElementById(id);

async function api(url, options = {}) {
  const config = { credentials: "same-origin", ...options };
  if (config.body && typeof config.body !== "string") {
    config.headers = { "Content-Type": "application/json", ...(config.headers || {}) };
    config.body = JSON.stringify(config.body);
  }
  const response = await fetch(url, config);
  if (response.status === 401) {
    location.href = "/login";
    throw new Error("Sesión vencida");
  }
  if (!response.ok) {
    let detail = "No se pudo completar la operación";
    try { detail = (await response.json()).detail || detail; } catch (_) {}
    throw new Error(detail);
  }
  return response.status === 204 ? null : response.json();
}

function html(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
}

function formatoCLP(value) {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function formatearFecha(fechaISO) {
  if (!fechaISO) return "-";
  const p = fechaISO.slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : fechaISO;
}

function hoy() { return new Date().toISOString().slice(0, 10); }

window.addEventListener("load", async () => {
  if (!MAPBOX_TOKEN) {
    alert("Falta configurar MAPBOX_TOKEN en Render. La calculadora no podrá buscar ni calcular rutas hasta agregarlo.");
  }
  const origen = $("origenSearch");
  const destino = $("destinoSearch");
  origen.accessToken = MAPBOX_TOKEN;
  destino.accessToken = MAPBOX_TOKEN;

  origen.addEventListener("retrieve", event => {
    const f = event.detail.features[0];
    origenCoords = { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
    origenTexto = f.properties.full_address || f.properties.name || f.properties.place_formatted || "Origen seleccionado";
  });
  destino.addEventListener("retrieve", event => {
    const f = event.detail.features[0];
    destinoCoords = { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
    destinoTexto = f.properties.full_address || f.properties.name || f.properties.place_formatted || "Destino seleccionado";
  });

  $("fechaServicio").value = hoy();
  $("btnCalcular").addEventListener("click", calcular);
  $("btnCancelarEdicion").addEventListener("click", limpiarFormulario);
  $("btnExportar").addEventListener("click", exportarJSON);
  $("btnImportar").addEventListener("click", () => $("archivoImportar").click());
  $("archivoImportar").addEventListener("change", importarJSON);

  await cargarCotizaciones();
});

async function distancia(a, b) {
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false&access_token=${MAPBOX_TOKEN}`;
  const response = await fetch(url);
  const data = await response.json();
  if (!data.routes?.[0]) throw new Error("Mapbox no pudo calcular la ruta.");
  return data.routes[0].distance / 1000;
}

function datosVehiculo(tipo) {
  if (tipo === "van") return { rendimiento: 5,3, texto: "Van" };
  if (tipo === "taxibus") return { rendimiento: 3.1, texto: "Taxibús" };
  return { rendimiento: 2.9, texto: "Bus" };
}

async function calcular() {
  try {
    if (!origenCoords || !destinoCoords) return alert("Selecciona origen y destino desde el autocompletado.");
    const petroleo = Number($("petroleo").value);
    const factor = Number($("factor").value);
    if (petroleo <= 0 || factor <= 0) return alert("Completa el precio del petróleo y el factor comercial.");

    $("btnCalcular").disabled = true;
    $("btnCalcular").textContent = "Calculando ruta...";

    const vehiculo = $("vehiculo").value;
    const tipoViaje = $("tipoViaje").value;
    const { rendimiento, texto: vehiculoTexto } = datosVehiculo(vehiculo);

    const [kmBaseOrigen, kmOrigenDestino, kmDestinoOrigen, kmOrigenBase, kmDestinoBase] = await Promise.all([
      distancia(BASE, origenCoords), distancia(origenCoords, destinoCoords), distancia(destinoCoords, origenCoords),
      distancia(origenCoords, BASE), distancia(destinoCoords, BASE)
    ]);

    const kmTotal = tipoViaje === "ida"
      ? kmBaseOrigen + kmOrigenDestino + kmDestinoBase
      : kmBaseOrigen + kmOrigenDestino + kmDestinoOrigen + kmOrigenBase;
    const precio = (kmTotal / rendimiento) * petroleo * factor;

    ultimoResultado = {
      nombre: $("nombreCliente").value.trim(),
      fechaServ: $("fechaServicio").value,
      pax: Number($("cantidadPasajeros").value) || null,
      origenTexto, destinoTexto, origenCoords, destinoCoords,
      tipoViajeCodigo: tipoViaje,
      tipoViaje: tipoViaje === "ida" ? "Solo ida" : "Ida y vuelta",
      vehiculoCodigo: vehiculo,
      vehiculo: vehiculoTexto,
      petroleo, factor, rendimiento,
      kmTotal: Number(kmTotal.toFixed(2)),
      precio: Math.round(precio),
      fechaEmision: new Date().toLocaleDateString("es-CL")
    };
    renderResultado();
  } catch (error) {
    console.error(error);
    alert(error.message || "Error calculando la ruta.");
  } finally {
    $("btnCalcular").disabled = false;
    $("btnCalcular").textContent = editandoId ? "Recalcular cotización" : "Calcular precio";
  }
}

function renderResultado() {
  const r = ultimoResultado;
  if (!r) return;
  const result = $("resultado");
  result.classList.remove("hidden");
  result.innerHTML = `
    <div class="result-grid">
      <div><b>Cliente:</b> ${html(r.nombre || "-")}</div><div><b>Fecha:</b> ${html(formatearFecha(r.fechaServ))}</div>
      <div><b>Origen:</b> ${html(r.origenTexto)}</div><div><b>Destino:</b> ${html(r.destinoTexto)}</div>
      <div><b>Vehículo:</b> ${html(r.vehiculo)}</div><div><b>Viaje:</b> ${html(r.tipoViaje)}</div>
      <div><b>Distancia operacional:</b> ${Number(r.kmTotal).toLocaleString("es-CL")} km</div><div><b>Pasajeros:</b> ${html(r.pax || "-")}</div>
    </div>
    <h3>${formatoCLP(r.precio)}</h3>
    <div class="result-actions">
      <button class="primary" onclick="guardarCotizacion()">${editandoId ? "Actualizar cotización" : "Guardar cotización"}</button>
      <button class="secondary" onclick="descargarCotizacion()">Descargar PDF</button>
    </div>`;
}

async function guardarCotizacion() {
  if (!ultimoResultado) return alert("Primero calcula una cotización.");
  try {
    const endpoint = editandoId ? `/pricing/api/quotes/${encodeURIComponent(editandoId)}` : "/pricing/api/quotes";
    const method = editandoId ? "PUT" : "POST";
    const saved = await api(endpoint, { method, body: { id: editandoId, data: ultimoResultado } });
    editandoId = saved.id;
    $("modoEdicion").classList.remove("hidden");
    $("btnCancelarEdicion").classList.remove("hidden");
    await cargarCotizaciones();
    alert("Cotización guardada correctamente.");
  } catch (error) { alert(error.message); }
}

async function cargarCotizaciones() {
  try {
    cotizaciones = await api("/pricing/api/quotes");
    renderHistorial();
  } catch (error) {
    $("tablaCotizaciones").innerHTML = `<tr><td colspan="7" class="empty">${html(error.message)}</td></tr>`;
  }
}

function renderHistorial() {
  const tbody = $("tablaCotizaciones");
  if (!cotizaciones.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">Todavía no hay cotizaciones guardadas.</td></tr>';
    return;
  }
  tbody.innerHTML = cotizaciones.map(q => `
    <tr>
      <td>${html(formatearFecha(q.fechaServ || q.createdAt))}</td>
      <td><b>${html(q.nombre || "Sin cliente")}</b><br><small>${html(q.id)}</small></td>
      <td>${html(q.origenTexto || "-")}<br>→ ${html(q.destinoTexto || "-")}</td>
      <td>${html(q.vehiculo || "-")}</td>
      <td>${Number(q.kmTotal || 0).toLocaleString("es-CL")} km</td>
      <td><b>${formatoCLP(q.precio)}</b></td>
      <td><div class="table-actions"><button class="secondary" onclick="cargarCotizacion('${q.id}')">Cargar</button><button class="secondary" onclick="pdfHistorial('${q.id}')">PDF</button><button class="danger" onclick="eliminarCotizacion('${q.id}')">Eliminar</button></div></td>
    </tr>`).join("");
}

function cargarCotizacion(id) {
  const q = cotizaciones.find(x => x.id === id);
  if (!q) return;
  editandoId = id;
  ultimoResultado = { ...q };
  $("nombreCliente").value = q.nombre || "";
  $("fechaServicio").value = (q.fechaServ || "").slice(0, 10);
  $("cantidadPasajeros").value = q.pax || "";
  $("vehiculo").value = q.vehiculoCodigo || "bus";
  $("tipoViaje").value = q.tipoViajeCodigo || "ida";
  $("petroleo").value = q.petroleo || 1450;
  $("factor").value = q.factor || 3.7;
  origenTexto = q.origenTexto || "";
  destinoTexto = q.destinoTexto || "";
  origenCoords = q.origenCoords || null;
  destinoCoords = q.destinoCoords || null;
  $("origenSearch").value = origenTexto;
  $("destinoSearch").value = destinoTexto;
  $("modoEdicion").classList.remove("hidden");
  $("btnCancelarEdicion").classList.remove("hidden");
  $("btnCalcular").textContent = "Recalcular cotización";
  renderResultado();
  scrollTo({ top: 0, behavior: "smooth" });
}

function limpiarFormulario() {
  editandoId = null;
  ultimoResultado = null;
  origenCoords = destinoCoords = null;
  origenTexto = destinoTexto = "";
  $("nombreCliente").value = "";
  $("fechaServicio").value = hoy();
  $("cantidadPasajeros").value = "";
  $("vehiculo").value = "bus";
  $("tipoViaje").value = "ida";
  $("origenSearch").value = "";
  $("destinoSearch").value = "";
  $("resultado").classList.add("hidden");
  $("modoEdicion").classList.add("hidden");
  $("btnCancelarEdicion").classList.add("hidden");
  $("btnCalcular").textContent = "Calcular precio";
}

async function eliminarCotizacion(id) {
  if (!confirm("¿Eliminar esta cotización del historial?")) return;
  try {
    await api(`/pricing/api/quotes/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (editandoId === id) limpiarFormulario();
    await cargarCotizaciones();
  } catch (error) { alert(error.message); }
}

function pdfHistorial(id) {
  const q = cotizaciones.find(x => x.id === id);
  if (!q) return;
  ultimoResultado = { ...q };
  descargarCotizacion();
}

function exportarJSON() {
  const blob = new Blob([JSON.stringify({ generado: new Date().toISOString(), cotizaciones }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `respaldo_pricing_ecobus_${hoy()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importarJSON(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const list = Array.isArray(parsed) ? parsed : parsed.cotizaciones;
    if (!Array.isArray(list)) throw new Error("El archivo no contiene una lista de cotizaciones válida.");
    if (!confirm(`Se importarán ${list.length} cotizaciones. Los ID repetidos serán actualizados. ¿Continuar?`)) return;
    const result = await api("/pricing/api/import", { method: "POST", body: { cotizaciones: list } });
    await cargarCotizaciones();
    alert(`${result.imported} cotizaciones importadas y ${result.updated} actualizadas.`);
  } catch (error) { alert(`No se pudo importar: ${error.message}`); }
  finally { event.target.value = ""; }
}

async function descargarCotizacion() {
  try {
    if (!ultimoResultado) return alert("Primero calcula o carga una cotización.");
    if (!window.jspdf?.jsPDF) return alert("No se pudo cargar jsPDF.");
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF("p", "mm", "a4");
    const r = ultimoResultado;
    const verde = [15, 107, 58];
    const logoEcobus = await cargarImagenBase64("/pricing/assets/logo-ecobus.png");
    const logoEcovan = await cargarImagenBase64("/pricing/assets/logo-ecovan.png");

    doc.setFillColor(238, 248, 241); doc.rect(0, 0, 210, 44, "F");
    if (logoEcobus) doc.addImage(logoEcobus, "PNG", 15, 9, 42, 19);
    if (logoEcovan) doc.addImage(logoEcovan, "PNG", 153, 10, 42, 18);
    doc.setDrawColor(...verde); doc.setLineWidth(1); doc.line(15, 40, 195, 40);
    doc.setTextColor(...verde); doc.setFont("helvetica", "bold"); doc.setFontSize(19);
    doc.text("Cotización de Servicio de Transporte", 105, 58, { align: "center" });
    doc.setTextColor(90,90,90); doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    doc.text(`Fecha de emisión: ${r.fechaEmision || new Date().toLocaleDateString("es-CL")}`, 105, 66, { align: "center" });

    doc.setDrawColor(220,220,220); doc.roundedRect(15, 78, 180, 91, 4, 4, "S");
    doc.setFillColor(...verde); doc.roundedRect(15, 78, 180, 12, 4, 4, "F");
    doc.setTextColor(255,255,255); doc.setFont("helvetica","bold"); doc.setFontSize(11); doc.text("Datos del servicio",20,86);
    doc.setTextColor(35,35,35); doc.setFontSize(10);
    const rows = [
      ["Cliente", r.nombre || "-"], ["Fecha del servicio", formatearFecha(r.fechaServ)], ["Pasajeros", r.pax || "-"],
      ["Origen", r.origenTexto || "-"], ["Destino", r.destinoTexto || "-"], ["Tipo de viaje", r.tipoViaje || "-"],
      ["Vehículo", r.vehiculo || "-"], ["Distancia operacional", `${Number(r.kmTotal || 0).toLocaleString("es-CL")} km`]
    ];
    let y = 101;
    for (const [label, value] of rows) {
      doc.setFont("helvetica","bold"); doc.text(`${label}:`,22,y); doc.setFont("helvetica","normal");
      const lines = doc.splitTextToSize(String(value),124); doc.text(lines,70,y); y += Math.max(8, lines.length * 5);
    }
    doc.setFillColor(...verde); doc.roundedRect(15, 181, 180, 25, 5, 5, "F");
    doc.setTextColor(255,255,255); doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.text("Total estimado",105,191,{align:"center"});
    doc.setFontSize(18); doc.text(formatoCLP(r.precio),105,201,{align:"center"});
    doc.setTextColor(...verde); doc.setFontSize(12); doc.text("Condiciones comerciales",15,226);
    doc.setTextColor(60,60,60); doc.setFont("helvetica","normal"); doc.setFontSize(9);
    const conditions = ["Cotización válida durante 15 días desde su envío.", "Valor sujeto a disponibilidad operacional y confirmación comercial.", "Contacto: confirmaciones@ecobus.cl"];
    let yc=237; for(const text of conditions){const lines=doc.splitTextToSize(`• ${text}`,180);doc.text(lines,15,yc);yc+=lines.length*5+4;}
    doc.setDrawColor(...verde);doc.line(15,280,195,280);doc.setTextColor(100,100,100);doc.setFontSize(8);doc.text("Ecobus / Ecovan - Transporte privado de pasajeros",105,287,{align:"center"});
    doc.save(`cotizacion-ecobus-${(r.nombre || "cliente").replace(/[^a-z0-9]+/gi,"-").toLowerCase()}.pdf`);
  } catch (error) { console.error(error); alert(`No se pudo generar el PDF: ${error.message}`); }
}

function cargarImagenBase64(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => { try { const canvas=document.createElement("canvas");canvas.width=img.naturalWidth||img.width;canvas.height=img.naturalHeight||img.height;canvas.getContext("2d").drawImage(img,0,0);resolve(canvas.toDataURL("image/png")); } catch (_) { resolve(null); } };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
