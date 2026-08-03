const MAPBOX_TOKEN = window.ECOBUS_CONFIG?.MAPBOX_TOKEN || "";

const BASE = {
  lat: -33.60627,
  lng: -70.87649
};

let origenCoords = null;
let destinoCoords = null;
let origenTexto = "";
let destinoTexto = "";
let ultimoResultado = null;
let cotizaciones = [];
let editandoId = null;

const $ = id => document.getElementById(id);


/* =========================================================
   API DEL SISTEMA
========================================================= */

async function api(url, options = {}) {
  const config = {
    credentials: "same-origin",
    ...options
  };

  if (config.body && typeof config.body !== "string") {
    config.headers = {
      "Content-Type": "application/json",
      ...(config.headers || {})
    };

    config.body = JSON.stringify(config.body);
  }

  const response = await fetch(url, config);

  if (response.status === 401) {
    location.href = "/login";
    throw new Error("Sesión vencida");
  }

  if (!response.ok) {
    let detail = "No se pudo completar la operación";

    try {
      const errorData = await response.json();
      detail = errorData.detail || detail;
    } catch (_) {
      // La respuesta no contenía JSON.
    }

    throw new Error(detail);
  }

  return response.status === 204
    ? null
    : response.json();
}


/* =========================================================
   FUNCIONES GENERALES
========================================================= */

function html(value) {
  return String(value ?? "").replace(
    /[&<>'"]/g,
    caracter => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    }[caracter])
  );
}


function formatoCLP(value) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}


function formatearFecha(fechaISO) {
  if (!fechaISO) {
    return "-";
  }

  const partes = fechaISO
    .slice(0, 10)
    .split("-");

  return partes.length === 3
    ? `${partes[2]}-${partes[1]}-${partes[0]}`
    : fechaISO;
}


function hoy() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}


/* =========================================================
   INICIO DE LA CALCULADORA
========================================================= */

window.addEventListener("load", async () => {
  if (!MAPBOX_TOKEN) {
    alert(
      "Falta configurar MAPBOX_TOKEN en Render. " +
      "La calculadora no podrá buscar ni calcular rutas hasta agregarlo."
    );
  }

  const origen = $("origenSearch");
  const destino = $("destinoSearch");

  if (!origen || !destino) {
    alert(
      "No se encontraron los buscadores de origen y destino."
    );

    return;
  }

  origen.accessToken = MAPBOX_TOKEN;
  destino.accessToken = MAPBOX_TOKEN;


  /* Cuando el usuario selecciona un origen */

  origen.addEventListener("retrieve", event => {
    const feature = event.detail?.features?.[0];

    if (!feature?.geometry?.coordinates) {
      return;
    }

    const coordinates = feature.geometry.coordinates;

    origenCoords = {
      lng: coordinates[0],
      lat: coordinates[1]
    };

    origenTexto =
      feature.properties?.full_address ||
      feature.properties?.name ||
      feature.properties?.place_formatted ||
      "Origen seleccionado";
  });


  /* Cuando el usuario selecciona un destino */

  destino.addEventListener("retrieve", event => {
    const feature = event.detail?.features?.[0];

    if (!feature?.geometry?.coordinates) {
      return;
    }

    const coordinates = feature.geometry.coordinates;

    destinoCoords = {
      lng: coordinates[0],
      lat: coordinates[1]
    };

    destinoTexto =
      feature.properties?.full_address ||
      feature.properties?.name ||
      feature.properties?.place_formatted ||
      "Destino seleccionado";
  });


  /* Si el usuario cambia manualmente una dirección,
     se borran las coordenadas anteriores hasta que vuelva
     a seleccionar una opción del autocompletado. */

  origen.addEventListener("input", () => {
    origenCoords = null;
    origenTexto = "";
  });

  destino.addEventListener("input", () => {
    destinoCoords = null;
    destinoTexto = "";
  });


  $("fechaServicio").value = hoy();

  $("btnCalcular")
    .addEventListener("click", calcular);

  $("btnCancelarEdicion")
    .addEventListener("click", limpiarFormulario);

  $("btnExportar")
    .addEventListener("click", exportarJSON);

  $("btnImportar")
    .addEventListener(
      "click",
      () => $("archivoImportar").click()
    );

  $("archivoImportar")
    .addEventListener("change", importarJSON);

  await cargarCotizaciones();
});


