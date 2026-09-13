const D = require('better-sqlite3');
const db = new D(':memory:');
const out = [];
const t = (n, fn) => { try { out.push(['PASS', n, fn() ?? '']); } catch (e) { out.push(['FAIL', n, e.message]); } };

t("contentless + contentless_delete=1 (content='' AND flag)", () => {
  db.exec("CREATE VIRTUAL TABLE f2 USING fts5(title, overview, content='', contentless_delete=1)");
  db.prepare("INSERT INTO f2(rowid,title,overview) VALUES (1,'blade runner','replicants')").run();
  db.prepare("DELETE FROM f2 WHERE rowid=1").run();
  db.prepare("INSERT INTO f2(rowid,title,overview) VALUES (1,'blade runner 2049','k')").run();
  return 'delete+reinsert works → ' + db.prepare("SELECT title FROM f2 WHERE f2 MATCH '2049'").get().title;
});

t('UPDATE on contentless_delete table', () => {
  try { db.prepare("UPDATE f2 SET title='x' WHERE rowid=1").run(); return 'UPDATE allowed'; }
  catch (e) { return 'UPDATE rejected (' + e.message + ') → use DELETE+INSERT'; }
});

t('can we read columns back out of a contentless table?', () => {
  try { return 'title=' + db.prepare("SELECT title FROM f2 WHERE rowid=1").get().title; }
  catch (e) { return 'NO: ' + e.message; }
});

t('bm25 with 7 column weights', () => {
  db.exec("CREATE VIRTUAL TABLE f4 USING fts5(title,overview,artist,album,series_title,genres,custom,content='',contentless_delete=1)");
  const ins = db.prepare("INSERT INTO f4(rowid,title,overview,artist,album,series_title,genres,custom) VALUES (?,?,?,?,?,?,?,?)");
  ins.run(1, 'Alien', 'in space no one can hear you scream', '', '', '', 'horror,scifi', '');
  ins.run(2, 'Prometheus', 'an alien origin story', '', '', '', 'scifi', '');
  const rows = db.prepare("SELECT rowid, bm25(f4,10.0,2.0,6.0,4.0,6.0,1.0,1.0) s FROM f4 WHERE f4 MATCH 'alien' ORDER BY s").all();
  return 'order=' + rows.map(r => r.rowid).join(',') + ' → title match ranks first: ' + (rows[0].rowid === 1);
});

t('prefix query (typeahead)', () => 'hits=' + db.prepare("SELECT rowid FROM f4 WHERE f4 MATCH ? ORDER BY rank").all('"prome"*').length);

t('user input containing FTS operators is safely quoted', () => {
  const quote = s => '"' + s.replace(/"/g, '""') + '"';
  const r = db.prepare("SELECT rowid FROM f4 WHERE f4 MATCH ?").all(quote('alien OR (NEAR "x'));
  return 'no syntax error, hits=' + r.length;
});

t('unquoted user input DOES break (why quoting is mandatory)', () => {
  try { db.prepare("SELECT rowid FROM f4 WHERE f4 MATCH ?").all('alien OR (NEAR'); return 'no error — surprising'; }
  catch (e) { return 'throws as expected: ' + e.message.slice(0, 60); }
});

t('50k-row contentless FTS: build + query latency', () => {
  const d3 = new D(':memory:');
  d3.exec("CREATE VIRTUAL TABLE big USING fts5(title,overview,content='',contentless_delete=1)");
  const ins = d3.prepare("INSERT INTO big(rowid,title,overview) VALUES (?,?,?)");
  const w = ['alien','blade','runner','matrix','godfather','dune','arrival','solaris','stalker','akira'];
  const tx = d3.transaction(() => { for (let i = 0; i < 50000; i++) ins.run(i+1, w[i%10]+' '+i, 'a synopsis about '+w[(i*7)%10]+' and things'); });
  const t0 = Date.now(); tx(); const build = Date.now() - t0;
  const t1 = Date.now();
  const rows = d3.prepare("SELECT rowid FROM big WHERE big MATCH ? ORDER BY bm25(big,10.0,1.0) LIMIT 50").all('"alien"*');
  const q = Date.now() - t1;
  const t2 = Date.now();
  for (let i = 1; i <= 200; i++) { d3.prepare("DELETE FROM big WHERE rowid=?").run(i); ins.run(i, 'updated '+i, 'x'); }
  const re = Date.now() - t2;
  return `insert 50k=${build}ms · query=${q}ms (${rows.length} hits) · 200 single-row reindexes=${re}ms`;
});

t('external-content 50k: same query for comparison', () => {
  const d4 = new D(':memory:');
  d4.exec(`CREATE TABLE media(id INTEGER PRIMARY KEY, title TEXT, overview TEXT);
           CREATE VIRTUAL TABLE big2 USING fts5(title,overview,content='media',content_rowid='id');`);
  const ins = d4.prepare("INSERT INTO media VALUES (?,?,?)");
  const w = ['alien','blade','runner','matrix','godfather','dune','arrival','solaris','stalker','akira'];
  const tx = d4.transaction(() => { for (let i = 0; i < 50000; i++) ins.run(i+1, w[i%10]+' '+i, 'about '+w[(i*7)%10]); });
  const t0 = Date.now(); tx(); d4.exec("INSERT INTO big2(big2) VALUES('rebuild')"); const build = Date.now()-t0;
  const t1 = Date.now();
  const rows = d4.prepare("SELECT m.id FROM big2 JOIN media m ON m.id=big2.rowid WHERE big2 MATCH ? ORDER BY bm25(big2,10.0,1.0) LIMIT 50").all('"alien"*');
  return `insert+rebuild 50k=${build}ms · join query=${Date.now()-t1}ms (${rows.length} hits)`;
});

const pad = Math.max(...out.map(r => r[1].length));
for (const [s, n, d] of out) console.log(`${s}  ${n.padEnd(pad)}  ${d}`);
console.log('\n' + out.filter(r => r[0] === 'FAIL').length + ' failures of ' + out.length);
