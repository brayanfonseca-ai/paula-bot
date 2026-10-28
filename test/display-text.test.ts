// Tests de la traducción payload -> texto humano (BUG-003).
// Ejecutar: npm run test  (usa tsx + node:test, sin dependencias extra).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textoVisibleDe, PAYLOAD_A_TEXTO } from '../src/display-text'

test('CASO 6 — mes_0 se muestra como "Todo el año"', () => {
  assert.equal(textoVisibleDe('mes_0'), 'Todo el año')
})

test('CASO 6 — mes_9 se muestra como "Septiembre"', () => {
  assert.equal(textoVisibleDe('mes_9'), 'Septiembre')
})

test('mes_1..mes_12 mapean al nombre correcto', () => {
  assert.equal(textoVisibleDe('mes_1'), 'Enero')
  assert.equal(textoVisibleDe('mes_12'), 'Diciembre')
})

test('CASO 7 — menu_4 se muestra como "Hablar con un asesor"', () => {
  assert.equal(textoVisibleDe('menu_4'), 'Hablar con un asesor')
})

test('menú principal completo tiene etiqueta legible', () => {
  assert.equal(PAYLOAD_A_TEXTO['menu_1'], 'Consultar extracto')
  assert.equal(PAYLOAD_A_TEXTO['menu_5'], 'Radicar factura')
})

test('anio_2024 y ret_anio_2023 se muestran como el año', () => {
  assert.equal(textoVisibleDe('anio_2024'), '2024')
  assert.equal(textoVisibleDe('ret_anio_2023'), '2023')
})

test('el título del botón (title) tiene prioridad sobre el payload', () => {
  assert.equal(textoVisibleDe('menu_4', 'button', { title: 'Hablar con agente' }), 'Hablar con agente')
})

test('texto libre del usuario se conserva legible', () => {
  assert.equal(textoVisibleDe('Hola, necesito ayuda'), 'Hola, necesito ayuda')
})

test('no expone ids técnicos cuando hay texto humano', () => {
  for (const id of Object.keys(PAYLOAD_A_TEXTO)) {
    const out = textoVisibleDe(id)
    assert.notEqual(out, id, `El payload ${id} no debería mostrarse crudo`)
  }
})