/* =========================================================
   MAPBOX Y CÁLCULO DE DISTANCIAS
========================================================= */

async function distancia(puntoA, puntoB) {
  const coordenadas =
    `${puntoA.lng},${puntoA.lat};` +
    `${puntoB.lng},${puntoB.lat}`;

  const parametros = new URLSearchParams({
    overview: "false",
    access_token: MAPBOX_TOKEN
  });

  const url =
    `https://api.mapbox.com/directions/v5/` +
    `mapbox/driving/${coordenadas}?${parametros}`;

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.message ||
      "Mapbox no pudo procesar la solicitud."
    );
  }

  if (!data.routes?.[0]) {
    throw new Error(
      "Mapbox no pudo calcular la ruta entre las ubicaciones seleccionadas."
    );
  }

  return data.routes[0].distance / 1000;
}


/* =========================================================
   PARÁMETROS DE VEHÍCULOS
========================================================= */

function datosVehiculo(tipo) {
  if (tipo === "van") {
    return {
      rendimiento: 5.3,
      texto: "Van"
    };
  }

  if (tipo === "taxibus") {
    return {
      rendimiento: 3.1,
      texto: "Taxibús"
    };
  }

  return {
    rendimiento: 2.9,
    texto: "Bus"
  };
}


/* =========================================================
   CÁLCULO DEL PRECIO
========================================================= */

async function calcular() {
  try {
    if (!MAPBOX_TOKEN) {
      alert(
        "No está configurado el token de Mapbox."
      );

      return;
    }

    if (!origenCoords || !destinoCoords) {
      alert(
        "Selecciona origen y destino desde las opciones del autocompletado."
      );

      return;
    }

    const petroleo = Number(
      $("petroleo").value
    );

    const factor = Number(
      $("factor").value
    );

    if (petroleo <= 0 || factor <= 0) {
      alert(
        "Completa correctamente el precio del petróleo y el factor comercial."
      );

      return;
    }

    const boton = $("btnCalcular");

    boton.disabled = true;
    boton.textContent = "Calculando ruta...";

    const vehiculo = $("vehiculo").value;
    const tipoViaje = $("tipoViaje").value;

    const {
      rendimiento,
      texto: vehiculoTexto
    } = datosVehiculo(vehiculo);


    /* Distancias operacionales */

    const [
      kmBaseOrigen,
      kmOrigenDestino,
      kmDestinoOrigen,
      kmOrigenBase,
      kmDestinoBase
    ] = await Promise.all([
      distancia(BASE, origenCoords),
      distancia(origenCoords, destinoCoords),
      distancia(destinoCoords, origenCoords),
      distancia(origenCoords, BASE),
      distancia(destinoCoords, BASE)
    ]);


    let kmTotal = 0;

    if (tipoViaje === "ida") {
      /*
        Base Ecobus → Origen
        Origen → Destino
        Destino → Base Ecobus
      */

      kmTotal =
        kmBaseOrigen +
        kmOrigenDestino +
        kmDestinoBase;
    } else {
      /*
        Base Ecobus → Origen
        Origen → Destino
        Destino → Origen
        Origen → Base Ecobus
      */

      kmTotal =
        kmBaseOrigen +
        kmOrigenDestino +
        kmDestinoOrigen +
        kmOrigenBase;
    }


    const precio =
      (kmTotal / rendimiento) *
      petroleo *
      factor;


    ultimoResultado = {
      nombre: $("nombreCliente").value.trim(),

      fechaServ:
        $("fechaServicio").value,

      pax:
        Number($("cantidadPasajeros").value) ||
        null,

      origenTexto,
      destinoTexto,
      origenCoords,
      destinoCoords,

      tipoViajeCodigo: tipoViaje,

      tipoViaje:
        tipoViaje === "ida"
          ? "Solo ida"
          : "Ida y vuelta",

      vehiculoCodigo: vehiculo,
      vehiculo: vehiculoTexto,

      petroleo,
      factor,
      rendimiento,

      kmTotal:
        Number(kmTotal.toFixed(2)),

      precio:
        Math.round(precio),

      fechaEmision:
        new Date().toLocaleDateString("es-CL")
    };

    renderResultado();

  } catch (error) {
    console.error(
      "Error calculando la ruta:",
      error
    );

    alert(
      error.message ||
      "Error calculando la ruta. Revisa las ubicaciones seleccionadas."
    );

  } finally {
    const boton = $("btnCalcular");

    boton.disabled = false;

    boton.textContent =
      editandoId
        ? "Recalcular cotización"
        : "Calcular precio";
  }
}


