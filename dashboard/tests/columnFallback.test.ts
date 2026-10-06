// dashboard/tests/columnFallback.test.ts
import { withColumnFallback } from '../src/columnFallback.js';
import { buildSignalsQuery, type ColumnTier } from '../src/query.js';

/** A D1 stand-in that rejects any SELECT naming a column it does not have yet. */
function fakeDb(columns: string[]) {
  const seen: ColumnTier[] = [];
  const attempt = async (tier: ColumnTier): Promise<string[]> => {
    seen.push(tier);
    const sql = buildSignalsQuery({}, tier).sql;
    for (const optional of ['wr14', 'avwap_ath_pct']) {
      if (sql.includes(optional) && !columns.includes(optional)) {
        throw new Error(`D1_ERROR: no such column: ${optional}`);
      }
    }
    return [sql];
  };
  return { attempt, seen };
}

describe('withColumnFallback', () => {
  it('takes the full tier when D1 has every column', async () => {
    const db = fakeDb(['wr14', 'avwap_ath_pct']);
    const [sql] = await withColumnFallback(db.attempt);
    expect(db.seen).toEqual(['full']);
    expect(sql).toContain('avwap_ath_pct');
  });

  it('drops only avwap_ath_pct when D1 has migration 0004 but not 0005 (the deploy-before-ingest case)', async () => {
    const db = fakeDb(['wr14']);
    const [sql] = await withColumnFallback(db.attempt);
    expect(db.seen).toEqual(['full', 'noAvwap']);
    expect(sql).toContain(',wr14,');
    expect(sql).not.toContain('avwap_ath_pct');
  });

  it('falls all the way to legacy on an old database', async () => {
    const db = fakeDb([]);
    const [sql] = await withColumnFallback(db.attempt);
    expect(db.seen).toEqual(['full', 'noAvwap', 'legacy']);
    expect(sql).not.toContain('wr14');
  });

  it('rethrows the last error when even the legacy select fails (a real outage, not a missing column)', async () => {
    const attempt = jest.fn(async () => { throw new Error('D1 unavailable'); });
    await expect(withColumnFallback(attempt)).rejects.toThrow('D1 unavailable');
    expect(attempt).toHaveBeenCalledTimes(3);
  });
});
