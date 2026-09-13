import type { GroupDetail, GroupScreen, GroupSummary, GroupType, MediaKind } from '@shared/types';
import type { Db } from '../connection';
import { groupClauses } from '../../restrictions';

interface Row {
  id: number;
  type: GroupType;
  kind: MediaKind;
  parent_id: number | null;
  name: string;
  display_name: string | null;
  year: number | null;
  favorite: number;
  origin: 'derived' | 'manual' | 'smart';
  user_rating: number | null;
  provider: string | null;
  provider_id: string | null;
  screen: string | null;
  item_count?: number;
}

/** Default screen for a group type — §12.4 layouts are shaped to the type. */
export function defaultScreen(type: GroupType): GroupScreen {
  const base: GroupScreen = {
    layout: 'grid',
    sortBy: 'position',
    sections: ['hero', 'summary', 'items'],
  };
  switch (type) {
    case 'saga':
    case 'collection':
      return { ...base, layout: 'poster-wall', sortBy: 'year', sections: ['hero', 'summary', 'items', 'stats'] };
    case 'artist':
      return { ...base, layout: 'shelf', sortBy: 'year', sections: ['hero', 'children', 'items'] };
    case 'album':
      return { ...base, layout: 'list', sortBy: 'track' };
    case 'series':
      return { ...base, layout: 'poster-wall', sortBy: 'position', sections: ['hero', 'summary', 'children'] };
    case 'season':
      return { ...base, layout: 'list', sortBy: 'episode' };
    default:
      return base;
  }
}

function parseScreen(raw: string | null, type: GroupType): GroupScreen {
  if (!raw) return defaultScreen(type);
  try {
    return { ...defaultScreen(type), ...(JSON.parse(raw) as Partial<GroupScreen>) };
  } catch {
    return defaultScreen(type);
  }
}

/** COALESCE(display_name, name) lives here and nowhere else (§12.2). */
export function label(r: { name: string; display_name: string | null }): string {
  return r.display_name ?? r.name;
}

function toSummary(r: Row): GroupSummary {
  return {
    id: r.id,
    type: r.type,
    kind: r.kind,
    parentId: r.parent_id,
    label: label(r),
    name: r.name,
    displayName: r.display_name,
    year: r.year,
    favorite: r.favorite === 1,
    origin: r.origin,
    itemCount: r.item_count ?? 0,
    userRating: r.user_rating,
  };
}

const SELECT_WITH_COUNT = `
  SELECT g.*, (SELECT count(*) FROM group_items gi WHERE gi.group_id = g.id) AS item_count
    FROM groups g
   WHERE g.deleted_at IS NULL`;

/** §23 — hidden groups vanish from listings and from direct lookup alike. */
function restriction(): { sql: string; params: unknown[] } {
  const clauses = groupClauses();
  return {
    sql: clauses.map((c) => ` AND (${c.sql})`).join(''),
    params: clauses.flatMap((c) => c.params),
  };
}

export function list(db: Db, kind: MediaKind | null, parentId: number | null): GroupSummary[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (kind) {
    conds.push('g.kind = ?');
    params.push(kind);
  }
  if (parentId === null) conds.push('g.parent_id IS NULL');
  else {
    conds.push('g.parent_id = ?');
    params.push(parentId);
  }
  const guard = restriction();
  const rows = db
    .prepare(
      `${SELECT_WITH_COUNT} ${conds.length ? `AND ${conds.join(' AND ')}` : ''}${guard.sql}
       ORDER BY g.favorite DESC, COALESCE(g.sort_name, g.display_name, g.name)`
    )
    .all(...params, ...guard.params) as Row[];
  return rows.map(toSummary);
}

export function get(db: Db, id: number): GroupDetail {
  const guard = restriction();
  const r = db
    .prepare(`${SELECT_WITH_COUNT} AND g.id = ?${guard.sql}`)
    .get(id, ...guard.params) as Row | undefined;
  if (!r) throw new Error(`No group with id ${id}`);
  const children = list(db, null, id);
  const fields = db.prepare('SELECT key, value FROM group_fields WHERE group_id = ?').all(id) as {
    key: string;
    value: string | null;
  }[];
  return {
    ...toSummary(r),
    screen: parseScreen(r.screen, r.type),
    provider: r.provider,
    providerId: r.provider_id,
    children,
    fields: Object.fromEntries(fields.map((f) => [f.key, f.value ?? ''])),
  };
}

/**
 * Writing a screen also mirrors screen.displayName into groups.display_name,
 * because derivation must never overwrite a user's label (§12.2).
 */
export function setScreen(db: Db, id: number, screen: GroupScreen): GroupDetail {
  db.transaction(() => {
    db.prepare('UPDATE groups SET screen = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(screen),
      Date.now(),
      id
    );
    if (screen.displayName !== undefined) {
      db.prepare('UPDATE groups SET display_name = ? WHERE id = ?').run(
        screen.displayName || null,
        id
      );
    }
  })();
  return get(db, id);
}

export function setFavorite(db: Db, id: number, favorite: boolean): GroupSummary {
  db.prepare('UPDATE groups SET favorite = ?, updated_at = ? WHERE id = ?').run(
    favorite ? 1 : 0,
    Date.now(),
    id
  );
  const r = db.prepare(`${SELECT_WITH_COUNT} AND g.id = ?`).get(id) as Row;
  return toSummary(r);
}
