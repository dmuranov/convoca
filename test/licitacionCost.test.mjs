import test from 'node:test';
import assert from 'node:assert/strict';
import { complejidadFor, durationMonths } from '../src/ingest/complexity.js';
import { keySections } from '../src/ingest/keySections.js';

test('duration from the feed, in months', () => {
  assert.equal(durationMonths('2 años'), 24);
  assert.equal(durationMonths('18 meses'), 18);
  assert.equal(durationMonths('1 años'), 12);
  assert.ok(Math.abs(durationMonths('90 días') - 2.96) < 0.01);
  assert.equal(durationMonths(null), null);
  assert.equal(durationMonths('según pliego'), null);
});

test('complexity follows the rules, not a guess', () => {
  const c = (o) => complejidadFor({ procedimiento: 'Abierto', numLotes: 0, duracion: '12 meses', clasificacionExigida: false, ...o });
  assert.equal(c({ procedimiento: 'Abierto simplificado', duracion: '6 meses' }).complejidad, 'baja');
  assert.equal(c({ procedimiento: 'Abierto simplificado', duracion: null }).complejidad, 'baja');
  assert.equal(c({}).complejidad, 'media');
  assert.equal(c({ duracion: '2 años' }).complejidad, 'alta');            // the Almería canteen case
  assert.equal(c({ duracion: '1 años' }).complejidad, 'media');           // exactly 12 months is not "more than a year"
  assert.equal(c({ numLotes: 3 }).complejidad, 'alta');
  assert.equal(c({ numLotes: 1 }).complejidad, 'media');
  assert.equal(c({ procedimiento: 'Restringido' }).complejidad, 'alta');
  assert.equal(c({ procedimiento: 'Negociado sin publicidad' }).complejidad, 'alta');
  assert.equal(c({ procedimiento: 'Abierto simplificado', clasificacionExigida: true }).complejidad, 'alta');
  const all = c({ numLotes: 3, duracion: '2 años', clasificacionExigida: true });
  assert.equal(all.motivo, 'Alta porque exige clasificación empresarial, está dividida en 3 lotes y dura 2 años.');
  assert.match(c({ procedimiento: 'Abierto simplificado', duracion: '1 meses' }).motivo, /de 1 mes,/);
});

test('key sections: short text goes whole, long text is cut to the budget', () => {
  const short = '[PCAP.pdf]\nObjeto del contrato: limpieza.';
  assert.equal(keySections(short), short);
  assert.equal(keySections(null), null);

  const filler = 'Texto de relleno sin nada relevante para el resumen. '.repeat(40) + '\n';
  const pcap = '[PCAP.pdf]\nPLIEGO DE CLÁUSULAS ADMINISTRATIVAS\nObjeto del contrato: mantener jardines.\n'
    + 'ÍNDICE\n1.1.- OBJETO\n1.2.- SOLVENCIA ECONÓMICA\n1.3.- GARANTÍAS\n1.4.- SEGUROS\n1.5.- PLAZOS\n1.6.- LOTES\n'
    + filler.repeat(60)
    + 'La solvencia económica se acreditará con un volumen anual de negocios de 250.000 euros.\n'
    + filler.repeat(60);
  const ppt = '\n\n[PPT.pdf]\nPLIEGO DE PRESCRIPCIONES TÉCNICAS\n' + filler.repeat(60)
    + 'Los productos serán de la marca Agilent Technologies o equivalente.\n'
    + 'Documento firmado electrónicamente. Código Seguro de Verificación: ABC\n' + filler.repeat(60);
  const raw = pcap + ppt;
  const out = keySections(raw, 20_000);
  assert.ok(raw.length > 200_000 && out.length <= 20_000 + 200, `kept ${out.length}`);
  assert.match(out, /250\.000 euros/);                 // the real solvency passage, not the index line
  assert.match(out, /Agilent Technologies/);           // the technical document gets its share
  assert.match(out, /^\[PCAP\.pdf\]/);
  assert.match(out, /\[PPT\.pdf\]/);
  assert.doesNotMatch(out, /Código Seguro de Verificación/);
});
