// ============================================================================
// Traducción de payloads técnicos a texto legible (BUG-003).
// Módulo puro y testeable: sin efectos, sin dependencias del provider ni de BD.
// El backend sigue usando el payload (`content`); el portal muestra el texto
// humano (`displayText`) que produce `textoVisibleDe`.
// ============================================================================

export const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

/** Mapa de payloads con texto fijo (menús, botones de navegación, etc.). */
export const PAYLOAD_A_TEXTO: Record<string, string> = {
  menu_1: 'Consultar extracto',
  menu_2: 'Certificados de retención',
  menu_3: 'Realizar PQR',
  menu_4: 'Hablar con un asesor',
  menu_5: 'Radicar factura',
  mes_0: 'Todo el año',
  mas_meses: 'Ver más meses',
  volver_menu: 'Volver al menú',
  continuar: 'Sí, soy yo',
  no_soy_yo: 'No soy yo',
  otra_si: 'Sí, gracias',
  otra_no: 'No, finalizar',
  agente: 'Hablar con un asesor',
  salir: 'Salir',
  rete_ica: 'Rete ICA',
  rete_fuente: 'Rete Fuente',
}

/**
 * Devuelve el texto que el usuario realmente vio/eligió para un mensaje entrante.
 * - Si el proveedor entrega el título visible (botón), se usa.
 * - Payloads conocidos → su etiqueta.
 * - mes_N → nombre del mes; anio_YYYY / ret_anio_YYYY → año.
 * - Texto libre → tal cual (ya es legible).
 */
export const textoVisibleDe = (bodyRaw: string, _tipo?: string, ctx?: any): string => {
  const titulo = ctx?.title ?? ctx?.titleButton ?? ctx?.list_title
  if (typeof titulo === 'string' && titulo.trim()) return titulo.trim()

  const v = (bodyRaw ?? '').trim()
  if (PAYLOAD_A_TEXTO[v]) return PAYLOAD_A_TEXTO[v]

  const mMes = /^mes_(\d{1,2})$/.exec(v)
  if (mMes) {
    const n = parseInt(mMes[1], 10)
    if (n === 0) return 'Todo el año'
    if (n >= 1 && n <= 12) return MESES[n - 1]
  }

  const mAnio = /^(?:ret_)?anio_(\d{4})$/.exec(v)
  if (mAnio) return mAnio[1]

  return v
}
