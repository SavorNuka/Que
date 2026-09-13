const D = require('better-sqlite3');
const db = new D(':memory:');
const out = [];
const t = (name, fn) => { try { const r = fn(); out.push(['PASS', name, r ?? '']); } catch (e) { out.push(['FAIL', name, e.message]); } };

// 1. Plain contentless table: can we DELETE / UPDATE? (the doc assumes reindex(mediaId))
t('contentless FTS5 without contentless_delete: DELETE', () => {
  db.exec("CREATE VIRTUAL TABLE f1 USING fts5(title, content='')");
  db.prepare("INSERT INTO f1(rowid,title) VALUES (1,'blade runner')").run();
  db.prepare("DELETE FROM f1 WHERE rowid=1").run();
  return 'delete accepted';
});

// 2. contentless_delete=1 (SQLite >= 3.45)
t('contentless_delete=1 supported', () => {
  db.exec("CREATE VIRTUAL TABLE f2 USING fts5(title, overview, contentless_delete=1)");
  db.prepare("INSERT INTO f2(rowid,title,overview) VALUES (1,'blade runner','replicants')").run();
  db.prepare("DELETE FROM f2 WHERE rowid=1").run();
  db.prepare("INSERT INTO f2(rowid,title,overview) VALUES (1,'blade runner 2049','k')").run();
  return db.prepare("SELECT title FROM f2 WHERE f2 MATCH '2049'").get().title;
});

// 3. External-content table kept in sync by triggers (the alternative design)
t('external-content FTS5 + triggers', () => {
  db.exec(`
    CREATE TABLE media(id INTEGER PRIMARY KEY, title TEXT, overview TEXT);
    CREATE VIRTUAL TABLE f3 USING fts5(title, overview, content='media', content_rowid='id');
    CREATE TRIGGER media_ai AFTER INSERT ON media BEGIN
      INSERT INTO f3(rowid,title,overview) VALUES (new.id,new.title,new.overview); END;
    CREATE TRIGGER media_ad AFTER DELETE ON media BEGIN
      INSERT INTO f3(f3,rowid,title,overview) VALUES('delete',old.id,old.title,old.overview); END;
    CREATE TRIGGER media_au AFTER UPDATE ON media BEGIN
      INSERT INTO f3(f3,rowid,title,overview) VALUES('delete',old.id,old.title,old.overview);
      INSERT INTO f3(rowid,title,overview) VALUES (new.id,new.title,new.overview); END;
  `);
  db.prepare("INSERT INTO media VALUES (1,'Blade Runner','dystopian noir')").run();
  db.prepare("UPDATE media SET title='Blade Runner: Final Cut' WHERE id=1").run();
  const r = db.prepare("SELECT m.title FROM f3 JOIN media m ON m.id=f3.rowid WHERE f3 MATCH 'final' ").get();
  return r.title;
});

// 4. bm25 with per-column weights, 7 columns as specced
t('bm25 with 7 column weights', () => {
  db.exec("CREATE VIRTUAL TABLE f4 USING fts5(title,overview,artist,album,series_title,genres,custom,contentless_delete=1)");
  const ins = db.prepare("INSERT INTO f4(rowid,title,overview,artist,album,series_title,genres,custom) VALUES (?,?,?,?,?,?,?,?)");
  ins.run(1, 'Alien', 'in space no one can hear you scream', '', '', '', 'horror,scifi', '');
  ins.run(2, 'Prometheus', 'an alien origin story', '', '', '', 'scifi', '');
  const rows = db.prepare(
    "SELECT rowid, bm25(f4, 10.0,2.0,6.0,4.0,6.0,1.0,1.0) AS s FROM f4 WHERE f4 MATCH 'alien' ORDER BY s"
  ).all();
  return 'order=' + rows.map(r => r.rowid).join(',') + ' (title-match first)';
});

// 5. prefix query while typing
t('prefix query', () => {
  const r = db.prepare("SELECT rowid FROM f4 WHERE f4 MATCH ? ORDER BY rank").all('"prome"*');
  return 'hits=' + r.length;
});

