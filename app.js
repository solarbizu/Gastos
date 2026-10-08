/* App de carga de gastos.
 *
 * No tiene servidor propio: guarda cada carga como un archivo en la carpeta inbox/
 * de tu repositorio privado de GitHub, usando una llave que vive solo en este
 * teléfono. La automatización del repositorio la valida y la pasa al libro.
 *
 * Todo el texto que viene de los datos se inserta con textContent, nunca como HTML.
 */
'use strict';
(() => {
  const VERSION = '1.1.0';
  const API = 'https://api.github.com';
  const $ = (id) => document.getElementById(id);
  const nf0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ------------------------------------------------------------ almacenamiento
  const guardado = {
    leer(clave, defecto) {
      try {
        const v = localStorage.getItem('fin.' + clave);
        return v === null ? defecto : JSON.parse(v);
      } catch { return defecto; }
    },
    escribir(clave, valor) {
      try { localStorage.setItem('fin.' + clave, JSON.stringify(valor)); } catch { /* sin espacio o modo privado */ }
    },
    borrarTodo() {
      try {
        Object.keys(localStorage).filter((k) => k.startsWith('fin.')).forEach((k) => localStorage.removeItem(k));
      } catch { /* nada */ }
    },
  };

  let cfg = guardado.leer('cfg', null);            // { repo, token }
  let catalogo = guardado.leer('catalogo', null);  // { categorias, medios, metas }
  let estado = guardado.leer('estado', null);      // data/estado.json
  let cola = guardado.leer('cola', []);            // cargas todavía no enviadas
  let historial = guardado.leer('historial', []);  // últimas cargas hechas acá
  let enviando = false;

  // ------------------------------------------------------------------ GitHub
  class ErrorApi extends Error {
    constructor(status) { super('HTTP ' + status); this.status = status; }
  }

  async function gh(ruta, { method = 'GET', body, raw = false, repo, token, espera = 15000 } = {}) {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), espera);
    try {
      return await fetch(`${API}/repos/${repo || cfg.repo}${ruta ? '/' + ruta : ''}`, {
        method,
        cache: 'no-store',
        signal: control.signal,
        headers: {
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          Authorization: `Bearer ${token || cfg.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } finally {
      clearTimeout(reloj);
    }
  }

  async function leerArchivo(ruta, opciones = {}) {
    const r = await gh('contents/' + ruta, { raw: true, ...opciones });
    if (r.status === 404) return null;
    if (!r.ok) throw new ErrorApi(r.status);
    return r.text();
  }

  function base64(texto) {
    const bytes = new TextEncoder().encode(texto);
    let binario = '';
    bytes.forEach((b) => { binario += String.fromCharCode(b); });
    return btoa(binario);
  }

  function explicar(error) {
    if (error instanceof ErrorApi) {
      if (error.status === 401) return 'La llave de acceso no es válida o venció. Creá una nueva en GitHub y pegala en Ajustes.';
      if (error.status === 403) return 'La llave no tiene permiso de escritura sobre el repositorio (Contents: Read and write).';
      if (error.status === 404) return 'No encuentro el repositorio. Revisá el nombre y que la llave tenga acceso a ese repositorio.';
      return `GitHub respondió con un error (${error.status}). Probá de nuevo en un rato.`;
    }
    return 'Sin conexión.';
  }

  // ----------------------------------------------------------------- fechas
  const dosDigitos = (n) => String(n).padStart(2, '0');
  function fechaLocal(d) {
    return `${d.getFullYear()}-${dosDigitos(d.getMonth() + 1)}-${dosDigitos(d.getDate())}`;
  }
  function isoLocal(d) {
    const dif = -d.getTimezoneOffset();
    const signo = dif >= 0 ? '+' : '-';
    const abs = Math.abs(dif);
    return `${fechaLocal(d)}T${dosDigitos(d.getHours())}:${dosDigitos(d.getMinutes())}:${dosDigitos(d.getSeconds())}`
      + `${signo}${dosDigitos(Math.floor(abs / 60))}:${dosDigitos(abs % 60)}`;
  }
  function fechaCorta(iso) {
    const [, m, d] = iso.slice(0, 10).split('-');
    return `${Number(d)}/${Number(m)}`;
  }

  // ------------------------------------------------------------------ montos
  function plata(n, moneda = 'ARS') {
    const entero = Math.abs(n - Math.round(n)) < 0.005;
    return `${n < 0 ? '-' : ''}${moneda === 'USD' ? 'US$' : '$'} ${(entero ? nf0 : nf2).format(Math.abs(n))}`;
  }

  /** Deja el texto del monto en formato argentino: 12500,5 → 12.500,5 */
  function formatearMonto(texto) {
    let s = String(texto).replace(/[^\d,]/g, '');
    const coma = s.indexOf(',');
    let entero = coma < 0 ? s : s.slice(0, coma);
    const decimales = coma < 0 ? null : s.slice(coma + 1).replace(/,/g, '').slice(0, 2);
    entero = entero.replace(/^0+(?=\d)/, '').slice(0, 11).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return decimales === null ? entero : `${entero || '0'},${decimales}`;
  }

  function leerMonto(texto) {
    const limpio = String(texto).replace(/\./g, '').replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(limpio)) return null;
    const n = Math.round(Number(limpio) * 100) / 100;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /** Texto pegado: "12.500,50", "12500.50" o "12.500" → formato argentino. */
  function normalizarPegado(texto) {
    const t = String(texto).trim().replace(/[^\d.,]/g, '');
    if (t.includes(',')) return formatearMonto(t.replace(/\./g, ''));
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) return formatearMonto(t.replace(/\./g, ''));
    return formatearMonto(t.replace('.', ','));
  }

  // ------------------------------------------------------------- formulario
  const form = $('form');
  const campoMonto = $('monto');
  let moneda = 'ARS';
  let cuotasLibres = false;

  const valor = (nombre) => (form.querySelector(`input[name="${nombre}"]:checked`) || {}).value || '';

  function chip(nombre, id, texto, marcado) {
    const etiqueta = document.createElement('label');
    etiqueta.className = 'chip';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = nombre;
    input.value = id;
    input.checked = Boolean(marcado);
    const span = document.createElement('span');
    span.textContent = texto;
    etiqueta.append(input, span);
    return etiqueta;
  }

  function medioElegido() {
    return ((catalogo && catalogo.medios) || []).find((m) => m.id === valor('medio')) || null;
  }

  function pintarCategorias(mostrarTodas = false) {
    const tipo = valor('tipo');
    const caja = $('chips-categoria');
    const elegida = valor('categoria');
    caja.textContent = '';
    if (!catalogo) return;
    const frecuentes = (estado && estado.frecuentes && estado.frecuentes.categorias) || [];
    const lista = catalogo.categorias.filter((c) => (c.tipo || 'gasto') === tipo);
    lista.sort((a, b) => {
      const ia = frecuentes.indexOf(a.id), ib = frecuentes.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    const tope = 6;
    const visibles = mostrarTodas || lista.length <= tope + 1
      ? lista
      : lista.filter((c, i) => i < tope || c.id === elegida);
    visibles.forEach((c) => caja.append(chip('categoria', c.id, `${c.emoji || ''} ${c.nombre}`.trim(), c.id === elegida)));
    if (visibles.length < lista.length) {
      const mas = document.createElement('button');
      mas.type = 'button';
      mas.className = 'chip-boton';
      mas.textContent = `Ver las ${lista.length}`;
      mas.addEventListener('click', () => pintarCategorias(true));
      caja.append(mas);
    }
  }

  function pintarMedios() {
    const caja = $('chips-medio');
    const elegido = valor('medio') || guardado.leer('ultimoMedio', '');
    caja.textContent = '';
    if (!catalogo) return;
    const frecuentes = (estado && estado.frecuentes && estado.frecuentes.medios) || [];
    const lista = catalogo.medios.filter((m) => m.activo !== false);
    lista.sort((a, b) => {
      const ia = frecuentes.indexOf(a.id), ib = frecuentes.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    lista.forEach((m) => caja.append(chip('medio', m.id, m.nombre || m.id, m.id === elegido)));
  }

  function pintarMetas() {
    const caja = $('chips-meta');
    caja.textContent = '';
    ((catalogo && catalogo.metas) || []).forEach((m, i, todas) => {
      caja.append(chip('meta', m.id, m.nombre || m.id, todas.length === 1));
    });
  }

  function pintarCuotas() {
    const caja = $('chips-cuotas');
    const elegida = valor('cuotas') || '1';
    caja.textContent = '';
    [1, 3, 6, 12, 18].forEach((n) => {
      caja.append(chip('cuotas', String(n), n === 1 ? '1 pago' : String(n), !cuotasLibres && String(n) === elegida));
    });
    if (cuotasLibres) {
      const numero = document.createElement('input');
      numero.type = 'number';
      numero.id = 'cuotas-libres';
      numero.className = 'chip-numero';
      numero.min = '2';
      numero.max = '60';
      numero.inputMode = 'numeric';
      numero.placeholder = 'Cuántas';
      numero.setAttribute('aria-label', 'Cantidad de cuotas');
      numero.addEventListener('input', pintarAyudaCuotas);
      caja.append(numero);
      numero.focus();
    } else {
      const otra = document.createElement('button');
      otra.type = 'button';
      otra.className = 'chip-boton';
      otra.textContent = 'Otra';
      otra.addEventListener('click', () => { cuotasLibres = true; pintarCuotas(); });
      caja.append(otra);
    }
  }

  function cuotasElegidas() {
    const medio = medioElegido();
    if (valor('tipo') !== 'gasto' || !medio || medio.tipo !== 'credito') return 1;
    if (cuotasLibres) {
      const n = Number(($('cuotas-libres') || {}).value);
      return Number.isInteger(n) && n >= 1 && n <= 60 ? n : null;
    }
    return Number(valor('cuotas') || 1);
  }

  function pintarAyudaCuotas() {
    const ayuda = $('ayuda-cuotas');
    const n = cuotasElegidas();
    const monto = leerMonto(campoMonto.value);
    if (n && n > 1 && monto) {
      ayuda.textContent = `${n} cuotas de ${plata(Math.round(monto / n * 100) / 100, moneda)}`;
      ayuda.hidden = false;
    } else {
      ayuda.hidden = true;
    }
  }

  function acomodarFormulario() {
    const tipo = valor('tipo');
    const medio = medioElegido();
    $('grupo-categoria').hidden = tipo === 'ahorro';
    $('grupo-meta').hidden = !(tipo === 'ahorro' && catalogo && (catalogo.metas || []).length);
    $('grupo-medio').hidden = tipo !== 'gasto';
    const conCuotas = tipo === 'gasto' && medio && medio.tipo === 'credito';
    $('grupo-cuotas').hidden = !conCuotas;
    $('guardar').textContent = `Guardar ${tipo}`;
    $('descripcion').placeholder = { gasto: 'Coto, almuerzo, nafta…', ingreso: 'Sueldo, venta, reintegro…', ahorro: 'Aporte del mes…' }[tipo];
    pintarAyudaCuotas();
  }

  function pintarFormulario() {
    pintarCategorias();
    pintarMedios();
    pintarMetas();
    pintarCuotas();
    acomodarFormulario();
  }

  function mostrarError(id, texto) {
    const el = $(id);
    el.textContent = texto || '';
    el.hidden = !texto;
  }

  function fechaElegida() {
    const cuando = valor('cuando');
    const hoy = new Date();
    if (cuando === 'ayer') { hoy.setDate(hoy.getDate() - 1); return fechaLocal(hoy); }
    if (cuando === 'otra') return $('fecha').value || null;
    return fechaLocal(hoy);
  }

  function nuevoId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  async function alGuardar(evento) {
    evento.preventDefault();
    mostrarError('error-monto', '');
    mostrarError('error-medio', '');
    const tipo = valor('tipo');
    const monto = leerMonto(campoMonto.value);
    if (!monto) { mostrarError('error-monto', 'Escribí el monto.'); campoMonto.focus(); return; }
    const medio = medioElegido();
    if (tipo === 'gasto' && !medio) { mostrarError('error-medio', 'Elegí con qué lo pagaste.'); return; }
    const cuotas = cuotasElegidas();
    if (!cuotas) { mostrarError('error-medio', 'Las cuotas van de 1 a 60.'); return; }
    const fecha = fechaElegida();
    if (!fecha) { mostrarError('error-monto', 'Elegí la fecha.'); return; }
    if (fecha > fechaLocal(new Date())) { mostrarError('error-monto', 'La fecha no puede ser futura.'); return; }

    const ahora = new Date();
    const dato = { v: 1, id: nuevoId(), creado: isoLocal(ahora), fecha, tipo, monto, moneda, cuotas };
    const descripcion = $('descripcion').value.trim().replace(/\s+/g, ' ');
    if (descripcion) dato.descripcion = descripcion;
    if (tipo !== 'ahorro' && valor('categoria')) dato.categoria = valor('categoria');
    if (tipo === 'gasto') dato.medio = medio.id;
    if (tipo === 'ahorro' && valor('meta')) dato.meta = valor('meta');

    const sello = ahora.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const item = { archivo: `${sello}-${dato.id.replace(/-/g, '').slice(0, 8)}.json`, dato };
    cola.push(item);
    guardado.escribir('cola', cola);

    const categoria = (catalogo.categorias.find((c) => c.id === dato.categoria) || {}).nombre;
    historial.unshift({
      id: dato.id, creado: dato.creado, fecha, tipo, monto, moneda, cuotas,
      texto: descripcion || categoria || { gasto: 'Gasto', ingreso: 'Ingreso', ahorro: 'Ahorro' }[tipo],
      detalle: [categoria && descripcion ? categoria : '', medio && tipo === 'gasto' ? medio.nombre : ''].filter(Boolean).join(', '),
      enviado: false,
    });
    historial = historial.slice(0, 12);
    guardado.escribir('historial', historial);
    if (tipo === 'gasto') guardado.escribir('ultimoMedio', medio.id);

    // Dejar el formulario listo para la próxima carga: solo se conserva el medio de pago.
    campoMonto.value = '';
    $('descripcion').value = '';
    form.querySelectorAll('input[name="categoria"]').forEach((i) => { i.checked = false; });
    form.querySelector('input[name="cuando"][value="hoy"]').checked = true;   // la fecha vuelve a hoy: evita cargar con un día viejo sin querer
    $('fecha').hidden = true;
    cuotasLibres = false;
    pintarCuotas();
    acomodarFormulario();
    pintarRecientes();
    form.classList.remove('guardado');
    void form.offsetWidth;
    form.classList.add('guardado');

    $('guardar').disabled = true;
    const resultado = await vaciarCola();
    $('guardar').disabled = false;
    if (resultado.ok) {
      avisar(`Guardado: ${plata(monto, moneda)}`);
      setTimeout(refrescarEstado, 75000);   // la automatización tarda cerca de un minuto
    } else if (resultado.error instanceof ErrorApi) {
      avisar(`Quedó en este teléfono sin enviar. ${explicar(resultado.error)}`, true, 7000);
    } else {
      avisar('Sin conexión. Quedó en cola y se envía sola cuando vuelva la señal.', false, 5000);
    }
  }

  // -------------------------------------------------------------------- cola
  async function vaciarCola() {
    if (enviando) return { ok: false, error: null };
    if (!cfg || !cola.length) return { ok: true };
    enviando = true;
    try {
      while (cola.length) {
        const item = cola[0];
        const r = await gh('contents/inbox/' + item.archivo, {
          method: 'PUT',
          body: {
            message: `App: ${item.dato.tipo} del ${item.dato.fecha}`,
            content: base64(JSON.stringify(item.dato, null, 1) + '\n'),
          },
        });
        // 422: ese archivo ya existe, o sea que un intento anterior sí había llegado.
        if (!(r.status === 201 || r.status === 200 || r.status === 422)) throw new ErrorApi(r.status);
        cola.shift();
        guardado.escribir('cola', cola);
        const h = historial.find((x) => x.id === item.dato.id);
        if (h) h.enviado = true;
        guardado.escribir('historial', historial);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    } finally {
      enviando = false;
      pintarRecientes();
      pintarAjustes();
    }
  }

  // ------------------------------------------------------------ lo que se ve
  function pintarRecientes() {
    const lista = $('lista-recientes');
    lista.textContent = '';
    $('recientes').hidden = !historial.length;
    historial.forEach((h) => {
      const li = document.createElement('li');
      const desc = document.createElement('span');
      desc.className = 'rec-desc';
      desc.textContent = h.texto;
      const monto = document.createElement('span');
      monto.className = 'rec-monto';
      monto.textContent = (h.tipo === 'gasto' ? '' : '+ ') + plata(h.monto, h.moneda);
      const pie = document.createElement('span');
      pie.className = 'rec-pie' + (h.enviado ? '' : ' en-cola');
      const partes = [fechaCorta(h.fecha)];
      if (h.detalle) partes.push(h.detalle);
      if (h.cuotas > 1) partes.push(`${h.cuotas} cuotas`);
      pie.textContent = (h.enviado ? '' : 'En cola, sin enviar. ') + partes.join(', ');
      li.append(desc, monto, pie);
      lista.append(li);
    });
  }

  function mostrarTira() {
    $('tira').hidden = !(cfg && estado) || $('vista-cargar').hidden;
  }

  function pintarTira() {
    mostrarTira();
    if (!cfg || !estado) return;
    const pie = $('tira-pie');
    const medidor = $('tira-medidor');
    pie.className = 'tira-pie';
    if (estado.error) {
      $('tira-mes').textContent = 'Hay un problema';
      $('tira-monto').textContent = '';
      medidor.hidden = true;
      pie.textContent = estado.error;
      pie.classList.add('critico');
      return;
    }
    const mes = String(estado.mes_nombre || '').split(' ')[0];
    $('tira-mes').textContent = mes.charAt(0).toUpperCase() + mes.slice(1);
    const gastado = Number(estado.gastado || 0);
    const frases = [];
    if (estado.tope) {
      $('tira-monto').textContent = `${plata(Math.round(gastado))} de ${plata(Math.round(estado.tope))}`;
      const pct = Number(estado.pct || 0);
      medidor.hidden = false;
      medidor.className = 'tira-medidor' + (pct >= 100 ? ' critico' : pct >= 80 ? ' aviso' : '');
      $('tira-barra').style.width = Math.min(pct, 100) + '%';
      if (estado.restante >= 0) {
        const dias = estado.dias_restantes;
        frases.push(`Quedan ${plata(Math.round(estado.restante))}` + (dias > 0 ? ` para ${dias} día${dias === 1 ? '' : 's'}.` : '.'));
      } else {
        frases.push(`Te pasaste por ${plata(Math.round(-estado.restante))}.`);
        pie.classList.add('critico');
      }
    } else {
      $('tira-monto').textContent = `${plata(Math.round(gastado))} gastados`;
      medidor.hidden = true;
    }
    // Una carga "espera entrar" si es posterior al último tablero y todavía no figura en él.
    const corte = Date.parse(estado.generado || '') || 0;
    const procesados = new Set((estado.ultimos || []).map((u) => u.id));
    const idEnLibro = (id) => 'a' + String(id).toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 11);
    const sinProcesar = historial.filter((h) => Date.parse(h.creado) > corte && !procesados.has(idEnLibro(h.id))).length;
    if (sinProcesar) {
      frases.push(sinProcesar === 1 ? 'Hay 1 carga tuya esperando entrar.' : `Hay ${sinProcesar} cargas tuyas esperando entrar.`);
    }
    pie.textContent = frases.join(' ');
    const avisos = (estado.alertas || []).filter((a) => a.nivel !== 'info').length;
    $('punto-aviso').hidden = !(avisos || (estado.pendientes && estado.pendientes.errores));
  }

  function pintarAjustes() {
    const conectado = Boolean(cfg);
    $('bienvenida').hidden = conectado;
    $('form-ajustes').hidden = conectado;
    $('conectado').hidden = !conectado;
    $('pestanas').hidden = !conectado;
    $('version').textContent = `Versión ${VERSION}`;
    if (conectado) {
      const partes = [`Guardando en ${cfg.repo}.`];
      if (cola.length) partes.push(cola.length === 1 ? 'Hay 1 carga en cola.' : `Hay ${cola.length} cargas en cola.`);
      $('conectado-detalle').textContent = partes.join(' ');
      $('reintentar').hidden = !cola.length;
    }
  }

  let relojAviso = null;
  function avisar(texto, mal = false, ms = 2600) {
    const el = $('aviso');
    el.textContent = texto;
    el.className = 'aviso ver' + (mal ? ' mal' : '');
    clearTimeout(relojAviso);
    relojAviso = setTimeout(() => { el.className = 'aviso' + (mal ? ' mal' : ''); }, ms);
  }

  function irA(vista) {
    ['cargar', 'tablero', 'ajustes'].forEach((v) => { $('vista-' + v).hidden = v !== vista; });
    document.querySelectorAll('#pestanas button').forEach((b) => {
      if (b.dataset.vista === vista) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    mostrarTira();
    if (vista === 'tablero') abrirTablero();
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------ sincronizar
  async function traerCatalogo(opciones = {}) {
    const [categorias, cuentas, metas] = await Promise.all([
      leerArchivo('config/categorias.json', opciones),
      leerArchivo('config/cuentas.json', opciones),
      leerArchivo('config/metas.json', opciones),
    ]);
    if (!categorias || !cuentas) {
      throw new Error('Ese repositorio no parece ser el de finanzas: no encuentro config/categorias.json.');
    }
    return {
      categorias: JSON.parse(categorias).categorias || [],
      medios: JSON.parse(cuentas).medios || [],
      metas: metas ? JSON.parse(metas).metas || [] : [],
    };
  }

  async function refrescarEstado() {
    if (!cfg || !navigator.onLine) return;
    try {
      const texto = await leerArchivo('data/estado.json');
      if (texto) {
        estado = JSON.parse(texto);
        guardado.escribir('estado', estado);
        pintarTira();
      }
    } catch { /* se reintenta la próxima vez */ }
  }

  async function refrescarCatalogo(conAviso = false) {
    if (!cfg) return;
    try {
      catalogo = await traerCatalogo();
      guardado.escribir('catalogo', catalogo);
      pintarFormulario();
      if (conAviso) avisar('Categorías y medios de pago actualizados.');
    } catch (error) {
      if (conAviso) avisar(error instanceof ErrorApi || error instanceof TypeError ? explicar(error) : error.message, true, 6000);
    }
  }

  // El tablero se muestra entero, del alto de su contenido, y la página se desplaza como cualquier
  // otra. Un recuadro con desplazamiento propio en el teléfono parece que termina donde corta.
  let observadorMarco = null;
  function ajustarMarco() {
    const marco = $('marco');
    const doc = marco.contentDocument;
    if (!doc || !doc.body || marco.hidden) return;
    const alto = Math.ceil(doc.documentElement.getBoundingClientRect().height);
    if (alto > 0) marco.style.height = `${alto}px`;
  }
  function vigilarMarco() {
    const doc = $('marco').contentDocument;
    if (!doc || !doc.body) return;
    if (observadorMarco) observadorMarco.disconnect();
    if ('ResizeObserver' in window) {
      observadorMarco = new ResizeObserver(ajustarMarco);
      observadorMarco.observe(doc.documentElement);
      observadorMarco.observe(doc.body);
    }
    doc.addEventListener('toggle', ajustarMarco, true);   // los "Ver tabla" cambian el alto
    ajustarMarco();
  }

  async function abrirTablero(forzar = false) {
    const marco = $('marco');
    const enCache = guardado.leer('tablero', null);
    if (enCache && !marco.srcdoc) marco.srcdoc = enCache;
    const rotulo = () => {
      if (!estado || !estado.generado) return '';
      const d = new Date(estado.generado);
      return `Actualizado el ${d.getDate()}/${d.getMonth() + 1} a las ${dosDigitos(d.getHours())}:${dosDigitos(d.getMinutes())}`;
    };
    $('tablero-estado').textContent = rotulo();
    $('tablero-vacio').hidden = Boolean(enCache);
    marco.hidden = !enCache;
    ajustarMarco();
    if (!navigator.onLine) {
      if (forzar) avisar('Sin conexión: te muestro el último tablero guardado.');
      return;
    }
    try {
      const html = await leerArchivo('reportes/tablero.html');
      await refrescarEstado();
      if (html) {
        if (html !== marco.srcdoc) marco.srcdoc = html;
        guardado.escribir('tablero', html);
        marco.hidden = false;
        $('tablero-vacio').hidden = true;
      }
      $('tablero-estado').textContent = rotulo();
      if (forzar) avisar('Tablero al día.');
    } catch (error) {
      if (forzar) avisar(explicar(error), true, 6000);
    }
  }

  async function alConectar(evento) {
    evento.preventDefault();
    mostrarError('error-ajustes', '');
    const repo = $('repo').value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
    const token = $('token').value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { mostrarError('error-ajustes', 'Escribí el repositorio como usuario/nombre.'); return; }
    if (token.length < 20) { mostrarError('error-ajustes', 'Pegá la llave de acceso completa.'); return; }
    const boton = $('conectar');
    boton.disabled = true;
    boton.textContent = 'Conectando…';
    try {
      const r = await gh('', { repo, token });
      if (!r.ok) throw new ErrorApi(r.status);
      const info = await r.json();
      if (info.private === false) {
        throw new Error('Ese repositorio es público. Tus datos tienen que estar en uno privado: no conecto la app ahí.');
      }
      catalogo = await traerCatalogo({ repo, token });
      cfg = { repo, token };
      guardado.escribir('cfg', cfg);
      guardado.escribir('catalogo', catalogo);
      $('token').value = '';
      pintarAjustes();
      pintarFormulario();
      irA('cargar');
      avisar('Listo. Ya podés cargar.');
      refrescarEstado();
    } catch (error) {
      const texto = error instanceof ErrorApi ? explicar(error)
        : error instanceof TypeError || error.name === 'AbortError' ? 'Sin conexión. Probá de nuevo.' : error.message;
      mostrarError('error-ajustes', texto);
    } finally {
      boton.disabled = false;
      boton.textContent = 'Conectar';
    }
  }

  function desconectar() {
    const aviso = cola.length
      ? `Hay ${cola.length} carga(s) sin enviar que se van a perder. ¿Desconectar igual?`
      : 'Se borra la llave de este teléfono. Tus datos en GitHub no se tocan. ¿Desconectar?';
    if (!window.confirm(aviso)) return;
    guardado.borrarTodo();
    cfg = null; catalogo = null; estado = null; cola = []; historial = [];
    $('marco').removeAttribute('srcdoc');
    pintarAjustes();
    pintarRecientes();
    irA('ajustes');
  }

  // ---------------------------------------------------------------- eventos
  form.addEventListener('submit', alGuardar);
  form.addEventListener('change', (e) => {
    if (e.target.name === 'tipo') { pintarCategorias(); acomodarFormulario(); }
    if (e.target.name === 'medio') { mostrarError('error-medio', ''); acomodarFormulario(); }
    if (e.target.name === 'cuotas') pintarAyudaCuotas();
    if (e.target.name === 'cuando') {
      const otra = e.target.value === 'otra';
      $('fecha').hidden = !otra;
      if (otra) {
        $('fecha').max = fechaLocal(new Date());
        if (!$('fecha').value) $('fecha').value = fechaLocal(new Date());
      }
    }
  });
  campoMonto.addEventListener('beforeinput', (e) => {
    // Algunos teclados numéricos traen punto en vez de coma: acá el punto es la coma decimal.
    if (e.inputType === 'insertText' && e.data === '.') {
      e.preventDefault();
      if (!campoMonto.value.includes(',')) {
        campoMonto.value = formatearMonto(campoMonto.value + ',');
        pintarAyudaCuotas();
      }
    }
  });
  campoMonto.addEventListener('paste', (e) => {
    e.preventDefault();
    campoMonto.value = normalizarPegado((e.clipboardData || window.clipboardData).getData('text'));
    pintarAyudaCuotas();
  });
  campoMonto.addEventListener('input', () => {
    campoMonto.value = formatearMonto(campoMonto.value);
    mostrarError('error-monto', '');
    pintarAyudaCuotas();
  });
  $('moneda').addEventListener('click', () => {
    moneda = moneda === 'ARS' ? 'USD' : 'ARS';
    $('moneda').textContent = moneda === 'ARS' ? '$' : 'US$';
    $('moneda').setAttribute('aria-label', `Cambiar moneda. Ahora: ${moneda === 'ARS' ? 'pesos' : 'dólares'}`);
    pintarAyudaCuotas();
  });
  $('form-ajustes').addEventListener('submit', alConectar);
  $('desconectar').addEventListener('click', desconectar);
  $('sincronizar').addEventListener('click', () => refrescarCatalogo(true));
  $('reintentar').addEventListener('click', async () => {
    const r = await vaciarCola();
    avisar(r.ok ? 'Enviado todo lo que estaba en cola.' : explicar(r.error), !r.ok, 5000);
  });
  $('tablero-actualizar').addEventListener('click', () => abrirTablero(true));
  $('marco').addEventListener('load', vigilarMarco);
  window.addEventListener('resize', ajustarMarco);
  $('tira-boton').addEventListener('click', () => irA('tablero'));
  document.querySelectorAll('#pestanas button').forEach((b) => b.addEventListener('click', () => irA(b.dataset.vista)));
  window.addEventListener('online', () => { vaciarCola(); refrescarEstado(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { vaciarCola(); refrescarEstado(); }
  });

  // ----------------------------------------------------------------- inicio
  pintarAjustes();
  pintarRecientes();
  if (cfg && catalogo) {
    pintarFormulario();
    pintarTira();
    irA('cargar');
    vaciarCola();
    refrescarEstado();
    refrescarCatalogo();
  } else {
    irA('ajustes');
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* la app funciona igual sin él */ });
  }
})();
