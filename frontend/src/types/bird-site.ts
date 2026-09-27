/** 生境类型 */
export type Habitat = '芦苇湿地' | '滩涂' | '次生林' | '农田' | '城市绿地';

/**
 * 鸟点历史快照：并档时随迁入记录固化下来的原鸟点信息。
 * 调整保留点的名称 / 坐标不会回写这些快照，历史记录始终显示并档当时的原鸟点。
 */
export interface SiteSnapshot {
  /** 原点位编号 */
  siteNo: string;
  /** 原点位名称 */
  name: string;
  /** 原经度 */
  lng: number;
  /** 原纬度 */
  lat: number;
}

/** 鸟点 */
export interface BirdSite {
  id: string;
  /** 点位编号 */
  siteNo: string;
  /** 点位名称 */
  name: string;
  /** 经度 */
  lng: number;
  /** 纬度 */
  lat: number;
  /** 生境 */
  habitat: Habitat;
  /** 网位数 */
  netCount: number;
  /** 备注 */
  note?: string;
}

export const HABITATS: Habitat[] = ['芦苇湿地', '滩涂', '次生林', '农田', '城市绿地'];

/** 生境配色（地图标记与 SVG 网格共用） */
export const HABITAT_COLOR: Record<Habitat, string> = {
  芦苇湿地: '#2f7d6f',
  滩涂: '#c8a165',
  次生林: '#3f6b3a',
  农田: '#a3b565',
  城市绿地: '#7f8fa6',
};

/** 地图/网格模式 */
export type MapMode = 'amap' | 'grid';

/** 默认经纬度范围（渤海湾南岸环志区），用于 SVG 网格视图 */
export const DEFAULT_BOUNDS = {
  minLng: 117.4,
  maxLng: 118.4,
  minLat: 38.6,
  maxLat: 39.4,
};

/** SVG 网格行列数 */
export const GRID_COLS = 8;
export const GRID_ROWS = 6;
