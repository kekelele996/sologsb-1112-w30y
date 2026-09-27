import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import type { BirdSite, Habitat, MapMode, SiteSnapshot } from '../types/bird-site';
import type { RingRecord } from '../types/ring-record';
import type { SurveySession } from '../types/session';
import { useRingStore } from './ringStore';
import { useSessionStore } from './sessionStore';

export interface SiteInput {
  siteNo: string;
  name: string;
  lng: number;
  lat: number;
  habitat: Habitat;
  netCount: number;
  note?: string;
}

interface SiteState {
  sites: BirdSite[];
  /** 地图模式：amap（有 key 时）/ grid（退化 SVG 网格） */
  mapMode: MapMode;
  hydrated: boolean;
}

/** 鸟点与地图/网格模式 */
export const useSiteStore = defineStore('site', {
  state: (): SiteState => ({ sites: [], mapMode: 'grid', hydrated: false }),

  getters: {
    siteName(state) {
      return (siteId: string): string => state.sites.find((site) => site.id === siteId)?.name ?? '未知鸟点';
    },
    siteOptions(state): Array<{ label: string; value: string }> {
      return state.sites.map((site) => ({ label: `${site.siteNo} · ${site.name}`, value: site.id }));
    },
    totalNets(state): number {
      return state.sites.reduce((sum, site) => sum + site.netCount, 0);
    },
  },

  actions: {
    async hydrate() {
      this.sites = await db.sites.orderBy('siteNo').toArray();
      this.hydrated = true;
    },

    setMapMode(mode: MapMode) {
      this.mapMode = mode;
    },

    async addSite(input: SiteInput): Promise<BirdSite> {
      const site: BirdSite = {
        id: uid('site'),
        siteNo: input.siteNo.trim(),
        name: input.name.trim(),
        lng: Number(input.lng) || 0,
        lat: Number(input.lat) || 0,
        habitat: input.habitat,
        netCount: Number(input.netCount) || 0,
        note: input.note?.trim() || undefined,
      };
      await db.sites.put(toPlain(site));
      this.sites = [...this.sites, site].sort((a, b) => a.siteNo.localeCompare(b.siteNo));
      return site;
    },

    async updateSite(id: string, patch: Partial<SiteInput>) {
      const current = this.sites.find((site) => site.id === id);
      if (!current) return;
      const next: BirdSite = { ...current, ...patch };
      await db.sites.put(toPlain(next));
      this.sites = this.sites.map((site) => (site.id === id ? next : site));
    },

    async removeSite(id: string) {
      await db.sites.delete(id);
      this.sites = this.sites.filter((site) => site.id !== id);
    },

    /**
     * 并档：把待并点（sourceId）的批次与环志记录迁入保留点（keepId），随后移除待并点。
     * - 待并点存在进行中的批次时抛错拦截，不改动任何数据；
     * - 迁入的批次 / 环志记录写入原鸟点名称与坐标快照（originSite），之后调整保留点不影响快照；
     * - 全部写库操作放在同一个 Dexie 事务里，中途失败整体回滚，两边档案都不变；
     *   事务提交成功后才更新 Pinia 内存状态。
     */
    async mergeSites(keepId: string, sourceId: string): Promise<{ sessions: number; rings: number }> {
      const keep = this.sites.find((site) => site.id === keepId);
      const source = this.sites.find((site) => site.id === sourceId);
      if (!keep || !source) throw new Error('保留点或待并点不存在，请刷新后重试');
      if (keep.id === source.id) throw new Error('保留点与待并点不能是同一个鸟点');

      const sessionStore = useSessionStore();
      const ringStore = useRingStore();

      const movingSessions = sessionStore.sessions.filter((session) => session.siteId === sourceId);
      const openSessions = movingSessions.filter((session) => !session.closed);
      if (openSessions.length > 0) {
        const nos = openSessions.map((session) => session.sessionNo).join('、');
        throw new Error(`待并点还有 ${openSessions.length} 个进行中的批次（${nos}），请先关闭批次再并档`);
      }
      const movingRings = ringStore.rings.filter((record) => record.siteId === sourceId);

      const snapshot: SiteSnapshot = {
        siteId: source.id,
        siteNo: source.siteNo,
        name: source.name,
        lng: source.lng,
        lat: source.lat,
      };
      // 已带快照的记录（更早一次并档迁入的）保留最初的原始鸟点，不被本次覆盖
      const nextSessions: SurveySession[] = movingSessions.map((session) => ({
        ...session,
        siteId: keepId,
        originSite: session.originSite ?? snapshot,
      }));
      const nextRings: RingRecord[] = movingRings.map((record) => ({
        ...record,
        siteId: keepId,
        originSite: record.originSite ?? snapshot,
      }));

      await db.transaction('rw', db.sessions, db.rings, db.sites, async () => {
        if (nextSessions.length > 0) await db.sessions.bulkPut(toPlain(nextSessions));
        if (nextRings.length > 0) await db.rings.bulkPut(toPlain(nextRings));
        await db.sites.delete(sourceId);
      });

      const sessionById = new Map(nextSessions.map((session) => [session.id, session]));
      const ringById = new Map(nextRings.map((record) => [record.id, record]));
      sessionStore.sessions = sessionStore.sessions.map((session) => sessionById.get(session.id) ?? session);
      ringStore.rings = ringStore.rings.map((record) => ringById.get(record.id) ?? record);
      this.sites = this.sites.filter((site) => site.id !== sourceId);

      return { sessions: nextSessions.length, rings: nextRings.length };
    },
  },
});
