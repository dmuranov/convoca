// Build brief step 4: "Build the page, then read it yourself against ejn.gov.ba before
// generalizing." Writes the shared render (src/pages/municipalityPage.js) to a local file -
// the same HTML the live server route serves, so "read it yourself" and "what ships" are
// never two different things.
//
// Usage: node scripts/buildMunicipalityPage.js [CITY_NAME] [output path]
import { renderMunicipalityPage } from '../src/pages/municipalityPage.js';
import { writeFileSync } from 'node:fs';

const CITY_NAME = process.argv[2] || 'PRIJEDOR';
const OUT_PATH = process.argv[3] || `scratch-${CITY_NAME.toLowerCase()}.html`;

const html = renderMunicipalityPage(CITY_NAME);
if (!html) throw new Error(`no ejn_city row for "${CITY_NAME}" - run pullMunicipality.js first`);

writeFileSync(OUT_PATH, html, 'utf8');
console.log(`Wrote ${OUT_PATH}`);