/* =========================================================
   RESULTADO EN PANTALLA
========================================================= */

function renderResultado() {
  const resultado = ultimoResultado;

  if (!resultado) {
    return;
  }

  const contenedor = $("resultado");

  contenedor.classList.remove("hidden");

  contenedor.innerHTML = `
    <div class="result-grid">

      <div>
        <b>Cliente:</b>
        ${html(resultado.nombre || "-")}
      </div>

      <div>
        <b>Fecha:</b>
        ${html(formatearFecha(resultado.fechaServ))}
      </div>

      <div>
        <b>Origen:</b>
        ${html(resultado.origenTexto)}
      </div>

      <div>
        <b>Destino:</b>
        ${html(resultado.destinoTexto)}
      </div>

      <div>
        <b>Vehículo:</b>
        ${html(resultado.vehiculo)}
      </div>

      <div>
        <b>Viaje:</b>
        ${html(resultado.tipoViaje)}
      </div>

      <div>
        <b>Distancia operacional:</b>
        ${Number(resultado.kmTotal).toLocaleString("es-CL")} km
      </div>

      <div>
        <b>Pasajeros:</b>
        ${html(resultado.pax || "-")}
      </div>

    </div>

    <h3>
      ${formatoCLP(resultado.precio)}
    </h3>

    <div class="result-actions">

      <button
        class="primary"
        onclick="guardarCotizacion()"
      >
        ${
          editandoId
            ? "Actualizar cotización"
            : "Guardar cotización"
        }
      </button>

      <button
        class="secondary"
        onclick="descargarCotizacion()"
      >
        Descargar PDF
      </button>

    </div>
  `;
}


/* =========================================================
   GUARDAR COTIZACIÓN
========================================================= */

async function guardarCotizacion() {
  if (!ultimoResultado) {
    alert(
      "Primero calcula una cotización."
    );

    return;
  }

  try {
    const endpoint = editandoId
      ? `/pricing/api/quotes/${encodeURIComponent(editandoId)}`
      : "/pricing/api/quotes";

    const method = editandoId
      ? "PUT"
      : "POST";

    const saved = await api(endpoint, {
      method,
      body: {
        id: editandoId,
        data: ultimoResultado
      }
    });

    editandoId = saved.id;

    $("modoEdicion")
      .classList
      .remove("hidden");

    $("btnCancelarEdicion")
      .classList
      .remove("hidden");

    await cargarCotizaciones();

    alert(
      "Cotización guardada correctamente."
    );

  } catch (error) {
    alert(error.message);
  }
}


/* =========================================================
   HISTORIAL
========================================================= */

async function cargarCotizaciones() {
  try {
    cotizaciones = await api(
      "/pricing/api/quotes"
    );

    renderHistorial();

  } catch (error) {
    $("tablaCotizaciones").innerHTML = `
      <tr>
        <td colspan="7" class="empty">
          ${html(error.message)}
        </td>
      </tr>
    `;
  }
}


