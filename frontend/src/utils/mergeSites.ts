import { db } from './db';
import type { BirdSite, SiteSnapshot } from '../types/bird-site';
import type { RingRecord } from '../types/ring-record';
import type { SurveySession } from '../types/session';
import type { Morphometrics } from '../types/morphometrics';

/** 并档预览：确认前列出的迁移清单与拦截原因 */
export interface MergePreview {
  keep: BirdSite;
  source: BirdSite;
  /** 待迁移的批次（全部应已关闭，否则 blocked 为 true） */
  sessions: SurveySession[];
  /** 待迁移的环志记录 */
  rings: RingRecord[];
  /** 待迁移环志关联的量度记录 */
  morphs: Morphometrics[];
  /** 待并点仍在进行中的批次（非空时拦截并档） */
  openSessions: SurveySession[];
  /** 是否允许确认并档 */
  blocked: boolean;
}

/** 并档结果计数（确认成功后回显） */
export interface MergeResult {
  sessionCount: number;
  ringCount: number;
  morphCount: number;
}

/** 固化原鸟点名称与坐标为历史快照 */
function snapshotOf(site: BirdSite): SiteSnapshot {
  return { siteNo: site.siteNo, name: site.name, lng: site.lng, lat: site.lat };
}

/**
 * 并档预览：统计待并点名下的批次、环志、量度数量；
 * 待并点存在进行中批次时 blocked = true，由入口先拦住。
 */
export async function previewMergeSites(keepId: string, sourceId: string): Promise<MergePreview> {
  if (!keepId || !sourceId) throw new Error('请先选择保留点与待并点');
  if (keepId === sourceId) throw new Error('保留点与待并点不能是同一个鸟点');

  const [keep, source, sessions, rings] = await Promise.all([
    db.sites.get(keepId),
    db.sites.get(sourceId),
    db.sessions.where('siteId').equals(sourceId).toArray(),
    db.rings.where('siteId').equals(sourceId).toArray(),
  ]);
  if (!keep) throw new Error('保留点不存在或已被删除');
  if (!source) throw new Error('待并点不存在或已被删除');

  const ringIds = new Set(rings.map((record) => record.id));
  const morphs = ringIds.size === 0 ? [] : (await db.morphs.where('ringId').anyOf([...ringIds]).toArray());
  const openSessions = sessions.filter((session) => !session.closed);

  return {
    keep,
    source,
    sessions,
    rings,
    morphs,
    openSessions,
    blocked: openSessions.length > 0,
  };
}

/**
 * 确认并档：一个可写事务内完成
 *   1. 批次 / 环志的 siteId 改挂保留点，并固化原鸟点名称坐标快照；
 *   2. 量度经 ringId 随环志一并归属（数量参与核对，不直接改字段）；
 *   3. 删除待并点。
 * 任一步失败由 Dexie/IndexedDB 自动回滚，两边档案均保持并档前状态。
 */
export async function mergeSites(keepId: string, sourceId: string): Promise<MergeResult> {
  const preview = await previewMergeSites(keepId, sourceId);
  if (preview.blocked) {
    throw new Error(`待并点还有 ${preview.openSessions.length} 个进行中的批次，请先关闭后再并档`);
  }

  const snapshot = snapshotOf(preview.source);

  return db.transaction('rw', db.sites, db.sessions, db.rings, db.morphs, async () => {
    // 事务内按主键复核，避免预览之后数据被改动
    const source = await db.sites.get(sourceId);
    const keep = await db.sites.get(keepId);
    if (!source || !keep) throw new Error('鸟点已发生变化，请刷新后重试');

    const migratedSessions = await db.sessions.where('siteId').equals(sourceId).toArray();
    const migratedRings = await db.rings.where('siteId').equals(sourceId).toArray();
    // 进行中批次可能在预览之后才产生，事务内再拦一次
    const openCount = migratedSessions.filter((session) => !session.closed).length;
    if (openCount > 0) throw new Error(`待并点还有 ${openCount} 个进行中的批次，请先关闭后再并档`);

    migratedSessions.forEach((session) => {
      session.siteId = keepId;
      // 已固化过快照的（理论上不会再挂在待并点）保留最早的原鸟点信息
      if (!session.originSite) session.originSite = { ...snapshot };
    });
    migratedRings.forEach((record) => {
      record.siteId = keepId;
      if (!record.originSite) record.originSite = { ...snapshot };
    });
    await Promise.all([db.sessions.bulkPut(migratedSessions), db.rings.bulkPut(migratedRings)]);

    const ringIds = migratedRings.map((record) => record.id);
    const morphCount = ringIds.length === 0 ? 0 : await db.morphs.where('ringId').anyOf(ringIds).count();

    await db.sites.delete(sourceId);

    // 回读校验：待并点不应再残留任何归属记录，否则抛错触发整事务回滚
    const [leftSessions, leftRings, sourceGone] = await Promise.all([
      db.sessions.where('siteId').equals(sourceId).count(),
      db.rings.where('siteId').equals(sourceId).count(),
      db.sites.get(sourceId).then((row) => !row),
    ]);
    if (leftSessions !== 0 || leftRings !== 0 || !sourceGone) {
      throw new Error('并档校验失败，已撤销本次操作');
    }

    return {
      sessionCount: migratedSessions.length,
      ringCount: migratedRings.length,
      morphCount,
    };
  });
}

/** 快照的简短文案：原鸟点编号 · 名称（坐标），供环志历史等处展示 */
export function formatOriginSite(snapshot: SiteSnapshot): string {
  return `${snapshot.siteNo} · ${snapshot.name}（${snapshot.lng}°E, ${snapshot.lat}°N）`;
}