// 6. quoting protects against FTS syntax injection from the search box
t('user input with FTS operators is safely quoted', () => {
  const quote = s => '"' + s.replace(/"/g, '""') + '"';
  const r = db.prepare("SELECT rowid FROM f4 WHERE f4 MATCH ?").all(quote('alien OR (NEAR'));
  return 'no syntax error, hits=' + r.length;
});

// 7. unicode61 + porter tokenizer combination used in the doc
t("tokenize='porter unicode61 remove_diacritics 2'", () => {
  db.exec("CREATE VIRTUAL TABLE f5 USING fts5(t, tokenize='porter unicode61 remove_diacritics 2')");
  db.prepare("INSERT INTO f5(rowid,t) VALUES (1,'Amélie running')").run();
  const a = db.prepare("SELECT count(*) c FROM f5 WHERE f5 MATCH 'amelie'").get().c;
  const b = db.prepare("SELECT count(*) c FROM f5 WHERE f5 MATCH 'run'").get().c;
  return `diacritic-folded=${a===1}, stemmed=${b===1}`;
});

// 8. keyset pagination with a stable secondary key
t('keyset pagination', () => {
  db.exec("CREATE TABLE m2(id INTEGER PRIMARY KEY, sort_title TEXT, year INT)");
  const i = db.prepare("INSERT INTO m2 VALUES (?,?,?)");
  [['Alien',1979],['Aliens',1986],['Alien 3',1992],['Alien',1979]].forEach((r,ix)=>i.run(ix+1,r[0],r[1]));
  const p1 = db.prepare("SELECT id,sort_title FROM m2 ORDER BY sort_title,id LIMIT 2").all();
  const last = p1[p1.length-1];
  const p2 = db.prepare("SELECT id,sort_title FROM m2 WHERE (sort_title,id) > (?,?) ORDER BY sort_title,id LIMIT 2").all(last.sort_title,last.id);
  return `page1=[${p1.map(r=>r.id)}] page2=[${p2.map(r=>r.id)}] no-overlap=${!p2.some(r=>p1.find(x=>x.id===r.id))}`;
});

// 9. row-value comparison support (needed by #8)
t('row-value tuple comparison', () => db.prepare("SELECT (1,2) > (1,1) AS r").get().r === 1 ? 'supported' : 'NOT supported');

// 10. recursive CTE for nested group trees (series -> season)
t('recursive CTE for group tree', () => {
  db.exec("CREATE TABLE groups(id INTEGER PRIMARY KEY, parent_id INT, name TEXT)");
  db.exec("INSERT INTO groups VALUES (1,NULL,'Breaking Bad'),(2,1,'Season 1'),(3,1,'Season 2'),(4,2,'Disc 1')");
  const r = db.prepare(`
    WITH RECURSIVE tree(id,name,depth) AS (
      SELECT id,name,0 FROM groups WHERE id=1
      UNION ALL SELECT g.id,g.name,t.depth+1 FROM groups g JOIN tree t ON g.parent_id=t.id
    ) SELECT count(*) c, max(depth) d FROM tree`).get();
  return `nodes=${r.c} maxdepth=${r.d}`;
});

// 11. partial unique index for dedupe_key (used by group derivation)
t('partial UNIQUE index on dedupe_key', () => {
  db.exec("CREATE TABLE g2(id INTEGER PRIMARY KEY, kind TEXT, type TEXT, dedupe_key TEXT)");
  db.exec("CREATE UNIQUE INDEX ix ON g2(kind,type,dedupe_key) WHERE dedupe_key IS NOT NULL");
  db.prepare("INSERT INTO g2 VALUES (1,'audio','album','a|b|1997')").run();
  db.prepare("INSERT INTO g2 VALUES (2,'audio','album',NULL)").run();
  db.prepare("INSERT INTO g2 VALUES (3,'audio','album',NULL)").run();
  let dup = false;
  try { db.prepare("INSERT INTO g2 VALUES (4,'audio','album','a|b|1997')").run(); } catch { dup = true; }
  return `multiple NULLs ok, duplicate key rejected=${dup}`;
});

// 12. fractional REAL positions for drag-reorder
t('fractional REAL position reorder', () => {
  db.exec("CREATE TABLE pi(pid INT, mid INT, pos REAL)");
  db.exec("INSERT INTO pi VALUES (1,10,1.0),(1,11,2.0),(1,12,3.0)");
  db.prepare("UPDATE pi SET pos=(1.0+2.0)/2 WHERE mid=12").run();
  return db.prepare("SELECT group_concat(mid) g FROM (SELECT mid FROM pi WHERE pid=1 ORDER BY pos)").get().g;
});

// 13. WAL + foreign_keys pragmas on a file db
t('WAL + foreign_keys on file db', () => {
  const f = require('path').join(require('os').tmpdir(), 'que-test-' + Date.now() + '.db');
  const d2 = new D(f);
  d2.pragma('journal_mode = WAL');
  d2.pragma('foreign_keys = ON');
  const jm = d2.pragma('journal_mode', { simple: true });
  const fk = d2.pragma('foreign_keys', { simple: true });
  d2.close(); require('fs').rmSync(f, { force: true });
  return `journal_mode=${jm} foreign_keys=${fk}`;
});

// 14. how fast is a realistic search over 50k rows?
t('50k-row FTS search latency', () => {
  const d3 = new D(':memory:');
  d3.exec("CREATE VIRTUAL TABLE big USING fts5(title,overview,contentless_delete=1)");
  const ins = d3.prepare("INSERT INTO big(rowid,title,overview) VALUES (?,?,?)");
  const words = ['alien','blade','runner','matrix','godfather','dune','arrival','solaris','stalker','akira'];
  const tx = d3.transaction(() => {
    for (let i = 0; i < 50000; i++)
      ins.run(i + 1, words[i % 10] + ' ' + i, 'a synopsis about ' + words[(i * 7) % 10] + ' and things');
  });
  const t0 = Date.now(); tx(); const build = Date.now() - t0;
  const t1 = Date.now();
  const rows = d3.prepare("SELECT rowid FROM big WHERE big MATCH ? ORDER BY bm25(big,10.0,1.0) LIMIT 50").all('"alien"*');
  const q = Date.now() - t1;
  return `insert 50k=${build}ms, query=${q}ms, hits=${rows.length}`;
});

const w = [Math.max(...out.map(r => r[1].length)), 0];
for (const [s, n, d] of out) console.log(`${s}  ${n.padEnd(w[0])}  ${d}`);
console.log('\n' + out.filter(r => r[0] === 'FAIL').length + ' failures of ' + out.length);