function renderHistorial() {
  const tbody = $("tablaCotizaciones");

  if (!cotizaciones.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty">
          Todavía no hay cotizaciones guardadas.
        </td>
      </tr>
    `;

    return;
  }

  tbody.innerHTML = cotizaciones
    .map(cotizacion => `
      <tr>

        <td>
          ${html(
            formatearFecha(
              cotizacion.fechaServ ||
              cotizacion.createdAt
            )
          )}
        </td>

        <td>
          <b>
            ${html(
              cotizacion.nombre ||
              "Sin cliente"
            )}
          </b>

          <br>

          <small>
            ${html(cotizacion.id)}
          </small>
        </td>

        <td>
          ${html(cotizacion.origenTexto || "-")}

          <br>

          →

          ${html(cotizacion.destinoTexto || "-")}
        </td>

        <td>
          ${html(cotizacion.vehiculo || "-")}
        </td>

        <td>
          ${Number(
            cotizacion.kmTotal || 0
          ).toLocaleString("es-CL")} km
        </td>

        <td>
          <b>
            ${formatoCLP(cotizacion.precio)}
          </b>
        </td>

        <td>
          <div class="table-actions">

            <button
              class="secondary"
              onclick="cargarCotizacion('${cotizacion.id}')"
            >
              Cargar
            </button>

            <button
              class="secondary"
              onclick="pdfHistorial('${cotizacion.id}')"
            >
              PDF
            </button>

            <button
              class="danger"
              onclick="eliminarCotizacion('${cotizacion.id}')"
            >
              Eliminar
            </button>

          </div>
        </td>

      </tr>
    `)
    .join("");
}


/* =========================================================
   CARGAR COTIZACIÓN PARA EDITAR
========================================================= */

function cargarCotizacion(id) {
  const cotizacion = cotizaciones.find(
    item => item.id === id
  );

  if (!cotizacion) {
    return;
  }

  editandoId = id;

  ultimoResultado = {
    ...cotizacion
  };

  $("nombreCliente").value =
    cotizacion.nombre || "";

  $("fechaServicio").value =
    (cotizacion.fechaServ || "")
      .slice(0, 10);

  $("cantidadPasajeros").value =
    cotizacion.pax || "";

  $("vehiculo").value =
    cotizacion.vehiculoCodigo ||
    "bus";

  $("tipoViaje").value =
    cotizacion.tipoViajeCodigo ||
    "ida";

  $("petroleo").value =
    cotizacion.petroleo ||
    1450;

  $("factor").value =
    cotizacion.factor ||
    3.7;

  origenTexto =
    cotizacion.origenTexto || "";

  destinoTexto =
    cotizacion.destinoTexto || "";

  origenCoords =
    cotizacion.origenCoords || null;

  destinoCoords =
    cotizacion.destinoCoords || null;

  $("origenSearch").value =
    origenTexto;

  $("destinoSearch").value =
    destinoTexto;

  $("modoEdicion")
    .classList
    .remove("hidden");

  $("btnCancelarEdicion")
    .classList
    .remove("hidden");

  $("btnCalcular").textContent =
    "Recalcular cotización";

  renderResultado();

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}


/* =========================================================
   LIMPIAR FORMULARIO
========================================================= */

function limpiarFormulario() {
  editandoId = null;
  ultimoResultado = null;

  origenCoords = null;
  destinoCoords = null;

  origenTexto = "";
  destinoTexto = "";

  $("nombreCliente").value = "";
  $("fechaServicio").value = hoy();
  $("cantidadPasajeros").value = "";

  $("vehiculo").value = "bus";
  $("tipoViaje").value = "ida";

  $("origenSearch").value = "";
  $("destinoSearch").value = "";

  $("resultado")
    .classList
    .add("hidden");

  $("modoEdicion")
    .classList
    .add("hidden");

  $("btnCancelarEdicion")
    .classList
    .add("hidden");

  $("btnCalcular").textContent =
    "Calcular precio";
}


/* =========================================================
   ELIMINAR COTIZACIÓN
========================================================= */

async function eliminarCotizacion(id) {
  const confirmar = confirm(
    "¿Eliminar esta cotización del historial?"
  );

  if (!confirmar) {
    return;
  }

  try {
    await api(
      `/pricing/api/quotes/${encodeURIComponent(id)}`,
      {
        method: "DELETE"
      }
    );

    if (editandoId === id) {
      limpiarFormulario();
    }

    await cargarCotizaciones();

  } catch (error) {
    alert(error.message);
  }
}


/* =========================================================
   PDF DESDE EL HISTORIAL
========================================================= */

function pdfHistorial(id) {
  const cotizacion = cotizaciones.find(
    item => item.id === id
  );

  if (!cotizacion) {
    return;
  }

  ultimoResultado = {
    ...cotizacion
  };

  descargarCotizacion();
}


/* =========================================================
   EXPORTAR RESPALDO
========================================================= */

function exportarJSON() {
  const contenido = {
    generado: new Date().toISOString(),
    cotizaciones
  };

  const blob = new Blob(
    [
      JSON.stringify(
        contenido,
        null,
        2
      )
    ],
    {
      type: "application/json"
    }
  );

  const enlace =
    document.createElement("a");

  enlace.href =
    URL.createObjectURL(blob);

  enlace.download =
    `respaldo_pricing_ecobus_${hoy()}.json`;

  enlace.click();

  URL.revokeObjectURL(enlace.href);
}


/* =========================================================
   IMPORTAR RESPALDO
========================================================= */

async function importarJSON(event) {
  const file = event.target.files?.[0];

  if (!file) {
    return;
  }

  try {
    const contenido =
      await file.text();

    const parsed =
      JSON.parse(contenido);

    const lista =
      Array.isArray(parsed)
        ? parsed
        : parsed.cotizaciones;

    if (!Array.isArray(lista)) {
      throw new Error(
        "El archivo no contiene una lista de cotizaciones válida."
      );
    }

    const continuar = confirm(
      `Se importarán ${lista.length} cotizaciones. ` +
      "Los ID repetidos serán actualizados. ¿Continuar?"
    );

    if (!continuar) {
      return;
    }

    const result = await api(
      "/pricing/api/import",
      {
        method: "POST",
        body: {
          cotizaciones: lista
        }
      }
    );

    await cargarCotizaciones();

    alert(
      `${result.imported} cotizaciones importadas ` +
      `y ${result.updated} actualizadas.`
    );

  } catch (error) {
    alert(
      `No se pudo importar: ${error.message}`
    );

  } finally {
    event.target.value = "";
  }
}


/* =========================================================
   GENERACIÓN DEL PDF
========================================================= */

async function descargarCotizacion() {
  try {
    if (!ultimoResultado) {
      alert(
        "Primero calcula o carga una cotización."
      );

      return;
    }

    if (!window.jspdf?.jsPDF) {
      alert(
        "No se pudo cargar jsPDF."
      );

      return;
    }

    const { jsPDF } = window.jspdf;

    const doc =
      new jsPDF("p", "mm", "a4");

    const resultado =
      ultimoResultado;

    const verde = [
      15,
      107,
      58
    ];

    const logoEcobus =
      await cargarImagenBase64(
        "/pricing/assets/logo-ecobus.png"
      );

    const logoEcovan =
      await cargarImagenBase64(
        "/pricing/assets/logo-ecovan.png"
      );


    /* Fondo del encabezado */

    doc.setFillColor(
      238,
      248,
      241
    );

    doc.rect(
      0,
      0,
      210,
      44,
      "F"
    );


    /* Logos */

    if (logoEcobus) {
      doc.addImage(
        logoEcobus,
        "PNG",
        15,
        9,
        42,
        19
      );
    }

    if (logoEcovan) {
      doc.addImage(
        logoEcovan,
        "PNG",
        153,
        10,
        42,
        18
      );
    }


    /* Línea superior */

    doc.setDrawColor(...verde);
    doc.setLineWidth(1);

    doc.line(
      15,
      40,
      195,
      40
    );


    /* Título */

    doc.setTextColor(...verde);
    doc.setFont(
      "helvetica",
      "bold"
    );

    doc.setFontSize(19);

    doc.text(
      "Cotización de Servicio de Transporte",
      105,
      58,
      {
        align: "center"
      }
    );


    /* Fecha de emisión */

    doc.setTextColor(
      90,
      90,
      90
    );

    doc.setFont(
      "helvetica",
      "normal"
    );

    doc.setFontSize(9);

    doc.text(
      `Fecha de emisión: ${
        resultado.fechaEmision ||
        new Date().toLocaleDateString("es-CL")
      }`,
      105,
      66,
      {
        align: "center"
      }
    );


    /* Tarjeta de datos */

    doc.setDrawColor(
      220,
      220,
      220
    );

    doc.roundedRect(
      15,
      78,
      180,
      91,
      4,
      4,
      "S"
    );

    doc.setFillColor(...verde);

    doc.roundedRect(
      15,
      78,
      180,
      12,
      4,
      4,
      "F"
    );

    doc.setTextColor(
      255,
      255,
      255
    );

    doc.setFont(
      "helvetica",
      "bold"
    );

    doc.setFontSize(11);

    doc.text(
      "Datos del servicio",
      20,
      86
    );

    doc.setTextColor(
      35,
      35,
      35
    );

    doc.setFontSize(10);


    /*
      La distancia operacional no se agrega aquí,
      por lo que no aparecerá en el PDF.
    */

    const filas = [
      [
        "Cliente",
        resultado.nombre || "-"
      ],
      [
        "Fecha del servicio",
        formatearFecha(
          resultado.fechaServ
        )
      ],
      [
        "Pasajeros",
        resultado.pax || "-"
      ],
      [
        "Origen",
        resultado.origenTexto || "-"
      ],
      [
        "Destino",
        resultado.destinoTexto || "-"
      ],
      [
        "Tipo de viaje",
        resultado.tipoViaje || "-"
      ],
      [
        "Vehículo",
        resultado.vehiculo || "-"
      ]
    ];


    let y = 101;

    for (const [label, value] of filas) {
      doc.setFont(
        "helvetica",
        "bold"
      );

      doc.text(
        `${label}:`,
        22,
        y
      );

      doc.setFont(
        "helvetica",
        "normal"
      );

      const lineas =
        doc.splitTextToSize(
          String(value),
          124
        );

      doc.text(
        lineas,
        70,
        y
      );

      y += Math.max(
        8,
        lineas.length * 5
      );
    }


    /* Precio final */

    doc.setFillColor(...verde);

    doc.roundedRect(
      15,
      181,
      180,
      25,
      5,
      5,
      "F"
    );

    doc.setTextColor(
      255,
      255,
      255
    );

    doc.setFont(
      "helvetica",
      "bold"
    );

    doc.setFontSize(12);

    doc.text(
      "Total estimado",
      105,
      191,
      {
        align: "center"
      }
    );

    doc.setFontSize(18);

    doc.text(
      formatoCLP(resultado.precio),
      105,
      201,
      {
        align: "center"
      }
    );


    /* Condiciones comerciales */

    doc.setTextColor(...verde);
    doc.setFontSize(12);

    doc.text(
      "Condiciones comerciales",
      15,
      226
    );

    doc.setTextColor(
      60,
      60,
      60
    );

    doc.setFont(
      "helvetica",
      "normal"
    );

    doc.setFontSize(9);

    const condiciones = [
      "Cotización válida durante 15 días desde su envío.",
      "Valor sujeto a disponibilidad operacional y confirmación comercial.",
      "Contacto: confirmaciones@ecobus.cl"
    ];

    let posicionCondiciones = 237;

    for (const texto of condiciones) {
      const lineas =
        doc.splitTextToSize(
          `• ${texto}`,
          180
        );

      doc.text(
        lineas,
        15,
        posicionCondiciones
      );

      posicionCondiciones +=
        lineas.length * 5 + 4;
    }


    /* Footer */

    doc.setDrawColor(...verde);

    doc.line(
      15,
      280,
      195,
      280
    );

    doc.setTextColor(
      100,
      100,
      100
    );

    doc.setFontSize(8);

    doc.text(
      "Ecobus / Ecovan - Transporte privado de pasajeros",
      105,
      287,
      {
        align: "center"
      }
    );


    const nombreArchivo =
      (resultado.nombre || "cliente")
        .replace(
          /[^a-z0-9]+/gi,
          "-"
        )
        .toLowerCase();

    doc.save(
      `cotizacion-ecobus-${nombreArchivo}.pdf`
    );

  } catch (error) {
    console.error(
      "Error generando PDF:",
      error
    );

    alert(
      `No se pudo generar el PDF: ${error.message}`
    );
  }
}


/* =========================================================
   CARGAR IMÁGENES PARA PDF
========================================================= */

function cargarImagenBase64(url) {
  return new Promise(resolve => {
    const img =
      new Image();

    img.onload = () => {
      try {
        const canvas =
          document.createElement(
            "canvas"
          );

        canvas.width =
          img.naturalWidth ||
          img.width;

        canvas.height =
          img.naturalHeight ||
          img.height;

        const context =
          canvas.getContext("2d");

        context.drawImage(
          img,
          0,
          0
        );

        resolve(
          canvas.toDataURL(
            "image/png"
          )
        );

      } catch (error) {
        console.warn(
          `No se pudo procesar la imagen ${url}:`,
          error
        );

        resolve(null);
      }
    };

    img.onerror = () => {
      console.warn(
        `No se pudo cargar la imagen ${url}`
      );

      resolve(null);
    };

    img.src = url;
  });
}
