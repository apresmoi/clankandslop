// List layers and field schemas in the local GADM 4.1 geodatabase so we
// know what to query against. Read-only — opens the .gdb in place.
import gdal from 'gdal-async';

const GDB = '/Users/apresmoi/Documents/clanknslop/gadm_410.gdb';

const ds = gdal.open(GDB);
console.log(`driver: ${ds.driver.description}`);
console.log(`layers: ${ds.layers.count()}`);
for (let i = 0; i < ds.layers.count(); i++) {
  const layer = ds.layers.get(i);
  const fields = layer.fields.getNames();
  let count;
  try { count = layer.features.count(); } catch { count = '?'; }
  console.log(`  [${i}] ${layer.name}  features=${count}  fields=[${fields.join(', ')}]`);
}

// Sample one feature from the country-level layer to see what's there.
const adm0 = ds.layers.get(0);
const firstFeat = adm0.features.first();
if (firstFeat) {
  console.log('\nsample feature (layer 0):');
  for (const name of adm0.fields.getNames()) {
    const v = firstFeat.fields.get(name);
    console.log(`  ${name}: ${typeof v === 'string' && v.length > 40 ? v.slice(0, 40) + '…' : v}`);
  }
  console.log(`  geometry.type: ${firstFeat.getGeometry()?.name}`);
}
